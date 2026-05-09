const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const rateLimit = require('express-rate-limit');
const {
  sanitizeRoomCode,
  buildRtcConfigFromEnv
} = require('../protocol/messages');

const app    = express();
const ALLOWED_ORIGINS = (process.env.FILEDROP_ALLOWED_ORIGINS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

// Render commonly provides this; use it as safe default when no explicit allowlist.
const DEFAULT_PUBLIC_ORIGIN =
  process.env.PUBLIC_ORIGIN
  || process.env.RENDER_EXTERNAL_URL
  || '';

function isOriginAllowed(origin) {
  // Non-browser clients (no Origin) like the CLI should still work.
  if (!origin) return true;

  const normalized = String(origin).trim();

  // Explicit allowlist wins.
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(normalized);

  // Safe default: same Render public URL only (if known).
  if (DEFAULT_PUBLIC_ORIGIN) return normalized === DEFAULT_PUBLIC_ORIGIN;

  // Last resort: allow (keeps local dev working if no envs are set).
  return true;
}
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const RTC_CONFIG = buildRtcConfigFromEnv(process.env);

// ── Rate limiting ── only on non-socket routes so polling transport isn't blocked
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again after 15 minutes',
  skip: (req) => req.path.startsWith('/socket.io') // never rate-limit WS upgrade / polling
});
app.use(limiter);

// ── Basic security headers (no need for full helmet dependency) ──
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
  next();
});

// ── Room state ──
const rooms = new Map();

// Room TTL: remove rooms that have been idle (no joiner) for > 30 minutes
const ROOM_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (!room.joiner && (now - room.createdAt) > ROOM_TTL_MS) {
      rooms.delete(code);
      console.log(`[room] TTL expired: ${code}`);
    }
  }
}, 5 * 60 * 1000);

const WORDS = [
  'TIGER', 'WOLF',  'EAGLE', 'SHARK', 'COBRA',
  'PANDA', 'FALCON','RAVEN', 'VIPER', 'LYNX',
  'BISON', 'CRANE', 'MOOSE', 'OTTER', 'GECKO',
  'HYENA', 'JAGUAR','KITE',  'ORYX',  'SWIFT',
  'DINGO', 'FINCH', 'GECKO', 'IBIS',  'JACKAL',
];

function generateRoomCode() {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num  = String(Math.floor(Math.random() * 900) + 100);
  return `${word}-${num}`;
}

// ── Static files ──
app.get('/config.js', (req, res) => {
  const clientConfig = {
    rtcConfig: RTC_CONFIG
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`window.__FILEDROP_CONFIG__ = ${JSON.stringify(clientConfig)};`);
});
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});
app.use('/protocol', express.static(path.join(__dirname, '..', 'protocol')));
app.use(express.static(path.join(__dirname, '..', 'client')));

// ── 404 fallback for unknown routes ──
app.use((req, res) => {
  res.status(404).send('Not found');
});

// ── Socket.IO ──
io.on('connection', (socket) => {
  console.log(`[+] Connected:    ${socket.id}`);

  // ── Create Room ──────────────────────────────────────────────────────────────
  socket.on('create-room', ({ password } = {}) => {
    if (password && (typeof password !== 'string' || password.length > 128)) {
      socket.emit('join-error', { message: 'Invalid room password format.' });
      return;
    }

    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));

    rooms.set(code, {
      creator:   socket.id,
      joiner:    null,
      password:  password || null,
      createdAt: Date.now()
    });

    socket.join(code);
    console.log(`[room] Created: ${code} | creator: ${socket.id} | protected: ${!!password}`);
    socket.emit('room-created', { code });
  });

  // ── Join Room ─────────────────────────────────────────────────────────────────
  socket.on('join-room', ({ code, password }) => {
    code = sanitizeRoomCode(code);
    if (!code || code.length > 32) {
      socket.emit('join-error', { message: 'Invalid room code.' });
      return;
    }

    if (password && (typeof password !== 'string' || password.length > 128)) {
      socket.emit('join-error', { message: 'Invalid room password format.' });
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      socket.emit('join-error', { message: `Room "${code}" does not exist.` });
      return;
    }

    if (room.joiner) {
      socket.emit('join-error', { message: `Room "${code}" is already full.` });
      return;
    }

    if (room.password && room.password !== password) {
      socket.emit('join-error', { message: `Incorrect password for room "${code}".`, type: 'auth' });
      return;
    }

    room.joiner = socket.id;
    socket.join(code);
    console.log(`[room] Joined:  ${code} | joiner: ${socket.id}`);
    io.to(room.creator).emit('room-ready', { code, role: 'creator' });
    socket.emit('room-ready', { code, role: 'joiner' });
  });

  // ── P2P Signal Relay ─────────────────────────────────────────────────────────
  socket.on('signal', ({ code, data }) => {
    code = sanitizeRoomCode(code);
    if (!code) return;
    if (!data || typeof data !== 'object') return;
    const room = rooms.get(code);
    if (!room) return;
    const target = socket.id === room.creator ? room.joiner : room.creator;
    if (target) io.to(target).emit('signal', { data });
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      if (room.creator === socket.id) {
        // Creator left — whole room is gone
        if (room.joiner) io.to(room.joiner).emit('peer-left');
        rooms.delete(code);
        console.log(`[room] Deleted: ${code} (creator left)`);

      } else if (room.joiner === socket.id) {
        // Joiner left — keep room alive so creator can share code with someone else
        io.to(room.creator).emit('peer-left');
        room.joiner = null;   // ← FIX: reset slot instead of deleting the room
        console.log(`[room] Joiner left: ${code} — room kept alive for creator`);
      }
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Filedrop server running on http://localhost:${PORT}`);
});
