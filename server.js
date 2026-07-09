require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const ngrok = require('@ngrok/ngrok');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 7026;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_URL = process.env.GITHUB_URL || 'https://github.com';

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
function sendTelegram(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (!parsed.ok) console.error('[Telegram] API Error:', parsed.description);
            } catch (e) {}
        });
    });
    req.on('error', (err) => console.error('[Telegram] Error:', err.message));
    req.write(body);
    req.end();
}

// ─── SMART DDOS SHIELD ───────────────────────────────────────────────────────
// Only tightens when a real attack is detected. Normal users never notice it.
const shield = {
    underAttack: false,
    attackUntil: 0,
    requestLog: [],          // timestamps of recent requests
    ipHits: {},              // per-ip request counts (rolling)
    blockedIps: {},          // ip -> unblock timestamp
    ATTACK_THRESHOLD: 300,   // requests in 10s globally = attack
    IP_BURST_LIMIT: 120,     // single ip requests in 10s = abusive
    BLOCK_TIME: 10 * 60 * 1000
};

function getIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    return (fwd ? fwd.split(',')[0] : (req.socket?.remoteAddress || 'unknown')).trim();
}

function shieldCheck(ip) {
    const now = Date.now();

    // Blocked?
    if (shield.blockedIps[ip] && now < shield.blockedIps[ip]) return false;
    if (shield.blockedIps[ip]) delete shield.blockedIps[ip];

    // Log
    shield.requestLog.push(now);
    if (!shield.ipHits[ip]) shield.ipHits[ip] = [];
    shield.ipHits[ip].push(now);

    // Trim rolling window (10s)
    const cutoff = now - 10000;
    while (shield.requestLog.length && shield.requestLog[0] < cutoff) shield.requestLog.shift();
    shield.ipHits[ip] = shield.ipHits[ip].filter(t => t > cutoff);

    // Per-IP abuse detection
    if (shield.ipHits[ip].length > shield.IP_BURST_LIMIT) {
        shield.blockedIps[ip] = now + shield.BLOCK_TIME;
        sendTelegram(`<b>SECURITY ALERT</b>\nAbusive IP blocked: <b>${ip}</b>\nRate: ${shield.ipHits[ip].length} req/10s\n${new Date().toLocaleString()}`);
        return false;
    }

    // Global attack detection
    if (shield.requestLog.length > shield.ATTACK_THRESHOLD && !shield.underAttack) {
        shield.underAttack = true;
        shield.attackUntil = now + 5 * 60 * 1000;
        sendTelegram(`<b>DDOS ALERT</b>\nHigh traffic detected: ${shield.requestLog.length} req/10s\nShield mode ENABLED for 5 min.\n${new Date().toLocaleString()}`);
    }
    if (shield.underAttack && now > shield.attackUntil) {
        shield.underAttack = false;
        sendTelegram(`<b>SHIELD</b>\nAttack subsided. Normal mode restored.\n${new Date().toLocaleString()}`);
    }

    // Under attack: strict per-ip limit
    if (shield.underAttack && shield.ipHits[ip].length > 30) return false;

    return true;
}

// Cleanup shield memory hourly
setInterval(() => {
    const now = Date.now();
    Object.keys(shield.ipHits).forEach(ip => {
        shield.ipHits[ip] = shield.ipHits[ip].filter(t => t > now - 10000);
        if (!shield.ipHits[ip].length) delete shield.ipHits[ip];
    });
    Object.keys(shield.blockedIps).forEach(ip => {
        if (now > shield.blockedIps[ip]) delete shield.blockedIps[ip];
    });
}, 60 * 60 * 1000);

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');

    if (!shieldCheck(getIp(req))) return res.status(429).send('Too many requests.');
    next();
});

app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false
}));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ─── CONFIG API (GitHub link + ICE servers to client) ───────────────────────
app.get('/api/config', (req, res) => {
    const iceServers = [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: ['stun:stun2.l.google.com:19302', 'stun:stun4.l.google.com:19302'] },
        { urls: 'stun:stun.cloudflare.com:3478' },
        // Public relay fallbacks
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:relay1.expressturn.com:3480', username: 'ef4IZS86P8AR4PN2T1', credential: 'i6nyEJ6dcTPurYQI' }
    ];

    // Env-configured dedicated TURN takes priority (most reliable)
    if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
        iceServers.unshift({
            urls: process.env.TURN_URL.split(',').map(u => u.trim()),
            username: process.env.TURN_USERNAME,
            credential: process.env.TURN_CREDENTIAL
        });
    }

    let handle = 'developer';
    try {
        const parts = new URL(GITHUB_URL).pathname.split('/').filter(Boolean);
        if (parts.length) handle = parts[0];
    } catch (e) {}

    res.json({ githubUrl: GITHUB_URL, githubHandle: handle, iceServers });
});

