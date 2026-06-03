const socket = io();
let localStream;
let currentRoomCode = "";
let myUserName = "";
let peers = {};
let pendingSignals = {};

// ─── TOAST ───────────────────────────────────────────────────────────────────
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

// ─── UI HELPERS ──────────────────────────────────────────────────────────────
function switchTab(type) {
    const isCreate = type === 'create';
    document.getElementById('tab-create').classList.toggle('active', isCreate);
    document.getElementById('tab-join').classList.toggle('active', !isCreate);
    document.getElementById('create-area').classList.toggle('d-none', !isCreate);
    document.getElementById('join-area').classList.toggle('d-none', isCreate);
}

function toggleLoading(btnId, show, customText = "") {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const spinner = btn.querySelector('.spinner');
    const text = btn.querySelector('.btn-text');
    if (show) {
        spinner?.classList.remove('d-none');
        if (text) text.innerText = customText || "Processing...";
        btn.disabled = true;
    } else {
        spinner?.classList.add('d-none');
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
}

// ─── MEDIA ───────────────────────────────────────────────────────────────────
async function startMedia() {
    if (localStream) return;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user", frameRate: { ideal: 30 } },
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        document.getElementById('local-video').srcObject = localStream;
    } catch (err) {
        showToast("Camera & Microphone permissions required!", "error");
        throw err;
    }
}

// ─── ROOM ACTIONS ─────────────────────────────────────────────────────────────
function actionCreateRoom() {
    const name = document.getElementById('create-name').value.trim();
    const code = document.getElementById('create-code').value;
    const maxUsers = document.getElementById('max-users').value;
    if (!validateName(name)) { showToast("Name must be 4-15 chars (Letters & Spaces only)!", "error"); return; }
    if (!/^[0-9]{8}$/.test(code)) { showToast("Room code must be exactly 8 digits!", "error"); return; }
    toggleLoading('btn-create', true, "Creating Session...");
    myUserName = name;
    currentRoomCode = code;
    socket.emit('create-room', { roomCode: code, maxUsers, userName: name });
}

function actionJoinRoom() {
    const name = document.getElementById('join-name').value.trim();
    const code = document.getElementById('join-code').value;
    if (!validateName(name)) { showToast("Name must be 4-15 chars (Letters & Spaces only)!", "error"); return; }
    if (!/^[0-9]{8}$/.test(code)) { showToast("Room code must be exactly 8 digits!", "error"); return; }
    myUserName = name;
    currentRoomCode = code;
    toggleLoading('btn-join', true, "Verifying Room...");
    socket.emit('verify-room-code', { roomCode: code });
}

// ─── SOCKET: ROOM LIFECYCLE ──────────────────────────────────────────────────
socket.on('room-created', async (code) => {
    try {
        await startMedia();
        document.getElementById('local-name-tag').innerText = `${myUserName} (You)`;
        navigator.clipboard.writeText(`${window.location.origin}?room=${code}`).catch(() => {});
        showToast(`Room [${code}] Created!`, "success");
        showToast("Share link copied to clipboard!", "info");
        // JOIN the room — server will send back existing-users list (empty for first user)
        socket.emit('join-room', { roomCode: code, userName: myUserName });
        showCallPanel();
    } catch (e) {}
    toggleLoading('btn-create', false);
});

socket.on('room-verified-ok', async () => {
    try {
        await startMedia();
        document.getElementById('local-name-tag').innerText = `${myUserName} (You)`;
        // JOIN — server will respond with existing-users so WE initiate to each of them
        socket.emit('join-room', { roomCode: currentRoomCode, userName: myUserName });
        showCallPanel();
    } catch (e) {}
    toggleLoading('btn-join', false);
});

// ── KEY FIX: Server sends existing users to the NEW joiner ──
// New joiner becomes INITIATOR for each existing user.
// Existing users get 'user-connected' and become NON-INITIATOR.
// This ensures both sides create their peer correctly.
socket.on('existing-users', ({ users }) => {
    // users = [{userId, userName}, ...] already in the room
    users.forEach(({ userId, userName }) => {
        console.log(`[existing-users] Creating initiator peer for ${userName} (${userId})`);
        createPeer(userId, true, userName);
    });
});

socket.on('user-connected', ({ userId, userName }) => {
    // An existing user in the room gets this when someone new joins
    // They become NON-INITIATOR — the joiner will initiate
    showToast(`${userName} joined the call!`, "success");
    if (!localStream) return;
    console.log(`[user-connected] Creating non-initiator peer for ${userName} (${userId})`);
    createPeer(userId, false, userName);
});

