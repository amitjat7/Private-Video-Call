const socket = io();

let localStream = null;
let currentRoomCode = "";
let myUserName = "";
let peers = {};
let pendingSignals = {};
let userNames = {};
let pendingJoiners = {};     // users who joined before our media was ready
let iceConfig = null;
let githubReady = false;

// ─── LOAD CONFIG (ICE servers + GitHub link from server env) ─────────────────
async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const cfg = await res.json();
        iceConfig = cfg.iceServers;
        const link = document.getElementById('github-link');
        const handle = document.getElementById('github-handle');
        if (link && cfg.githubUrl) link.href = cfg.githubUrl;
        if (handle && cfg.githubHandle) handle.innerText = '@' + cfg.githubHandle;
        githubReady = true;
    } catch (e) {
        console.warn('Config load failed, using fallback ICE.');
    }
}
loadConfig();

function getIceServers() {
    if (iceConfig && iceConfig.length) return iceConfig;
    return [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ];
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
function showToast(message, type = "info") {
    const container = document.getElementById('notification-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 4000);
}

function switchTab(type) {
    const isCreate = type === 'create';
    document.getElementById('tab-create').classList.toggle('active', isCreate);
    document.getElementById('tab-join').classList.toggle('active', !isCreate);
    document.getElementById('create-area').classList.toggle('d-none', !isCreate);
    document.getElementById('join-area').classList.toggle('d-none', isCreate);
    document.querySelector('.tabs').classList.toggle('join-active', !isCreate);
}

function generateCode() {
    const code = String(Math.floor(10000000 + Math.random() * 90000000));
    document.getElementById('create-code').value = code;
}

function toggleLoading(btnId, show, customText = "") {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const spinner = btn.querySelector('.spinner');
    const text = btn.querySelector('.btn-text');
    if (show) {
        spinner && spinner.classList.remove('d-none');
        if (text) text.innerText = customText || "Processing...";
        btn.disabled = true;
    } else {
        spinner && spinner.classList.add('d-none');
        if (text) text.innerText = btnId === 'btn-create' ? "Create & Share Link" : "Join Session";
        btn.disabled = false;
    }
}

function validateName(name) {
    return /^[A-Za-z ]{4,15}$/.test(name);
}

function showCallPanel() {
    document.getElementById('setup-panel').classList.add('d-none');
    document.getElementById('call-panel').classList.remove('d-none');
    document.getElementById('room-label').innerText = `Room ${currentRoomCode}`;
}

function copyInvite() {
    const url = `${window.location.origin}?room=${currentRoomCode}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
            () => showToast("Invite link copied.", "success"),
            () => showToast(url, "info")
        );
    } else {
        showToast(url, "info");
    }
}

// ─── MEDIA ────────────────────────────────────────────────────────────────────
async function startMedia() {
    if (localStream) return;

    const constraints = {
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user", frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    };

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast("Browser not supported. Use Chrome, Firefox or Edge over HTTPS.", "error");
        throw new Error("getUserMedia not supported");
    }

    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (err2) {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
                showToast("Camera unavailable. Joining with audio only.", "info");
            } catch (err3) {
                let msg = "Camera and microphone access denied.";
                if (err3.name === 'NotAllowedError') msg = "Permission denied. Allow camera and mic in browser settings, then reload.";
                else if (err3.name === 'NotFoundError') msg = "No camera or microphone found on this device.";
                else if (err3.name === 'NotReadableError') msg = "Camera or mic is in use by another app. Close it and retry.";
                showToast(msg, "error");
                throw err3;
            }
        }
    }

    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;
    try { await localVideo.play(); } catch (e) {}

    // Media is now ready: connect to anyone who joined while we were loading,
    // and flush any signals that arrived early.
    Object.keys(pendingJoiners).forEach(userId => {
        if (!peers[userId]) createPeer(userId, false, pendingJoiners[userId]);
    });
    pendingJoiners = {};

    Object.keys(pendingSignals).forEach(userId => {
        if (!peers[userId]) createPeer(userId, false, userNames[userId] || "Participant");
    });
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────
function actionCreateRoom() {
    const name = document.getElementById('create-name').value.trim();
    const code = document.getElementById('create-code').value;
    const maxUsers = document.getElementById('max-users').value;
    if (!validateName(name)) { showToast("Name must be 4-15 characters (letters and spaces only).", "error"); return; }
    if (!/^[0-9]{8}$/.test(code)) { showToast("Room code must be exactly 8 digits.", "error"); return; }
    toggleLoading('btn-create', true, "Creating Session...");
    myUserName = name;
    currentRoomCode = code;
    socket.emit('create-room', { roomCode: code, maxUsers, userName: name });
}

function actionJoinRoom() {
    const name = document.getElementById('join-name').value.trim();
    const code = document.getElementById('join-code').value;
    if (!validateName(name)) { showToast("Name must be 4-15 characters (letters and spaces only).", "error"); return; }
    if (!/^[0-9]{8}$/.test(code)) { showToast("Room code must be exactly 8 digits.", "error"); return; }
    myUserName = name;
    currentRoomCode = code;
    toggleLoading('btn-join', true, "Verifying Room...");
    socket.emit('verify-room-code', { roomCode: code });
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────
socket.on('room-created', async (code) => {
    try {
        await startMedia();
        document.getElementById('local-name-tag').innerText = `${myUserName} (You)`;
        try { navigator.clipboard.writeText(`${window.location.origin}?room=${code}`); } catch (e) {}
        showToast(`Room ${code} created.`, "success");
        showToast("Share link copied to clipboard.", "info");
        socket.emit('join-room', { roomCode: code, userName: myUserName });
        showCallPanel();
    } catch (e) {}
    toggleLoading('btn-create', false);
});

socket.on('room-verified-ok', async () => {
    try {
        await startMedia();
        document.getElementById('local-name-tag').innerText = `${myUserName} (You)`;
        socket.emit('join-room', { roomCode: currentRoomCode, userName: myUserName });
        showCallPanel();
    } catch (e) {}
    toggleLoading('btn-join', false);
});

// I am the new joiner: I INITIATE offers to every existing user.
socket.on('existing-users', ({ users }) => {
    users.forEach(({ userId, userName }) => {
        userNames[userId] = userName;
        createPeer(userId, true, userName);
    });
});

// Someone new joined: I WAIT for their offer (they initiate).
socket.on('user-connected', ({ userId, userName }) => {
    showToast(`${userName} joined the call.`, "success");
    userNames[userId] = userName;
    if (!localStream) {
        // Media not ready yet: remember them and connect after startMedia()
        pendingJoiners[userId] = userName;
        return;
    }
    createPeer(userId, false, userName);
});

socket.on('signal', (data) => {
    const userId = data.from;
    const remoteName = data.remoteName || userNames[userId] || "Participant";
    userNames[userId] = remoteName;

    if (!peers[userId]) {
        if (!localStream) {
            if (!pendingSignals[userId]) pendingSignals[userId] = [];
            pendingSignals[userId].push(data.signal);
            return;
        }
        createPeer(userId, false, remoteName);
    }

    try {
        peers[userId].signal(data.signal);
    } catch (e) {
        if (!pendingSignals[userId]) pendingSignals[userId] = [];
        pendingSignals[userId].push(data.signal);
    }
});

socket.on('reconnect-request', ({ from, fromName }) => {
    if (!localStream) return;
    userNames[from] = fromName || "Participant";
    createPeer(from, false, fromName || "Participant");
});

socket.on('state-changed', ({ userId, isMuted, isCamOff }) => {
    const muteIcon = document.getElementById(`mute-${userId}`);
    if (muteIcon) muteIcon.classList.toggle('d-none', !isMuted);
    const overlay = document.getElementById(`cam-overlay-${userId}`);
    const vid = document.querySelector(`#box-${userId} video`);
    if (overlay && vid) {
        overlay.classList.toggle('d-none', !isCamOff);
        vid.style.visibility = isCamOff ? 'hidden' : 'visible';
    }
});

socket.on('user-disconnected', ({ userId, userName }) => {
    showToast(`${userName || 'A participant'} left the call.`, "info");
    destroyPeer(userId);
});

socket.on('room-expired', (msg) => {
    showToast(`Session expired: ${msg}`, "error");
    setTimeout(cleanUpAndRedirect, 2500);
});

socket.on('error-msg', (msg) => {
    showToast(msg, "error");
    toggleLoading('btn-join', false);
    toggleLoading('btn-create', false);
});

socket.on('disconnect', () => {
    if (currentRoomCode && localStream) showToast("Connection lost. Reconnecting...", "info");
});

socket.on('connect', () => {
    // Socket reconnected mid-call: rejoin room so signaling keeps working
    if (currentRoomCode && localStream && myUserName) {
        socket.emit('join-room', { roomCode: currentRoomCode, userName: myUserName });
    }
});

// ─── PEER MANAGEMENT (full mesh, 2-4 users) ──────────────────────────────────
function destroyPeer(userId) {
    try { if (peers[userId]) peers[userId].destroy(); } catch (e) {}
    delete peers[userId];
    delete pendingSignals[userId];
    delete pendingJoiners[userId];
    const box = document.getElementById(`box-${userId}`);
    if (box) box.remove();
}

function createPeer(userId, initiator, userName) {
    if (peers[userId]) {
        try { peers[userId].destroy(); } catch (e) {}
        delete peers[userId];
    }

    const peer = new SimplePeer({
        initiator,
        trickle: true,
        stream: localStream,
        config: {
            iceServers: getIceServers(),
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceCandidatePoolSize: 4
        },
        offerOptions: { offerToReceiveAudio: true, offerToReceiveVideo: true }
    });

    peer._targetId = userId;
    peer._targetName = userName;

    peer.on('signal', (data) => {
        socket.emit('signal', { to: userId, signal: data });
    });

    peer.on('stream', (remoteStream) => {
        addRemoteVideo(userId, remoteStream, userName || userNames[userId] || "Participant");
        monitorVideoHealth(userId, remoteStream);
        broadcastMyState();
    });

    // Belt-and-braces: also attach via raw ontrack (some browsers fire this
    // more reliably than simple-peer's 'stream')
    if (peer._pc) {
        peer._pc.addEventListener('track', (event) => {
            const remoteStream = event.streams && event.streams[0];
            if (!remoteStream) return;
            const existingBox = document.getElementById(`box-${userId}`);
            if (existingBox) {
                const vid = existingBox.querySelector('video');
                if (vid && vid.srcObject !== remoteStream) {
                    vid.srcObject = remoteStream;
                    playVideo(vid);
                }
            } else {
                addRemoteVideo(userId, remoteStream, userName || userNames[userId] || "Participant");
                monitorVideoHealth(userId, remoteStream);
            }
        });

        // Auto-recover on ICE failure
        peer._pc.addEventListener('connectionstatechange', () => {
            const st = peer._pc.connectionState;
            if (st === 'failed') {
                console.warn(`[ice] Connection failed with ${userId}, rebuilding...`);
                scheduleReconnect(userId, userName);
            }
        });
        peer._pc.addEventListener('iceconnectionstatechange', () => {
            if (peer._pc.iceConnectionState === 'failed') {
                scheduleReconnect(userId, userName);
            }
        });
    }

    peer.on('connect', () => console.log(`[peer] Connected: ${userName} (${userId})`));

    peer.on('error', (err) => {
        console.warn(`[peer] Error ${userId}:`, err.message);
        scheduleReconnect(userId, userName);
    });

    peer.on('close', () => console.log(`[peer] Closed: ${userId}`));

    peers[userId] = peer;

    // Flush any signals that arrived before this peer existed
    if (pendingSignals[userId] && pendingSignals[userId].length) {
        const toFlush = pendingSignals[userId].splice(0);
        delete pendingSignals[userId];
        toFlush.forEach(sig => {
            try { peer.signal(sig); } catch (e) {}
        });
    }

    return peer;
}

let reconnectTimers = {};
function scheduleReconnect(userId, userName) {
    if (reconnectTimers[userId]) return;
    reconnectTimers[userId] = setTimeout(() => {
        delete reconnectTimers[userId];
        if (!localStream || !userNames[userId]) return;
        // Deterministic role on rebuild: lower socket id initiates (prevents glare)
        const iInitiate = socket.id < userId;
        socket.emit('request-reconnect', { to: userId, roomCode: currentRoomCode });
        if (iInitiate) {
            createPeer(userId, true, userName || userNames[userId] || "Participant");
        }
    }, 2000);
}

function broadcastMyState() {
    const audio = localStream && localStream.getAudioTracks()[0];
    const video = localStream && localStream.getVideoTracks()[0];
    socket.emit('update-state', {
        roomCode: currentRoomCode,
        isMuted: audio ? !audio.enabled : true,
        isCamOff: video ? !video.enabled : true
    });
}

// ─── VIDEO RENDERING ─────────────────────────────────────────────────────────
function playVideo(videoEl) {
    if (!videoEl) return;
    const p = videoEl.play();
    if (p && p.catch) {
        p.catch(err => {
            if (err.name === 'NotAllowedError') {
                showUnmuteOverlay(videoEl.parentElement, videoEl);
            }
        });
    }
}

function addRemoteVideo(userId, stream, userName) {
    const existing = document.getElementById(`box-${userId}`);
    if (existing) {
        const vid = existing.querySelector('video');
        if (vid) { vid.srcObject = stream; playVideo(vid); }
        return;
    }

    const grid = document.getElementById('video-grid');
    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = `box-${userId}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.muted = false;
    video.volume = 1.0;
    video.srcObject = stream;
    video.onloadedmetadata = () => playVideo(video);
    video.onclick = () => { video.muted = false; playVideo(video); };

    const overlay = document.createElement('div');
    overlay.className = 'camera-off-overlay d-none';
    overlay.id = `cam-overlay-${userId}`;
    overlay.innerHTML = '<i class="fas fa-video-slash"></i>';

    const tag = document.createElement('div');
    tag.className = 'name-tag';
    tag.innerHTML = `<span>${escapeHtml(userName)}</span><i class="fas fa-microphone-slash mute-icon d-none" id="mute-${userId}"></i>`;

    container.appendChild(video);
    container.appendChild(overlay);
    container.appendChild(tag);
    grid.appendChild(container);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.innerText = String(str || '');
    return div.innerHTML;
}

function showUnmuteOverlay(container, video) {
    if (!container || container.querySelector('.tap-play')) return;
    const btn = document.createElement('div');
    btn.className = 'tap-play';
    btn.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(26,25,21,0.7);
        z-index:10;display:flex;align-items:center;justify-content:center;cursor:pointer;
        flex-direction:column;gap:10px;color:#faf9f5;font-size:14px;border-radius:14px;`;
    btn.innerHTML = '<i class="fas fa-volume-up" style="font-size:30px"></i><span>Tap to enable audio</span>';
    btn.onclick = () => {
        video.muted = false;
        video.volume = 1.0;
        playVideo(video);
        btn.remove();
    };
    container.appendChild(btn);
}

function monitorVideoHealth(userId, stream) {
    let lastTime = -1;
    let frozenCount = 0;

    const check = setInterval(() => {
        const box = document.getElementById(`box-${userId}`);
        if (!box) { clearInterval(check); return; }

        const videoEl = box.querySelector('video');
        if (!videoEl) return;

        if (videoEl.paused && !videoEl.ended) playVideo(videoEl);

        if (videoEl.readyState >= 2) {
            if (videoEl.currentTime === lastTime && !videoEl.paused) {
                frozenCount++;
                if (frozenCount >= 3) {
                    console.warn(`[freeze] Refreshing stream for ${userId}`);
                    videoEl.srcObject = null;
                    videoEl.srcObject = stream;
                    playVideo(videoEl);
                    frozenCount = 0;
                }
            } else {
                frozenCount = 0;
            }
            lastTime = videoEl.currentTime;
        }
    }, 4000);
}

// ─── CONTROLS ────────────────────────────────────────────────────────────────
function toggleMute() {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    document.getElementById('btn-mute').innerText = muted ? "Unmute" : "Mute";
    const icon = document.getElementById('local-mute-icon');
    if (icon) icon.classList.toggle('d-none', !muted);
    showToast(muted ? "Microphone muted" : "Microphone active", muted ? "info" : "success");
    broadcastMyState();
}

function toggleCamera() {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const off = !track.enabled;
    document.getElementById('btn-camera').innerText = off ? "Start Video" : "Stop Video";
    const overlay = document.getElementById('local-cam-overlay');
    if (overlay) overlay.classList.toggle('d-none', !off);
    const lv = document.getElementById('local-video');
    if (lv) lv.style.visibility = off ? 'hidden' : 'visible';
    showToast(off ? "Video hidden" : "Video transmitting", off ? "info" : "success");
    broadcastMyState();
}

function confirmEndCall() {
    if (confirm("End call? This will leave the session.")) cleanUpAndRedirect();
}

function cleanUpAndRedirect() {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    Object.keys(peers).forEach(destroyPeer);
    peers = {};
    pendingSignals = {};
    userNames = {};
    pendingJoiners = {};
    window.location.href = window.location.origin;
}

// ─── INIT ────────────────────────────────────────────────────────────────────
window.onload = () => {
    const room = new URLSearchParams(window.location.search).get('room');
    if (room && /^[0-9]{8}$/.test(room)) {
        switchTab('join');
        document.getElementById('join-code').value = room;
        showToast("Room invitation applied automatically.", "success");
    }
};
