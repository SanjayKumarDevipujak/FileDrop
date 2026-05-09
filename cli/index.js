#!/usr/bin/env node
const { program } = require('commander');
const io = require('socket.io-client');
let chalk = require('chalk');
let boxen = require('boxen');

// Handle ESM-to-CJS default export wrapping in newer Node versions
if (chalk.default) chalk = chalk.default;
if (boxen.default) boxen = boxen.default;

const qrcode      = require('qrcode-terminal');
const cliProgress = require('cli-progress');
const fs          = require('fs-extra');
const path        = require('path');
const Peer        = require('simple-peer');
const wrtc        = require('@koush/wrtc');
const readline    = require('readline');
const crypto      = require('crypto');
const {
  TYPES,
  sanitizeRoomCode,
  parseJsonMessage,
  isFileMetaMessage,
  isFileHashMessage,
  isTransferAcceptedMessage,
  isTransferRejectedMessage,
  isTransferProgressMessage,
  buildRtcConfigFromEnv
} = require('../protocol/messages');

const SERVER_URL         = process.env.SIGNALING_SERVER || 'https://filedrop-om51.onrender.com';
const CHUNK_SIZE         = 262144;   // 256 KB
const MAX_BUFFERED_AMOUNT = 16777216; // 16 MB high-water mark
const MIN_BUFFERED_AMOUNT =  4194304; //  4 MB resume threshold

const RTC_CONFIG = buildRtcConfigFromEnv(process.env);

// ── Logging ──────────────────────────────────────────────────────────────────
function debug(msg, type = 'info') {
  const t = new Date().toLocaleTimeString([], { hour12: false });
  const prefix = chalk.gray(`[${t}] `);
  let content = msg;
  if (type === 'error')   content = chalk.red('✖ ' + msg);
  if (type === 'success') content = chalk.green('✔ ' + msg);
  if (type === 'warn')    content = chalk.yellow('⚠ ' + msg);
  if (type === 'signal')  content = chalk.magenta('⇄ ' + msg);
  console.log(prefix + content);
}

