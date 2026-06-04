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
- Steps to get ngrok auth token:-
- Go to https://ngrok.com, signup, tap on menu bar lie on top left or right of the site, you will see authtoken there, tap on authtoken and copy the token and now you can easily paste the it in your project.


## ⚙️ Setup
1. Clone the repo
   ```bash
   git clone https://github.com/amitjat7/instant-video-call.git
   cd instant-video-call

2. Install Dependencies
   ```bash
   npm install

4. Copy .env.example to .env OR (Rename .env.example  to  .env)
   ```bash
   cp .env.example .env

6. Add your Ngrok token and PORT number in .env file
   ```bash
   NGROK_AUTHTOKEN=your_token_here
   PORT=your_port_number

8. Start the server
   ```bash
   npm start

10. Ngrok public URL will appear in terminal — share it!
    Your project will be live on the url...
    example:👇
    ```bash
    https://refinery-hatbox-shout.ngrok-free.dev/

## 🔒 Privacy
All video/audio is streamed directly peer-to-peer. No media data touches the server.

---
Made with ❤️ by Amit Choudhary
