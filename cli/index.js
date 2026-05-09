#!/usr/bin/env node
const { program } = require('commander');
const io = require('socket.io-client');
const chalk = require('chalk');
const boxen = require('boxen');
const qrcode = require('qrcode-terminal');
const cliProgress = require('cli-progress');
const fs = require('fs-extra');
const path = require('path');
const Peer = require('simple-peer');
const wrtc = require('@koush/wrtc');
const crypto = require('crypto');
const readline = require('readline');

const SERVER_URL = process.env.SIGNALING_SERVER || 'https://filedrop-om51.onrender.com';
const CHUNK_SIZE = 262144; // 256KB - Ultra-fast throughput
const MAX_BUFFERED_AMOUNT = 67108864; // 64MB - Keep the pipe saturated
const MIN_BUFFERED_AMOUNT = 16777216; // 16MB - Resume threshold
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
};

const E2E_ALGO = 'aes-256-ctr';
const E2E_KEY = crypto.createHash('sha256').update('filedrop-default-key-v2').digest();

// ── VERBOSE LOGGING HELPER ──────────────────────────────────────────────────
function debug(msg, type = 'info') {
  const t = new Date().toLocaleTimeString([], { hour12: false });
  const prefix = chalk.gray(`[${t}] `);
  let content = msg;
  if (type === 'error') content = chalk.red('✖ ' + msg);
  if (type === 'success') content = chalk.green('✔ ' + msg);
  if (type === 'warn') content = chalk.yellow('⚠ ' + msg);
  if (type === 'signal') content = chalk.magenta('⇄ ' + msg);
  console.log(prefix + content);
}

function parseIce(candidate) {
  if (!candidate) return null;
  if (typeof candidate === 'string') return { candidate, sdpMid: '0', sdpMLineIndex: 0 };
  if (candidate.candidate) return candidate;
  const str = candidate.sdp || candidate;
  if (typeof str === 'string') return { candidate: str, sdpMid: candidate.sdpMid || '0', sdpMLineIndex: candidate.sdpMLineIndex || 0 };
  return null;
}

