require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const ngrok = require('@ngrok/ngrok');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 7026;

app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const ipTrack = {};

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    if (!ipTrack[clientIp]) ipTrack[clientIp] = { createCount: 0, lastReset: Date.now() };

    socket.on('verify-room-code', ({ roomCode }) => {
        if (!/^[0-9]{8}$/.test(roomCode)) {
            return socket.emit('error-msg', 'Invalid format! Code must be exactly 8 digits.');
        }
        if (!rooms[roomCode]) {
            return socket.emit('error-msg', 'Room does not exist or has expired!');
        }
        if (rooms[roomCode].users.length >= rooms[roomCode].maxUsers) {
            return socket.emit('error-msg', 'Room is full!');
        }
        socket.emit('room-verified-ok');
    });

    socket.on('create-room', ({ roomCode, maxUsers, userName }) => {
        const now = Date.now();
        if (now - ipTrack[clientIp].lastReset > 60000) {
            ipTrack[clientIp].createCount = 0;
            ipTrack[clientIp].lastReset = now;
        }
        if (ipTrack[clientIp].createCount >= 5) return socket.emit('error-msg', 'Max 5 rooms/min reached.');
        if (!userName || !/^[A-Za-z ]{4,15}$/.test(userName)) return socket.emit('error-msg', 'Invalid name.');
        if (!/^[0-9]{8}$/.test(roomCode)) return socket.emit('error-msg', 'Invalid room code.');
        if (rooms[roomCode]) return socket.emit('error-msg', 'Room already exists!');

        ipTrack[clientIp].createCount++;
        let userLimit = Math.min(Math.max(parseInt(maxUsers) || 2, 2), 4);

        rooms[roomCode] = {
            users: [],
            maxUsers: userLimit,
            createdAt: Date.now(),
            timeoutId: setTimeout(() => {
                if (rooms[roomCode]?.users.length === 0) {
                    delete rooms[roomCode];
                    console.log(`Room [${roomCode}] expired (empty).`);
                }
            }, 15 * 60 * 1000)
        };

        socket.emit('room-created', roomCode);
    });

    socket.on('join-room', ({ roomCode, userName }) => {
        if (!userName || !/^[A-Za-z ]{4,15}$/.test(userName)) {
            return socket.emit('error-msg', 'Invalid name format.');
        }
        const room = rooms[roomCode];
        if (!room) return socket.emit('error-msg', 'Room closed or inactive.');
        if (room.users.length >= room.maxUsers) return socket.emit('error-msg', 'Room is full.');

        // ── KEY FIX: Send existing users to the NEW joiner BEFORE announcing them ──
        // The new joiner will be INITIATOR toward each existing user.
        // Each existing user will be NON-INITIATOR (they receive 'user-connected').
        const existingUsers = room.users.map(u => ({ userId: u.id, userName: u.name }));
        if (existingUsers.length > 0) {
            socket.emit('existing-users', { users: existingUsers });
        }

        // Now add the new user and announce to everyone else
        room.users.push({ id: socket.id, name: userName });
        socket.join(roomCode);

        // Notify existing users — they become NON-INITIATOR
        socket.to(roomCode).emit('user-connected', { userId: socket.id, userName });

        // Reset/set session timeout
        if (room.timeoutId) clearTimeout(room.timeoutId);
        room.timeoutId = setTimeout(() => {
            if (rooms[roomCode]) {
                io.to(roomCode).emit('room-expired', 'Call limit reached (1 Hour).');
                delete rooms[roomCode];
            }
        }, 60 * 60 * 1000);

        socket.on('disconnect', () => {
            if (!rooms[roomCode]) return;
            room.users = room.users.filter(u => u.id !== socket.id);
            socket.to(roomCode).emit('user-disconnected', { userId: socket.id, userName });
            if (room.users.length === 0) {
                clearTimeout(room.timeoutId);
                delete rooms[roomCode];
                console.log(`Room [${roomCode}] cleared.`);
            }
        });
    });

    socket.on('update-state', ({ roomCode, isMuted, isCamOff }) => {
        if (rooms[roomCode]) {
            socket.to(roomCode).emit('state-changed', { userId: socket.id, isMuted, isCamOff });
        }
    });

    socket.on('signal', (data) => {
        let senderName = "Participant";
        for (const code in rooms) {
            const user = rooms[code].users.find(u => u.id === socket.id);
            if (user) { senderName = user.name; break; }
        }
        io.to(data.to).emit('signal', { from: socket.id, signal: data.signal, remoteName: senderName });
    });

    socket.on('request-reconnect', ({ to, roomCode }) => {
        let senderName = "Participant";
        if (rooms[roomCode]) {
            const user = rooms[roomCode].users.find(u => u.id === socket.id);
            if (user) senderName = user.name;
        }
        io.to(to).emit('reconnect-request', { from: socket.id, fromName: senderName });
    });
});

setInterval(() => {
    Object.keys(ipTrack).forEach(ip => {
        if (Date.now() - ipTrack[ip].lastReset > 3600000) delete ipTrack[ip];
    });
}, 3600000);

server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    if (!process.env.NGROK_AUTHTOKEN) { console.error("❌ Missing NGROK_AUTHTOKEN"); return; }
    try {
        const tunnel = await ngrok.forward({ addr: PORT, authtoken: process.env.NGROK_AUTHTOKEN });
        console.log(`\n==================================================`);
        console.log(`🚀 NGROK TUNNEL ACTIVE`);
        console.log(`🔗 ${tunnel.url()}`);
        console.log(`==================================================\n`);
    } catch (err) {
        console.error("❌ Ngrok Error:", err);
    }
});