function sanitizeFilename(name) {
  return name.replace(/[\\\/]/g, '_').replace(/[<>:"|?*]/g, '');
}

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
}

// ── CLI definition ───────────────────────────────────────────────────────────
program
  .name('filedrop')
  .description('P2P file sharing from your terminal')
  .version('1.0.0');

// ════════════════════════════════════════════════════════════════════════════
//  SEND
// ════════════════════════════════════════════════════════════════════════════
program
  .command('send')
  .description('Send a file from your terminal')
  .argument('<path>', 'Path to the file you want to send')
  .action(async (filePath) => {
    if (!await fs.pathExists(filePath)) {
      debug(`File does not exist: ${filePath}`, 'error');
      process.exit(1);
    }

    const stats    = await fs.stat(filePath);
    const fileName = path.basename(filePath);
    const fileSize = stats.size;

    debug(`Sending: "${fileName}" (${(fileSize / 1048576).toFixed(2)} MB)`, 'info');
    console.log(boxen(chalk.bold.cyan('Filedrop CLI — Sending Mode'), { padding: 1, margin: 1, borderStyle: 'round' }));

    const socket = io(SERVER_URL, { reconnectionAttempts: 5 });
    let peer = null;
    let ackedBytes = 0;
    let progressBar = null;
    let startTime = 0;
    let senderHashHex = null;

    // ── Top-level signal relay — never duplicated ─────────────────────────────
    socket.on('signal', ({ data }) => {
      if (peer) {
        debug(`Received signal: ${data.type || 'ice'}`, 'signal');
        peer.signal(data);
      }
    });

    socket.on('connect', () => {
      debug(`Connected to server (${socket.id})`, 'success');
      socket.emit('create-room');
    });

    socket.on('room-created', ({ code }) => {
      debug(`Room created: ${chalk.bold(code)}`, 'success');
      console.log(chalk.gray('\nShare code: ') + chalk.white.bold(`filedrop receive ${code}`));
      const joinUrl = `${SERVER_URL}/?code=${code}`;
      console.log(chalk.gray('Or scan QR to open in browser:'));
      qrcode.generate(joinUrl, { small: true });
      debug('Waiting for peer to join…', 'info');
    });

    socket.on('room-ready', () => {
      debug('Peer detected. Initializing WebRTC…', 'info');

      peer = new Peer({ initiator: true, trickle: true, wrtc, config: RTC_CONFIG });

      peer.on('signal', data => {
        debug(`Generated signal: ${data.type || 'ice'}`, 'signal');
        socket.emit('signal', { code: socket._roomCode, data });
      });

      // Store room code when room-ready fires — we need it for signal relay
      // We attach it to socket for convenience (already available in closure below)

      peer.on('connect', () => {
        debug('P2P Data Channel is OPEN ✔', 'success');
        debug(`Sending file-meta for: "${fileName}"`, 'info');
        peer.send(JSON.stringify({ type: TYPES.FILE_META, name: fileName, size: fileSize }));
      });

      peer.on('data', data => {
        const payload = parseJsonMessage(data);
        if (!payload) return;

        if (isTransferAcceptedMessage(payload)) {
          debug('Peer accepted. Starting transfer…', 'success');
          startSending();
        } else if (isTransferRejectedMessage(payload)) {
          debug('Peer rejected the transfer.', 'error');
          process.exit(0);
        } else if (isTransferProgressMessage(payload)) {
          ackedBytes = payload.received;
          if (progressBar) {
            const elapsed = (Date.now() - startTime) / 1000 || 0.001;
            const speed   = (ackedBytes / 1048576 / elapsed).toFixed(2) + ' MB/s';
            progressBar.update(Math.ceil(ackedBytes / CHUNK_SIZE), { speed });
          }
        } else if (isFileHashMessage(payload)) {
          senderHashHex = payload.hash;
          debug(`Receiver verified hash: ${payload.algo} ${payload.hash.slice(0, 12)}…`, 'success');
        }
      });

      peer.on('error', err => {
        debug(`WebRTC error: ${err.message}`, 'error');
        if (err.code === 'ERR_ICE_CONNECTION_FAILURE') {
          debug('NAT/firewall issue — try both devices on the same Wi-Fi.', 'warn');
        }
      });

      peer.on('close', () => debug('P2P connection closed.', 'warn'));
    });

    // Capture room code after creation for signal relay
    socket.on('room-created', ({ code }) => { socket._roomCode = code; });

    socket.on('disconnect', () => debug('Signaling server disconnected.', 'warn'));
    socket.on('connect_error', (err) => debug(`Connection error: ${err.message}`, 'error'));

    // ── Stream-based file sender (async I/O, no blocking) ─────────────────────
    function startSending() {
      const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
      progressBar = new cliProgress.SingleBar({
        format: 'Sending |' + chalk.cyan('{bar}') + '| {percentage}% | {value}/{total} chunks | {speed}',
        barCompleteChar: '\u2588', barIncompleteChar: '\u2591', hideCursor: true
      }, cliProgress.Presets.shades_classic);

      progressBar.start(totalChunks, 0, { speed: '0 MB/s' });

      const readStream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
      const hash = crypto.createHash('sha256');
      let offset    = 0;
      startTime = Date.now();
      let paused    = false;

      const getBuffered = () => (peer && peer._channel ? peer._channel.bufferedAmount : 0);

      readStream.on('data', (chunk) => {
        if (!peer) { readStream.destroy(); return; }

        hash.update(chunk);

        // Back-pressure: pause stream if send buffer is filling up
        if (getBuffered() > MAX_BUFFERED_AMOUNT) {
          readStream.pause();
          paused = true;
          const drain = setInterval(() => {
            if (getBuffered() < MIN_BUFFERED_AMOUNT) {
              clearInterval(drain);
              paused = false;
              readStream.resume();
            }
          }, 10);
        }

        peer.send(chunk);
        offset += chunk.length;
      });

      readStream.on('end', () => {
        const localHashHex = hash.digest('hex');

        // Wait for send buffer to fully drain before announcing completion
        const waitDrain = setInterval(() => {
          if (getBuffered() === 0) {
            clearInterval(waitDrain);
            progressBar.stop();
            // Tell receiver expected hash (receiver will verify and reply back).
            try {
              peer.send(JSON.stringify({ type: TYPES.FILE_HASH, algo: 'sha256', hash: localHashHex }));
            } catch {}

            debug(`Transfer complete! Sent ${fileSize} bytes.`, 'success');
            debug(`SHA-256: ${localHashHex}`, 'info');
            setTimeout(() => process.exit(0), 1000);
          }
        }, 100);
      });

      readStream.on('error', err => {
        progressBar.stop();
        debug(`File read error: ${err.message}`, 'error');
        process.exit(1);
      });
    }
  });

// ════════════════════════════════════════════════════════════════════════════
//  RECEIVE
// ════════════════════════════════════════════════════════════════════════════
program
  .command('receive')
  .description('Receive a file in your terminal')
  .argument('<code>', 'The room code')
  .action((code) => {
    code = sanitizeRoomCode(code);
    console.log(boxen(chalk.bold.green('Filedrop CLI — Receiving Mode'), { padding: 1, margin: 1, borderStyle: 'round' }));

    const socket = io(SERVER_URL, { reconnectionAttempts: 5 });
    let peer        = null;
    let fileMeta    = null;
    let receivedSize = 0;
    let writeStream = null;
    let progressBar = null;
    let startTime   = 0;
    let lastProgressSentAt = 0;
    let hash = null;
    let expectedHashHex = null;
    let localHashHex = null;
    let hashVerified = false;

    // ── Top-level signal relay ────────────────────────────────────────────────
    socket.on('signal', ({ data }) => {
      if (peer) {
        debug(`Received signal: ${data.type || 'ice'}`, 'signal');
        peer.signal(data);
      }
    });

    socket.on('connect', () => {
      debug(`Connected to server. Joining room ${code}…`, 'info');
      socket.emit('join-room', { code });
    });

    socket.on('join-error', ({ message }) => {
      debug(`Join error: ${message}`, 'error');
      process.exit(1);
    });

    socket.on('room-ready', () => {
      debug('Room ready. Initializing WebRTC…', 'info');

      peer = new Peer({ initiator: false, trickle: true, wrtc, config: RTC_CONFIG });

      peer.on('signal', data => {
        debug(`Generated signal: ${data.type || 'ice'}`, 'signal');
        socket.emit('signal', { code, data });
      });

      peer.on('connect', () => {
        debug('P2P Data Channel is OPEN ✔', 'success');
        startTime = Date.now();
      });

      peer.on('data', async (data) => {
        // ── Control message (JSON) — only when we haven't accepted a file yet ──
        if (!fileMeta) {
          const payload = parseJsonMessage(data);
          if (!payload) {
            debug('Waiting for file-meta (got non-JSON data)', 'warn');
            return;
          }

          if (!isFileMetaMessage(payload)) return;

          debug(`Incoming file: "${payload.name}" (${(payload.size / 1048576).toFixed(2)} MB)`, 'info');

          console.log('\n' + boxen(
            chalk.bold.yellow('Incoming File Transfer') + '\n\n' +
            chalk.white(`File: ${payload.name}`) + '\n' +
            chalk.white(`Size: ${(payload.size / 1048576).toFixed(2)} MB`),
            { padding: 1, borderStyle: 'double', borderColor: 'yellow' }
          ));

          const answer = await askQuestion(chalk.bold.cyan('Accept this file? (y/n): '));

          if (answer.toLowerCase() !== 'y') {
            debug('Rejecting transfer.', 'warn');
            peer.send(JSON.stringify({ type: TYPES.TRANSFER_REJECTED }));
            process.exit(0);
            return;
          }

          debug('Accepting transfer…', 'success');
          peer.send(JSON.stringify({ type: TYPES.TRANSFER_ACCEPTED }));

          const safeName = sanitizeFilename(payload.name);
          const savePath = path.join(process.cwd(), safeName);
          fileMeta = { ...payload, name: safeName, savePath };

          debug(`Saving to: "${savePath}"`, 'info');
          writeStream = fs.createWriteStream(savePath);
          hash = crypto.createHash('sha256');

          progressBar = new cliProgress.SingleBar({
            format: 'Receiving |' + chalk.green('{bar}') + '| {percentage}% | {value}/{total} chunks | {speed}',
            barCompleteChar: '\u2588', barIncompleteChar: '\u2591', hideCursor: true
          }, cliProgress.Presets.shades_classic);
          progressBar.start(Math.ceil(fileMeta.size / CHUNK_SIZE), 0, { speed: '0 MB/s' });

        } else {
          // ── Control message (hash) or Binary chunk ─────────────────────────
          const maybeControl = parseJsonMessage(data);
          if (maybeControl && isFileHashMessage(maybeControl)) {
            expectedHashHex = maybeControl.hash;
            if (localHashHex) {
              hashVerified = (expectedHashHex === localHashHex);
              debug(`SHA-256 verified: ${hashVerified ? 'OK' : 'MISMATCH'}`, hashVerified ? 'success' : 'error');
            } else {
              debug('Received expected SHA-256 from sender. Will verify at end…', 'info');
            }
            return;
          }

          writeStream.write(data);
          hash.update(data);
          receivedSize += data.length || data.byteLength || 0;

          // Send receiver-driven progress to keep sender % identical.
          const now = Date.now();
          if (now - lastProgressSentAt > 120) {
            lastProgressSentAt = now;
            try {
              peer.send(JSON.stringify({ type: TYPES.TRANSFER_PROGRESS, received: receivedSize, total: fileMeta.size }));
            } catch {}
          }

          const elapsed = (Date.now() - startTime) / 1000 || 0.001;
          const speed   = (receivedSize / 1048576 / elapsed).toFixed(2) + ' MB/s';
          progressBar.update(Math.ceil(receivedSize / CHUNK_SIZE), { speed });

          if (receivedSize >= fileMeta.size) {
            progressBar.stop();

            // FIX: wait for writeStream to fully flush before stat-checking
            writeStream.end(() => {
              localHashHex = hash.digest('hex');
              if (expectedHashHex) {
                hashVerified = (expectedHashHex === localHashHex);
                debug(`SHA-256 verified: ${hashVerified ? 'OK' : 'MISMATCH'}`, hashVerified ? 'success' : 'error');
              } else {
                debug(`SHA-256 (local): ${localHashHex}`, 'info');
              }

              // Final progress ping to force sender UI to 100%.
              try {
                peer.send(JSON.stringify({ type: TYPES.TRANSFER_PROGRESS, received: fileMeta.size, total: fileMeta.size }));
              } catch {}

              const finalStats = fs.statSync(fileMeta.savePath);
              const ok = finalStats.size === fileMeta.size;
              debug(`Saved: ${fileMeta.name}`, ok ? 'success' : 'error');
              debug(
                `Integrity: expected ${fileMeta.size} bytes | saved ${finalStats.size} bytes`,
                ok ? 'success' : 'error'
              );
              const exitOk = ok && (!expectedHashHex || hashVerified);
              setTimeout(() => process.exit(exitOk ? 0 : 1), 500);
            });
          }
        }
      });

      peer.on('error', err => debug(`WebRTC error: ${err.message}`, 'error'));
      peer.on('close', () => debug('P2P connection closed.', 'warn'));
    });

    socket.on('disconnect', () => debug('Signaling server disconnected.', 'warn'));
    socket.on('connect_error', (err) => debug(`Connection error: ${err.message}`, 'error'));
  });

program.parse();
