# 🚀 Filedrop - P2P File Sharing (Web & CLI)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

Filedrop is a high-performance, secure, and decentralized peer-to-peer (P2P) file-sharing platform. It allows users to send and receive files of any size directly between devices—whether via a modern web browser or a powerful terminal interface—using WebRTC.

**No cloud storage. No middleman. Just pure peer-to-peer speed.**

---

## ✨ Features

- **P2P File Transfer**: Direct device-to-device transfers using WebRTC.
- **Cross-Platform**: Seamlessly share files between **CLI to Web**, **Web to CLI**, **Web to Web**, and **CLI to CLI**.
- **Global Connectivity**: Integrated STUN/TURN servers to bridge connections across different networks (even from India to USA!).
- **Security First**: 
  - **End-to-End Encryption**: Data is encrypted before leaving your device.
  - **No Storage**: Files are never uploaded to any server; they stream directly.
- **CLI Tool**: A professional terminal interface for developers and power users.
- **Modern Web UI**: Responsive, beautiful, and easy-to-use interface.
- **Real-time Feedback**: Live progress bars, speed indicators, and connection status logs.

---

## 🛠️ Tech Stack

- **Frontend**: HTML5, CSS3 (Modern UI), JavaScript (ES6+).
- **CLI**: Node.js, `commander`, `simple-peer`, `@koush/wrtc`.
- **Signaling Server**: Node.js, Express, Socket.io.
- **P2P Protocol**: WebRTC via `simple-peer`.

---

## 🚀 Quick Start

### Web Client
Visit your deployed URL (example: [https://filedrop-om51.onrender.com](https://filedrop-om51.onrender.com)).

### CLI Installation
```bash
# Clone the repository
git clone https://github.com/SanjayKumarDevipujak/FileDrop.git
cd FileDrop/cli

# Install and link locally
npm install
npm link
```

### CLI Usage
- **To Send**: `filedrop send "path/to/your/file.zip"`
- **To Receive**: `filedrop receive ROOM-CODE`

### Configuration (Recommended for Production)
Set these environment variables on your server and CLI runtime:

- `SIGNALING_SERVER` (CLI): signaling server base URL.
- `FILEDROP_ALLOWED_ORIGINS` (server): comma-separated allowed web origins for Socket.IO CORS.
- `FILEDROP_STUN_SERVERS`: comma-separated STUN URLs.
- `FILEDROP_TURN_URLS`: comma-separated TURN URLs.
- `FILEDROP_TURN_USERNAME`: TURN username.
- `FILEDROP_TURN_CREDENTIAL`: TURN credential.

Example:
```bash
FILEDROP_ALLOWED_ORIGINS=https://yourdomain.com,http://localhost:3000
FILEDROP_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
FILEDROP_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp
FILEDROP_TURN_USERNAME=your-user
FILEDROP_TURN_CREDENTIAL=your-pass
SIGNALING_SERVER=https://yourdomain.com
```

---

## 🏗️ Project Structure

```text
.
├── cli/            # Node.js CLI tool source code
├── client/         # Web client (HTML/CSS/JS)
├── server/         # Socket.io signaling server
└── README.md       # You are here!
```

---

## 🤝 Contributing

We ❤️ contributions! Whether it's fixing a bug, adding a feature, or improving documentation, your help is welcome.

1. **Fork** the repository.
2. **Create** a new feature branch (`git checkout -b feature/AmazingFeature`).
3. **Commit** your changes (`git commit -m 'Add some AmazingFeature'`).
4. **Push** to the branch (`git push origin feature/AmazingFeature`).
5. **Open** a Pull Request.

### **Areas for Contribution**
- [ ] Support for directory (folder) transfers.
- [ ] Native binary builds (using `pkg`) for zero-dependency CLI usage.
- [ ] Performance optimizations for ultra-large files (10GB+).
- [ ] Mobile app (React Native/Flutter) integration.

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 👨‍💻 Author

**Sanjay Kumar**
- GitHub: [@SanjayKumarDevipujak](https://github.com/SanjayKumarDevipujak)

---

*Built with ❤️ for the open-source community.*