// ─── PEER CREATION ───────────────────────────────────────────────────────────
function createPeer(userId, initiator, userName) {
    if (peers[userId]) {
        try { peers[userId].destroy(); } catch (e) {}
        delete peers[userId];
    }

    console.log(`Creating peer: userId=${userId}, initiator=${initiator}, name=${userName}`);

    const peer = new SimplePeer({
        initiator,
        trickle: true,
        stream: localStream,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:global.stun.twilio.com:3478' }
            ]
        }
    });

    peer.on('signal', (data) => {
        socket.emit('signal', { to: userId, signal: data });
    });

    peer.on('stream', (remoteStream) => {
        console.log(`[stream] Got remote stream from ${userName}`);
        addRemoteVideo(userId, remoteStream, userName);
        monitorVideoHealth(userId, remoteStream);
        // Broadcast our current mute/cam state
        const audio = localStream.getAudioTracks()[0];
        const video = localStream.getVideoTracks()[0];
        socket.emit('update-state', {
            roomCode: currentRoomCode,
            isMuted: !audio?.enabled,
            isCamOff: !video?.enabled
        });
    });

    peer.on('connect', () => console.log(`[connect] Peer connected: ${userId}`));

    peer.on('error', (err) => {
        console.warn(`[error] Peer ${userId}:`, err.message);
        if (document.getElementById(`box-${userId}`)) {
            setTimeout(() => attemptReconnect(userId, userName), 2000);
        }
    });

    peer.on('close', () => console.log(`[close] Peer closed: ${userId}`));

    peers[userId] = peer;

    // Flush buffered signals
    if (pendingSignals[userId]) {
        pendingSignals[userId].forEach(sig => { try { peer.signal(sig); } catch (e) {} });
        delete pendingSignals[userId];
    }

    return peer;
}

// ─── SOCKET: SIGNALING ───────────────────────────────────────────────────────
socket.on('signal', (data) => {
    const userId = data.from;
    const remoteName = data.remoteName || "Participant";

    if (!peers[userId]) {
        if (!localStream) {
            // Not ready yet — buffer the signal
            if (!pendingSignals[userId]) pendingSignals[userId] = [];
            pendingSignals[userId].push(data.signal);
            return;
        }
        // Peer doesn't exist yet — create as non-initiator
        createPeer(userId, false, remoteName);
    }

    try {
        peers[userId].signal(data.signal);
    } catch (e) {
        console.warn(`[signal] Error for ${userId}, buffering:`, e.message);
        if (!pendingSignals[userId]) pendingSignals[userId] = [];
        pendingSignals[userId].push(data.signal);
    }
});

socket.on('reconnect-request', ({ from, fromName }) => {
    if (!localStream) return;
    createPeer(from, false, fromName || "Participant");
});

socket.on('state-changed', ({ userId, isMuted, isCamOff }) => {
    document.getElementById(`mute-${userId}`)?.classList.toggle('d-none', !isMuted);
    const overlay = document.getElementById(`cam-overlay-${userId}`);
    const vid = document.querySelector(`#box-${userId} video`);
    if (overlay && vid) {
        overlay.classList.toggle('d-none', !isCamOff);
        vid.style.visibility = isCamOff ? 'hidden' : 'visible';
    }
});

socket.on('user-disconnected', ({ userId, userName }) => {
    showToast(`${userName} left the call.`, "info");
    try { peers[userId]?.destroy(); } catch (e) {}
    delete peers[userId];
    delete pendingSignals[userId];
    document.getElementById(`box-${userId}`)?.remove();
});

socket.on('room-expired', (msg) => {
    showToast(`Session Expired: ${msg}`, "error");
    setTimeout(cleanUpAndRedirect, 2500);
});

socket.on('error-msg', (msg) => {
    showToast(msg, "error");
    toggleLoading('btn-join', false);
    toggleLoading('btn-create', false);
});

