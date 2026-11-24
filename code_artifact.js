const http = require('http');
const fs = require('fs');
const path = require('path');

// Налаштування порту та шляхів до файлів
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const HTML_FILE = path.join(__dirname, 'index.html');
const DATA_FILE = path.join(__dirname, 'rooms-data.json');

// Зберігання стану кімнат у пам'яті та на диску
let roomsStore = {};
const sseClientsByRoom = new Map();

function loadRoomsFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        roomsStore = parsed;
      }
    }
  } catch (err) {
    console.error('Помилка читання rooms-data.json:', err.message);
    roomsStore = {};
  }
}

function saveRoomsToDisk() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(roomsStore, null, 2), 'utf8');
  } catch (err) {
    console.error('Помилка збереження rooms-data.json:', err.message);
  }
}

function sanitizeRoomCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
}

function broadcastRoomUpdate(roomId, payload) {
  const clients = sseClientsByRoom.get(roomId);
  if (!clients || clients.size === 0) return;

  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(message);
    } catch (e) {
      clients.delete(res);
    }
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      // Захист від надто великих тіл запиту (до 15 МБ через фото профілів)
      if (body.length > 15 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

loadRoomsFromDisk();

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // 1. Потік подій у реальному часі (Server-Sent Events) для синхронізації двох клієнтів
  if (req.method === 'GET' && pathname === '/api/events') {
    const roomId = sanitizeRoomCode(reqUrl.searchParams.get('room'));
    if (!roomId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid room code' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });

    if (!sseClientsByRoom.has(roomId)) {
      sseClientsByRoom.set(roomId, new Set());
    }
    sseClientsByRoom.get(roomId).add(res);

    // Одразу відправляємо поточний стан кімнати, якщо він уже є на сервері
    if (roomsStore[roomId]) {
      res.write(`data: ${JSON.stringify(roomsStore[roomId])}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ roomId, empty: true })}\n\n`);
    }

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (e) {
        clearInterval(keepAlive);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      const roomClients = sseClientsByRoom.get(roomId);
      if (roomClients) {
        roomClients.delete(res);
        if (roomClients.size === 0) {
          sseClientsByRoom.delete(roomId);
        }
      }
    });
    return;
  }

  // 2. Отримання стану кімнати
  if (req.method === 'GET' && pathname === '/api/room') {
    const roomId = sanitizeRoomCode(reqUrl.searchParams.get('room'));
    if (!roomId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid room code' }));
      return;
    }

    const roomData = roomsStore[roomId] || null;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ exists: Boolean(roomData), data: roomData }));
    return;
  }

  // 3. Збереження / оновлення стану кімнати та розсилка другому учаснику
  if (req.method === 'POST' && pathname === '/api/room') {
    try {
      const body = await parseJsonBody(req);
      const roomId = sanitizeRoomCode(body.roomId);
      if (!roomId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Room code is required' }));
        return;
      }

      const existing = roomsStore[roomId] || {};
      const nextState = {
        roomId,
        user1: body.user1 !== undefined ? body.user1 : existing.user1 || null,
        user2: body.user2 !== undefined ? body.user2 : existing.user2 || null,
        tasks: Array.isArray(body.tasks) ? body.tasks : (existing.tasks || []),
        lastWeekKey: body.lastWeekKey || existing.lastWeekKey || null,
        updatedAt: Date.now()
      };

      roomsStore[roomId] = nextState;
      saveRoomsToDisk();
      broadcastRoomUpdate(roomId, nextState);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, updatedAt: nextState.updatedAt }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 4. Віддача самого сайту (index.html)
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(HTML_FILE, 'utf8', (err, htmlContent) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Не вдалося знайти index.html поруч із server.js');
        return;
      }
      // Видаляємо можливий UTF-8 BOM та зайві markdown-огортки
      const cleanHtml = String(htmlContent || '')
        .replace(/^\uFEFF/, '')
        .replace(/^```(?:html)?\s*\r?\n/i, '')
        .replace(/\r?\n```\s*$/i, '');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(cleanHtml);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`Сервер запущено: http://localhost:${PORT}`);
});