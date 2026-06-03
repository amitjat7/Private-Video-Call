# 📹 Instant Video Call

A browser-based peer-to-peer encrypted video calling app built with WebRTC, Node.js, and Socket.IO.

## ✨ Features
- 🔐 Private rooms with 8-digit encryption code
- 👥 Support for up to 4 participants
- 🎥 Real-time video & audio (peer-to-peer, no media server)
- 🔇 Mute / Camera toggle with live status indicators
- 🔗 Shareable invite links
- 📡 ICE auto-reconnect & video freeze detection
- 🚀 Ngrok tunnel for instant public access

## 🛠️ Tech Stack
- **Frontend:** HTML, CSS, JavaScript, SimplePeer (WebRTC)
- **Backend:** Node.js, Express, Socket.IO
- **Tunneling:** Ngrok

## 📋 Prerequisites
- [Node.js](https://nodejs.org) installed
- [Ngrok](https://ngrok.com) account & authtoken

## ⚙️ Setup
1. Clone the repo
   ```bash
   git clone https://github.com/amitjat7/instant-video-call.git
   cd instant-video-call

2. Install Dependencies
npm install

3. Copy .env.example to .env
cp .env.example .env

4. Add your Ngrok token in .env file
NGROK_AUTHTOKEN=your_token_here

5. Start the server
npm start

6. Ngrok public URL will appear in terminal — share it!

#Privacy
All video/audio is streamed directly peer-to-peer. No media data touches the server.
Made with ❤️ by Amit Choudhary