// ─── ROOM STATE ──────────────────────────────────────────────────────────────
const rooms = {};
const ipTrack = {};
const socketIpCount = {};   // concurrent sockets per ip

io.use((socket, next) => {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    const ip = (fwd ? fwd.split(',')[0] : socket.handshake.address).trim();
    socket.cleanIp = ip;

    // Blocked by shield?
    if (shield.blockedIps[ip] && Date.now() < shield.blockedIps[ip]) {
        return next(new Error('blocked'));
    }

    // Concurrent socket flood protection
    const current = socketIpCount[ip] || 0;
    const limit = shield.underAttack ? 3 : 12;
    if (current >= limit) return next(new Error('too many connections'));

    socketIpCount[ip] = current + 1;
    next();
});

io.on('connection', (socket) => {
    const cleanIp = socket.cleanIp;
    if (!ipTrack[cleanIp]) ipTrack[cleanIp] = { createCount: 0, lastReset: Date.now() };

    // Per-socket event rate limiting (generous - WebRTC trickle ICE is chatty)
    let eventCount = 0;
    let eventWindow = Date.now();
    function eventAllowed() {
        const now = Date.now();
        if (now - eventWindow > 10000) { eventCount = 0; eventWindow = now; }
        eventCount++;
        if (eventCount > 400) {
            if (eventCount === 401) {
                sendTelegram(`<b>SECURITY</b>\nSocket flood from IP <b>${cleanIp}</b> - throttled.\n${new Date().toLocaleString()}`);
            }
            return false;
        }
        return true;
    }

    let joinedRoom = null;
    let myName = null;

    socket.on('verify-room-code', ({ roomCode }) => {
        if (!eventAllowed()) return;
        if (typeof roomCode !== 'string' || !/^[0-9]{8}$/.test(roomCode)) return socket.emit('error-msg', 'Invalid format. Code must be 8 digits.');
        if (!rooms[roomCode]) return socket.emit('error-msg', 'Room does not exist or has expired.');
        if (rooms[roomCode].users.length >= rooms[roomCode].maxUsers) return socket.emit('error-msg', 'Room is full.');
        socket.emit('room-verified-ok');
    });

    socket.on('create-room', ({ roomCode, maxUsers, userName }) => {
        if (!eventAllowed()) return;
        const now = Date.now();
        if (now - ipTrack[cleanIp].lastReset > 60000) { ipTrack[cleanIp].createCount = 0; ipTrack[cleanIp].lastReset = now; }
        if (ipTrack[cleanIp].createCount >= 5) return socket.emit('error-msg', 'Max 5 rooms per minute reached. Please wait.');
        if (typeof userName !== 'string' || !/^[A-Za-z ]{4,15}$/.test(userName)) return socket.emit('error-msg', 'Invalid name.');
        if (typeof roomCode !== 'string' || !/^[0-9]{8}$/.test(roomCode)) return socket.emit('error-msg', 'Invalid room code.');
        if (rooms[roomCode]) return socket.emit('error-msg', 'Room already exists. Choose another code.');

        ipTrack[cleanIp].createCount++;
        const userLimit = Math.min(Math.max(parseInt(maxUsers) || 2, 2), 4);

        rooms[roomCode] = {
            users: [],
            maxUsers: userLimit,
            createdAt: Date.now(),
            timeoutId: setTimeout(() => {
                if (rooms[roomCode]?.users.length === 0) delete rooms[roomCode];
            }, 15 * 60 * 1000)
        };

        sendTelegram(
            `<b>Room Created</b>\nHost: <b>${userName}</b>\nCode: <b>${roomCode}</b>\nMax: <b>${userLimit}</b>\nIP: <b>${cleanIp}</b>\n${new Date().toLocaleString()}`
        );

        socket.emit('room-created', roomCode);
    });

    socket.on('join-room', ({ roomCode, userName }) => {
        if (!eventAllowed()) return;
        if (typeof userName !== 'string' || !/^[A-Za-z ]{4,15}$/.test(userName)) return socket.emit('error-msg', 'Invalid name.');
        const room = rooms[roomCode];
        if (!room) return socket.emit('error-msg', 'Room closed or inactive.');
        if (room.users.length >= room.maxUsers) return socket.emit('error-msg', 'Room is full.');
        if (room.users.some(u => u.id === socket.id)) return;

        const existingUsers = room.users.map(u => ({ userId: u.id, userName: u.name }));

        room.users.push({ id: socket.id, name: userName });
        joinedRoom = roomCode;
        myName = userName;
        socket.join(roomCode);

        // Existing peers get notified FIRST so they prepare receiving peers,
        // then the joiner initiates offers to each of them.
        socket.to(roomCode).emit('user-connected', { userId: socket.id, userName });
        if (existingUsers.length > 0) {
            socket.emit('existing-users', { users: existingUsers });
            sendTelegram(
                `<b>User Joined</b>\n<b>${userName}</b>\nCode: <b>${roomCode}</b>\nActive: <b>${room.users.length}/${room.maxUsers}</b>\nIP: <b>${cleanIp}</b>\n${new Date().toLocaleString()}`
            );
        }

        if (room.timeoutId) clearTimeout(room.timeoutId);
        room.timeoutId = setTimeout(() => {
            if (rooms[roomCode]) {
                io.to(roomCode).emit('room-expired', 'Call limit reached (1 Hour).');
                delete rooms[roomCode];
            }
        }, 60 * 60 * 1000);
    });

    socket.on('update-state', ({ roomCode, isMuted, isCamOff }) => {
        if (!eventAllowed()) return;
        if (rooms[roomCode] && joinedRoom === roomCode) {
            socket.to(roomCode).emit('state-changed', { userId: socket.id, isMuted: !!isMuted, isCamOff: !!isCamOff });
        }
    });

    // Signal relay - validated: sender and target MUST be in the same room
    socket.on('signal', (data) => {
        if (!eventAllowed()) return;
        if (!data || typeof data.to !== 'string' || !joinedRoom) return;
        const room = rooms[joinedRoom];
        if (!room) return;
        const sender = room.users.find(u => u.id === socket.id);
        const target = room.users.find(u => u.id === data.to);
        if (!sender || !target) return;
        io.to(data.to).emit('signal', { from: socket.id, signal: data.signal, remoteName: sender.name });
    });

    socket.on('request-reconnect', ({ to, roomCode }) => {
        if (!eventAllowed()) return;
        if (!joinedRoom || joinedRoom !== roomCode || !rooms[roomCode]) return;
        const sender = rooms[roomCode].users.find(u => u.id === socket.id);
        const target = rooms[roomCode].users.find(u => u.id === to);
        if (!sender || !target) return;
        io.to(to).emit('reconnect-request', { from: socket.id, fromName: sender.name });
    });

    socket.on('disconnect', () => {
        socketIpCount[cleanIp] = Math.max(0, (socketIpCount[cleanIp] || 1) - 1);
        if (socketIpCount[cleanIp] === 0) delete socketIpCount[cleanIp];

        if (!joinedRoom || !rooms[joinedRoom]) return;
        const room = rooms[joinedRoom];
        room.users = room.users.filter(u => u.id !== socket.id);
        socket.to(joinedRoom).emit('user-disconnected', { userId: socket.id, userName: myName });

        sendTelegram(
            `<b>User Left</b>\n<b>${myName}</b>\nCode: <b>${joinedRoom}</b>\nRemaining: <b>${room.users.length}/${room.maxUsers}</b>\n${new Date().toLocaleString()}`
        );

        if (room.users.length === 0) {
            clearTimeout(room.timeoutId);
            const code = joinedRoom;
            delete rooms[joinedRoom];
            sendTelegram(`<b>Room Destroyed</b>\nCode: <b>${code}</b>\n${new Date().toLocaleString()}`);
        }
    });
});

setInterval(() => {
    Object.keys(ipTrack).forEach(ip => {
        if (Date.now() - ipTrack[ip].lastReset > 3600000) delete ipTrack[ip];
    });
}, 3600000);

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    if (!process.env.NGROK_AUTHTOKEN) { console.error("Missing NGROK_AUTHTOKEN"); return; }
    try {
        const tunnel = await ngrok.forward({ addr: PORT, authtoken: process.env.NGROK_AUTHTOKEN });
        const url = tunnel.url();
        console.log(`\n==================================================`);
        console.log(`NGROK TUNNEL ACTIVE`);
        console.log(`${url}`);
        console.log(`==================================================\n`);
        sendTelegram(`<b>Server Started</b>\nURL: <b>${url}</b>\n${new Date().toLocaleString()}`);
    } catch (err) {
        console.error("Ngrok Error:", err);
    }
});
