const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Required for CLI and cross-origin P2P signaling
    methods: ["GET", "POST"]
  }
});
const PORT = process.env.PORT || 3000;

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use(limiter);

const rooms = new Map();

const WORDS = [
  'TIGER', 'WOLF',  'EAGLE', 'SHARK', 'COBRA',
  'PANDA', 'FALCON','RAVEN', 'VIPER', 'LYNX',
  'BISON', 'CRANE', 'MOOSE', 'OTTER', 'GECKO',
  'HYENA', 'JAGUAR','KITE',  'ORYX',  'SWIFT',
];

function generateRoomCode() {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num  = String(Math.floor(Math.random() * 900) + 100);
  return `${word}-${num}`;
}

app.use(express.static(path.join(__dirname, '..', 'client')));

io.on('connection', (socket) => {
  console.log(`[+] Connected:    ${socket.id}`);

  socket.on('create-room', ({ password } = {}) => {
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    
    rooms.set(code, { 
      creator: socket.id, 
      joiner: null,
      password: password || null // Optional password protection
    });
    
    socket.join(code);
    console.log(`[room] Created: ${code} | creator: ${socket.id} | protected: ${!!password}`);
    socket.emit('room-created', { code });
  });

  socket.on('join-room', ({ code, password }) => {
    // Basic sanitization
    if (typeof code !== 'string') return;
    code = code.trim().toUpperCase();

    const room = rooms.get(code);
    if (!room) {
      socket.emit('join-error', { message: `Room "${code}" does not exist.` });
      return;
    }
    
    if (room.joiner) {
      socket.emit('join-error', { message: `Room "${code}" is already full.` });
      return;
    }

    // Password check
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

  // Simplified P2P signaling relay
  socket.on('signal', ({ code, data }) => {
    const room = rooms.get(code);
    if (!room) return;
    const target = socket.id === room.creator ? room.joiner : room.creator;
    if (target) io.to(target).emit('signal', { data });
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      if (room.creator === socket.id) {
        if (room.joiner) io.to(room.joiner).emit('peer-left');
        rooms.delete(code);
        console.log(`[room] Deleted: ${code} (creator left)`);
      } else if (room.joiner === socket.id) {
        io.to(room.creator).emit('peer-left');
        rooms.delete(code);
        console.log(`[room] Deleted: ${code} (joiner left)`);
      }
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Filedrop server running on http://localhost:${PORT}`);
});
