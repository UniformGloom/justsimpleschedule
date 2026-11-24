const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const HTML_FILE = path.join(__dirname, 'index.html');
const DATA_FILE = path.join(__dirname, 'rooms-data.json');
const USERS_FILE = path.join(__dirname, 'users-data.json');

let roomsStore = {};
let usersStore = {};
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

function loadUsersFromDisk() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        usersStore = parsed;
      }
    }
  } catch (err) {
    console.error('Помилка читання users-data.json:', err.message);
    usersStore = {};
  }
}

function saveUsersToDisk() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersStore, null, 2), 'utf8');
  } catch (err) {
    console.error('Помилка збереження users-data.json:', err.message);
  }
}

function sanitizeUsername(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґ._-]/gi, '')
    .slice(0, 32);
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function generateRoomCodeServer() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 10; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
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
loadUsersFromDisk();

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

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

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    try {
      const body = await parseJsonBody(req);
      const username = sanitizeUsername(body.username);
      const password = String(body.password || '');
      const displayName = String(body.displayName || '').trim() || username;
      const countryId = String(body.countryId || 'ua').trim() || 'ua';
      const avatar = typeof body.avatar === 'string' ? body.avatar : '';
      const mode = body.mode === 'join' ? 'join' : 'create';
      const requestedRoom = sanitizeRoomCode(body.roomId);

      if (username.length < 3) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Логін має містити щонайменше 3 символи' }));
        return;
      }
      if (password.length < 4) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Пароль має містити щонайменше 4 символи' }));
        return;
      }
      if (usersStore[username]) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Цей логін уже зайнятий. Оберіть інший або увійдіть' }));
        return;
      }

      let assignedRoomId = '';
      let assignedRole = 1;

      if (mode === 'join') {
        if (requestedRoom.length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Введіть коректний код кімнати для приєднання' }));
          return;
        }
        assignedRoomId = requestedRoom;
        assignedRole = 2;

        const existingRoom = roomsStore[assignedRoomId] || {
          roomId: assignedRoomId,
          user1: { name: 'К1', countryId: 'ua', avatar: '', joined: false },
          user2: { name: '', countryId, avatar: '', joined: false },
          tasks: [],
          updatedAt: Date.now()
        };
        existingRoom.user2 = {
          name: displayName,
          countryId,
          avatar: avatar || (existingRoom.user2 && existingRoom.user2.avatar) || '',
          joined: true
        };
        existingRoom.updatedAt = Date.now();
        roomsStore[assignedRoomId] = existingRoom;
        saveRoomsToDisk();
        broadcastRoomUpdate(assignedRoomId, existingRoom);
      } else {
        assignedRoomId = requestedRoom.length >= 4 ? requestedRoom : generateRoomCodeServer();
        assignedRole = 1;
        const newRoom = {
          roomId: assignedRoomId,
          user1: { name: displayName, countryId, avatar, joined: true },
          user2: { name: '', countryId: countryId === 'cy' ? 'ua' : 'cy', avatar: '', joined: false },
          tasks: [],
          updatedAt: Date.now()
        };
        roomsStore[assignedRoomId] = newRoom;
        saveRoomsToDisk();
      }

      const { salt, hash } = hashPassword(password);
      usersStore[username] = {
        username,
        displayName,
        countryId,
        avatar,
        roomId: assignedRoomId,
        role: assignedRole,
        salt,
        hash,
        createdAt: Date.now()
      };
      saveUsersToDisk();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        account: {
          username,
          displayName,
          countryId,
          roomId: assignedRoomId,
          role: assignedRole
        },
        roomData: roomsStore[assignedRoomId] || null
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    try {
      const body = await parseJsonBody(req);
      const username = sanitizeUsername(body.username);
      const password = String(body.password || '');
      const userRecord = usersStore[username];

      if (!userRecord || !verifyPassword(password, userRecord.salt, userRecord.hash)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Невірний логін або пароль' }));
        return;
      }

      const assignedRoomId = sanitizeRoomCode(userRecord.roomId);
      const assignedRole = userRecord.role === 2 ? 2 : 1;

      if (assignedRoomId && !roomsStore[assignedRoomId]) {
        roomsStore[assignedRoomId] = {
          roomId: assignedRoomId,
          user1: assignedRole === 1
            ? { name: userRecord.displayName, countryId: userRecord.countryId || 'ua', avatar: userRecord.avatar || '', joined: true }
            : { name: 'К1', countryId: 'ua', avatar: '', joined: false },
          user2: assignedRole === 2
            ? { name: userRecord.displayName, countryId: userRecord.countryId || 'cy', avatar: userRecord.avatar || '', joined: true }
            : { name: '', countryId: 'cy', avatar: '', joined: false },
          tasks: [],
          updatedAt: Date.now()
        };
        saveRoomsToDisk();
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        account: {
          username: userRecord.username,
          displayName: userRecord.displayName,
          countryId: userRecord.countryId,
          roomId: assignedRoomId,
          role: assignedRole
        },
        roomData: roomsStore[assignedRoomId] || null
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

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

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(HTML_FILE, 'utf8', (err, htmlContent) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Не вдалося знайти index.html поруч із server.js');
        return;
      }
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