// ─── VIDEO ELEMENT ────────────────────────────────────────────────────────────
function addRemoteVideo(userId, stream, userName) {
    const existing = document.getElementById(`box-${userId}`);
    if (existing) {
        const vid = existing.querySelector('video');
        if (vid) { vid.srcObject = stream; vid.play().catch(() => {}); }
        return;
    }

    const grid = document.getElementById('video-grid');
    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = `box-${userId}`;

    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.muted = false;
    video.volume = 1.0;
    video.srcObject = stream;

    video.onloadedmetadata = () => {
        video.play().catch(err => {
            console.warn("Autoplay blocked:", err);
            showUnmuteOverlay(container, video);
        });
    };

    const overlay = document.createElement('div');
    overlay.className = 'camera-off-overlay d-none';
    overlay.id = `cam-overlay-${userId}`;
    overlay.innerHTML = `<i class="fas fa-video-slash"></i>`;

    const tag = document.createElement('div');
    tag.className = 'name-tag';
    tag.innerHTML = `<span>${userName}</span><i class="fas fa-microphone-slash mute-icon d-none" id="mute-${userId}"></i>`;

    container.appendChild(video);
    container.appendChild(overlay);
    container.appendChild(tag);
    grid.appendChild(container);
}

function showUnmuteOverlay(container, video) {
    if (container.querySelector('.tap-play')) return;
    const btn = document.createElement('div');
    btn.className = 'tap-play';
    btn.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);
        z-index:10;display:flex;align-items:center;justify-content:center;cursor:pointer;
        flex-direction:column;gap:10px;color:white;font-size:14px;border-radius:12px;`;
    btn.innerHTML = `<i class="fas fa-volume-up" style="font-size:32px"></i><span>Tap to Enable Audio</span>`;
    btn.onclick = () => { video.muted = false; video.play().then(() => btn.remove()).catch(() => {}); };
    container.appendChild(btn);
}

// ─── FREEZE MONITOR ───────────────────────────────────────────────────────────
function monitorVideoHealth(userId, stream) {
    const videoEl = document.querySelector(`#box-${userId} video`);
    if (!videoEl) return;
    let lastTime = 0, frozenCount = 0;
    const check = setInterval(() => {
        if (!document.getElementById(`box-${userId}`)) { clearInterval(check); return; }
        if (videoEl.paused) videoEl.play().catch(() => {});
        if (videoEl.readyState >= 2 && !videoEl.paused) {
            if (videoEl.currentTime === lastTime) {
                if (++frozenCount >= 3) {
                    videoEl.srcObject = null;
                    videoEl.srcObject = stream;
                    videoEl.play().catch(() => {});
                    frozenCount = 0;
                }
            } else { frozenCount = 0; }
            lastTime = videoEl.currentTime;
        }
    }, 4000);
}

// ─── RECONNECT ────────────────────────────────────────────────────────────────
function attemptReconnect(userId, userName) {
    if (!localStream || !document.getElementById(`box-${userId}`)) return;
    socket.emit('request-reconnect', { to: userId, roomCode: currentRoomCode });
    createPeer(userId, true, userName);
}

// ─── CONTROLS ─────────────────────────────────────────────────────────────────
function toggleMute() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    document.getElementById('btn-mute').innerText = muted ? "Unmute" : "Mute";
    document.getElementById('local-mute-icon')?.classList.toggle('d-none', !muted);
    showToast(muted ? "Microphone Silenced" : "Microphone Active", muted ? "info" : "success");
    const vt = localStream.getVideoTracks()[0];
    socket.emit('update-state', { roomCode: currentRoomCode, isMuted: muted, isCamOff: !vt?.enabled });
}

function toggleCamera() {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const off = !track.enabled;
    document.getElementById('btn-camera').innerText = off ? "Start Video" : "Stop Video";
    document.getElementById('local-cam-overlay')?.classList.toggle('d-none', !off);
    const lv = document.getElementById('local-video');
    if (lv) lv.style.visibility = off ? 'hidden' : 'visible';
    showToast(off ? "Video Feed Hidden" : "Video Feed Transmitting", off ? "info" : "success");
    const at = localStream.getAudioTracks()[0];
    socket.emit('update-state', { roomCode: currentRoomCode, isMuted: !at?.enabled, isCamOff: off });
}

function confirmEndCall() {
    if (confirm("End call? This will destroy the session.")) cleanUpAndRedirect();
}

function cleanUpAndRedirect() {
    localStream?.getTracks().forEach(t => t.stop());
    Object.values(peers).forEach(p => { try { p.destroy(); } catch (e) {} });
    peers = {};
    pendingSignals = {};
    window.location.href = window.location.origin;
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
window.onload = () => {
    const room = new URLSearchParams(window.location.search).get('room');
    if (room) {
        switchTab('join');
        document.getElementById('join-code').value = room;
        showToast("Room invitation applied automatically!", "success");
    }
};