function sanitizeFilename(name) {
  // Preserve spaces, brackets, parentheses. Strip path components and restricted chars.
  return name.replace(/[\\\/]/g, '_').replace(/[<>:"|?*]/g, '');
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

program
  .name('filedrop')
  .description('P2P file sharing from your terminal')
  .version('1.0.0');

program
  .command('send')
  .description('Send a file from your terminal')
  .argument('<path>', 'Path to the file you want to send')
  .action(async (filePath) => {
    if (!await fs.pathExists(filePath)) {
      debug(`File does not exist: ${filePath}`, 'error');
      process.exit(1);
    }

    const stats = await fs.stat(filePath);
    const fileName = path.basename(filePath);
    const fileSize = stats.size;

    debug(`Sender reading file: "${fileName}"`, 'info');
    console.log(boxen(chalk.bold.cyan('Filedrop CLI — Sending Mode'), { padding: 1, margin: 1, borderStyle: 'round' }));
    
    const socket = io(SERVER_URL);
    let peer = null;

    socket.on('connect', () => {
      debug(`Connected to server (${socket.id})`, 'success');
      socket.emit('create-room');
    });

    socket.on('room-created', ({ code }) => {
      debug(`Room created: ${chalk.bold(code)}`, 'success');
      console.log(chalk.gray('Scan QR or use: ') + chalk.white(`filedrop receive ${code}`));
      
      const joinUrl = `${SERVER_URL}/?code=${code}`;
      qrcode.generate(joinUrl, { small: true });
      debug('Waiting for peer to join signaling room...', 'info');
    });

    socket.on('room-ready', ({ code }) => {
      debug('Peer detected in room. Initializing WebRTC...', 'info');
      
      peer = new Peer({ 
        initiator: true, 
        trickle: true, 
        wrtc,
        config: RTC_CONFIG 
      });

      peer.on('signal', data => {
        debug(`Generated signaling ${data.type || 'ice'}`, 'signal');
        socket.emit('signal', { code, data });
      });

      socket.on('signal', ({ data }) => {
        debug(`Received signaling ${data.type || 'ice'} from peer`, 'signal');
        peer.signal(data);
      });

      peer.on('connect', () => {
        debug('P2P Data Channel is OPEN', 'success');
        
        debug(`Sending transfer-request for: "${fileName}"`, 'info');
        peer.send(JSON.stringify({ type: 'file-meta', name: fileName, size: fileSize }));
      });

      peer.on('data', data => {
        let payload;
        try {
          payload = JSON.parse(data.toString());
        } catch (e) { return; }

        if (payload.type === 'transfer-accepted') {
          debug('Peer accepted transfer. Starting stream...', 'success');
          startSending();
        } else if (payload.type === 'transfer-rejected') {
          debug('Peer rejected the transfer.', 'error');
          process.exit(0);
        }
      });

      function startSending() {
        const progressBar = new cliProgress.SingleBar({
          format: 'Sending |' + chalk.cyan('{bar}') + '| {percentage}% | {value}/{total} Chunks | {speed}',
          barCompleteChar: '\u2588', barIncompleteChar: '\u2591', hideCursor: true
        }, cliProgress.Presets.shades_classic);

        progressBar.start(Math.ceil(fileSize / CHUNK_SIZE), 0, { speed: "0 MB/s" });

        const fd = fs.openSync(filePath, 'r');
        let offset = 0;
        let startTime = Date.now();

        const getBufferedAmount = () => (peer._channel ? peer._channel.bufferedAmount : 0);

        function sendChunk() {
          const buffer = Buffer.alloc(CHUNK_SIZE);
          const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, offset);
          
          if (bytesRead > 0) {
            let chunk = bytesRead === CHUNK_SIZE ? buffer : buffer.slice(0, bytesRead);
            
            // Send raw binary chunk (No encryption to ensure byte-for-byte interop)
            peer.send(chunk);
            offset += bytesRead;
            
            const elapsed = (Date.now() - startTime) / 1000;
            const speed = (offset / (1024 * 1024) / elapsed).toFixed(2) + " MB/s";
            progressBar.update(Math.ceil(offset / CHUNK_SIZE), { speed });
            
            if (getBufferedAmount() > MAX_BUFFERED_AMOUNT) {
              // Wait for buffer to drain significantly before resuming
              const checkDrain = setInterval(() => {
                if (getBufferedAmount() < MIN_BUFFERED_AMOUNT) {
                  clearInterval(checkDrain);
                  sendChunk();
                }
              }, 10);
            } else {
              setImmediate(sendChunk);
            }
          } else {
            progressBar.stop();
            fs.closeSync(fd);
            debug(`Transfer complete! Total sent: ${fileSize} bytes`, 'success');
            setTimeout(() => process.exit(0), 1000);
          }
        }
        sendChunk();
      }

      peer.on('error', err => {
        debug(`WebRTC Error: ${err.message}`, 'error');
        if (err.code === 'ERR_ICE_CONNECTION_FAILURE') {
          debug('Connection failed. Likely a firewall/NAT issue. Try both devices on same Wi-Fi.', 'warn');
        }
      });
    });

    socket.on('disconnect', () => debug('Signaling server disconnected', 'warn'));
  });

program
  .command('receive')
  .description('Receive a file in your terminal')
  .argument('<code>', 'The room code')
  .action((code) => {
    code = code.toUpperCase();
    console.log(boxen(chalk.bold.green('Filedrop CLI — Receiving Mode'), { padding: 1, margin: 1, borderStyle: 'round' }));
    
    const socket = io(SERVER_URL);
    let peer = null;
    let fileMeta = null;
    let receivedSize = 0;
    let writeStream = null;
    let progressBar = null;
    let startTime = 0;

    socket.on('connect', () => {
      debug(`Connected to server. Joining ${code}...`, 'info');
      socket.emit('join-room', { code });
    });

    socket.on('join-error', ({ message }) => {
      debug(`Join error: ${message}`, 'error');
      process.exit(1);
    });

    socket.on('room-ready', ({ role }) => {
      debug('Room ready. Initializing WebRTC...', 'info');
      peer = new Peer({ 
        initiator: false, 
        trickle: true, 
        wrtc, 
        config: RTC_CONFIG 
      });

      peer.on('signal', data => {
        debug(`Generated signaling ${data.type || 'ice'}`, 'signal');
        socket.emit('signal', { code, data });
      });

      socket.on('signal', ({ data }) => {
        debug(`Received signaling ${data.type || 'ice'} from peer`, 'signal');
        peer.signal(data);
      });

      peer.on('connect', () => {
        debug('P2P Data Channel is OPEN', 'success');
        startTime = Date.now();
      });

      peer.on('data', async data => {
        const dataType = typeof data;
        const constructorName = data.constructor ? data.constructor.name : 'Unknown';
        const dataSize = data.length || data.byteLength || 0;
        
        // Detailed logging for every incoming message
        // debug(`Incoming: type=${dataType}, constructor=${constructorName}, size=${dataSize}`, 'signal');

        if (!fileMeta) {
          let payload;
          try {
            const str = data.toString();
            payload = JSON.parse(str);
            debug(`Receiver got JSON message: "${str}"`, 'info');
          } catch (e) {
            debug(`Failed to parse JSON from ${constructorName} of size ${dataSize}. Still waiting for file-meta.`, 'warn');
            return;
          }

          if (payload.type === 'file-meta') {
            debug(`Receiver got transfer-request: "${payload.name}"`, 'info');
            
            const safeName = sanitizeFilename(payload.name);
            const sizeMb = (payload.size / (1024 * 1024)).toFixed(2);
            
            console.log('\n' + boxen(
              chalk.bold.yellow('Incoming File Transfer') + '\n\n' +
              chalk.white(`File: ${payload.name}`) + '\n' +
              chalk.white(`Size: ${sizeMb} MB`),
              { padding: 1, borderStyle: 'double', borderColor: 'yellow' }
            ));

            const answer = await askQuestion(chalk.bold.cyan('Accept this file? (y/n): '));
            
            if (answer.toLowerCase() === 'y') {
              debug('Accepting transfer...', 'success');
              peer.send(JSON.stringify({ type: 'transfer-accepted' }));
              
              fileMeta = { ...payload, name: safeName };
              const savePath = path.join(process.cwd(), fileMeta.name);
              debug(`Receiver saving file to: "${savePath}"`, 'info');
              
              writeStream = fs.createWriteStream(savePath);
              progressBar = new cliProgress.SingleBar({
                format: 'Receiving |' + chalk.green('{bar}') + '| {percentage}% | {value}/{total} Chunks | {speed}',
                barCompleteChar: '\u2588', barIncompleteChar: '\u2591', hideCursor: true
              }, cliProgress.Presets.shades_classic);
              progressBar.start(Math.ceil(fileMeta.size / CHUNK_SIZE), 0, { speed: "0 MB/s" });
            } else {
              debug('Rejecting transfer.', 'warn');
              peer.send(JSON.stringify({ type: 'transfer-rejected' }));
              // Keep running or exit? Let's exit for now to match CLI UX
              process.exit(0);
            }
          }
        } else {
          // Write raw binary chunk directly to disk
          writeStream.write(data);
          receivedSize += data.length;
          
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = (receivedSize / (1024 * 1024) / elapsed).toFixed(2) + " MB/s";
          progressBar.update(Math.ceil(receivedSize / CHUNK_SIZE), { speed });

          if (receivedSize >= fileMeta.size) {
            progressBar.stop();
            writeStream.end();
            
            // Verification
            const finalStats = fs.statSync(path.join(process.cwd(), fileMeta.name));
            debug(`Saved to: ${fileMeta.name}`, 'success');
            debug(`Integrity Check: Expected ${fileMeta.size} bytes | Saved ${finalStats.size} bytes`, 
                  finalStats.size === fileMeta.size ? 'success' : 'error');
            
            setTimeout(() => process.exit(0), 1000);
          }
        }
      });

      peer.on('error', err => debug(`WebRTC Error: ${err.message}`, 'error'));
    });
  });

program.parse();
