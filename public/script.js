const socket = io();
let localStream;
let currentRoomCode = "";
let myUserName = "";
let peers = {};
let pendingSignals = {}; // Buffer signals that arrive before peer is ready

function showToast(message, type = "info") {
    const container = document.getElementById('notification-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('show'); }, 10);
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => { toast.remove(); });
    }, 4000);
}

function switchTab(type) {
    if (type === 'create') {
        document.getElementById('tab-create').classList.add('active');
        document.getElementById('tab-join').classList.remove('active');
        document.getElementById('create-area').classList.remove('d-none');
        document.getElementById('join-area').classList.add('d-none');
    } else {
        document.getElementById('tab-join').classList.add('active');
        document.getElementById('tab-create').classList.remove('active');
        document.getElementById('join-area').classList.remove('d-none');
        document.getElementById('create-area').classList.add('d-none');
    }
}

function toggleLoading(btnId, show, customText = "") {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const spinner = btn.querySelector('.spinner');
    const text = btn.querySelector('.btn-text');
    if (show) {
        if (spinner) spinner.classList.remove('d-none');
        if (text) text.innerText = customText || "Processing...";
        btn.disabled = true;
    } else {
        if (spinner) spinner.classList.add('d-none');
        if (text) text.innerText = (btnId === 'btn-create') ? "Create & Share Link" : "Join Session";
        btn.disabled = false;
    }
}

function validateName(name) {
    return /^[A-Za-z ]{4,15}$/.test(name);
}

async function startMedia() {
    try {
        if (!localStream) {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user", frameRate: { ideal: 30 } },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000
                }
            });
            document.getElementById('local-video').srcObject = localStream;
        }
    } catch (err) {
        showToast("Camera & Microphone permissions required!", "error");
        throw err;
    }
}

function actionCreateRoom() {
    const name = document.getElementById('create-name').value.trim();
    const code = document.getElementById('create-code').value;
    const maxUsers = document.getElementById('max-users').value;

    if (!validateName(name)) { showToast("Name must be 4 to 15 characters long (Letters & Spaces only)!", "error"); return; }
    if (!/^[0-9]{8}$/.test(code)) { showToast("Room code must be exactly an 8-digit number!", "error"); return; }

    toggleLoading('btn-create', true, "Creating Session...");
    myUserName = name;
    document.getElementById('local-name-tag').innerText = `${name} (You)`;
    currentRoomCode = code;
    socket.emit('create-room', { roomCode: code, maxUsers, userName: name });
}

function actionJoinRoom() {
    const name = document.getElementById('join-name').value.trim();
    const code = document.getElementById('join-code').value;

    if (!validateName(name)) { showToast("Name must be 4 to 15 characters long (Letters & Spaces only)!", "error"); return; }
    if (!/^[0-9]{8}$/.test(code)) { showToast("Room code must be exactly an 8-digit number!", "error"); return; }

    myUserName = name;
    toggleLoading('btn-join', true, "Verifying Room...");
    currentRoomCode = code;
    socket.emit('verify-room-code', { roomCode: code });
}

socket.on('room-verified-ok', async () => {
    try {
        await startMedia();
        document.getElementById('local-name-tag').innerText = `${myUserName} (You)`;
        socket.emit('join-room', { roomCode: currentRoomCode, userName: myUserName });
        showCallPanel();
        toggleLoading('btn-join', false);
    } catch (err) {
        toggleLoading('btn-join', false);
    }
});

socket.on('room-created', (code) => {
    const shareableLink = `${window.location.origin}?room=${code}`;
    navigator.clipboard.writeText(shareableLink);
    showToast(`Room [${code}] Created Successfully!`, "success");
    showToast("Share link copied to clipboard!", "info");
    startMedia().then(() => {
        socket.emit('join-room', { roomCode: code, userName: myUserName });
        showCallPanel();
        toggleLoading('btn-create', false);
    }).catch(() => { toggleLoading('btn-create', false); });
});

// ─── PEER CREATION HELPER ───────────────────────────────────────────────────
function createPeer(userId, initiator, userName) {
    // Destroy existing peer cleanly before creating new one
    if (peers[userId]) {
        try { peers[userId].destroy(); } catch (e) {}
        delete peers[userId];
    }

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
            ],
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            sdpSemantics: 'unified-plan'
        }
    });

    peer.on('signal', (data) => {
        socket.emit('signal', { to: userId, signal: data });
    });

    peer.on('stream', (remoteStream) => {
        addRemoteVideo(userId, remoteStream, userName);
        monitorVideoHealth(userId, remoteStream);

        // Sync our local state to newly connected peer
        const audioTrack = localStream.getAudioTracks()[0];
        const videoTrack = localStream.getVideoTracks()[0];
        socket.emit('update-state', {
            roomCode: currentRoomCode,
            isMuted: !audioTrack?.enabled,
            isCamOff: !videoTrack?.enabled
        });
    });

    // ── FIX: ICE connection monitoring & auto-reconnect on failure ──
    peer.on('connect', () => {
        console.log(`[${userId}] Peer connected ✓`);
    });

    peer._pc && watchIceState(peer._pc, userId, userName, initiator);

    peer.on('error', (err) => {
        console.warn(`[${userId}] Peer error:`, err.message);
        if (document.getElementById(`box-${userId}`)) {
            // Attempt reconnect only if the video box still exists
            setTimeout(() => attemptReconnect(userId, userName), 2000);
        }
    });

    peer.on('close', () => {
        console.log(`[${userId}] Peer closed`);
    });

    peers[userId] = peer;

    // Flush any buffered signals that arrived before peer was ready
    if (pendingSignals[userId]) {
        pendingSignals[userId].forEach(sig => {
            try { peer.signal(sig); } catch (e) {}
        });
        delete pendingSignals[userId];
    }

    return peer;
}

// ── FIX: Watch RTCPeerConnection ice state for freeze/disconnect ──
function watchIceState(pc, userId, userName, wasInitiator) {
    pc.addEventListener('connectionstatechange', () => {
        const state = pc.connectionState;
        console.log(`[${userId}] Connection state: ${state}`);
        if (state === 'failed' || state === 'disconnected') {
            setTimeout(() => {
                if (document.getElementById(`box-${userId}`)) {
                    console.log(`[${userId}] Reconnecting due to ${state}...`);
                    attemptReconnect(userId, userName);
                }
            }, 1500);
        }
    });

    pc.addEventListener('iceconnectionstatechange', () => {
        const state = pc.iceConnectionState;
        console.log(`[${userId}] ICE state: ${state}`);
        if (state === 'failed') {
            // Request ICE restart via signal
            if (wasInitiator && peers[userId] && peers[userId]._pc) {
                try {
                    peers[userId]._pc.restartIce();
                } catch (e) {
                    attemptReconnect(userId, userName);
                }
            }
        }
    });
}

function attemptReconnect(userId, userName) {
    if (!localStream || !document.getElementById(`box-${userId}`)) return;
    console.log(`[${userId}] Attempting peer reconnect...`);
    socket.emit('request-reconnect', { to: userId, roomCode: currentRoomCode });
    createPeer(userId, true, userName);
}

// ── FIX: Video freeze detection via frame monitoring ──
function monitorVideoHealth(userId, stream) {
    const videoEl = document.querySelector(`#box-${userId} video`);
    if (!videoEl) return;

    let lastTime = 0;
    let frozenCount = 0;

    const check = setInterval(() => {
        if (!document.getElementById(`box-${userId}`)) { clearInterval(check); return; }
        if (videoEl.paused || videoEl.ended) {
            videoEl.play().catch(() => {});
        }

        // Detect frozen frame by checking currentTime advancement
        if (videoEl.readyState >= 2 && !videoEl.paused) {
            if (videoEl.currentTime === lastTime) {
                frozenCount++;
                if (frozenCount >= 3) {
                    console.warn(`[${userId}] Video freeze detected, refreshing srcObject...`);
                    videoEl.srcObject = null;
                    videoEl.srcObject = stream;
                    videoEl.play().catch(() => {});
                    frozenCount = 0;
                }
            } else {
                frozenCount = 0;
            }
            lastTime = videoEl.currentTime;
        }
    }, 4000);
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────

socket.on('user-connected', ({ userId, userName }) => {
    showToast(`${userName} joined the call!`, "success");
    if (!localStream) return;
    createPeer(userId, true, userName);
});

socket.on('signal', (data) => {
    const userId = data.from;
    const remoteName = data.remoteName || "Participant";

    if (!peers[userId]) {
        if (!localStream) return;
        createPeer(userId, false, remoteName);
    }

    try {
        peers[userId].signal(data.signal);
    } catch (e) {
        // Buffer signal if peer is in bad state, retry after peer recreated
        console.warn(`[${userId}] Signal error, buffering:`, e.message);
        if (!pendingSignals[userId]) pendingSignals[userId] = [];
        pendingSignals[userId].push(data.signal);
    }
});

// Handle reconnect request from the other side
socket.on('reconnect-request', ({ from, fromName }) => {
    if (!localStream) return;
    createPeer(from, false, fromName || "Participant");
});

socket.on('state-changed', ({ userId, isMuted, isCamOff }) => {
    const muteIcon = document.getElementById(`mute-${userId}`);
    const camOverlay = document.getElementById(`cam-overlay-${userId}`);
    const videoEl = document.querySelector(`#box-${userId} video`);

    if (muteIcon) muteIcon.classList.toggle('d-none', !isMuted);
    if (camOverlay && videoEl) {
        camOverlay.classList.toggle('d-none', !isCamOff);
        videoEl.style.visibility = isCamOff ? 'hidden' : 'visible';
    }
});

socket.on('user-disconnected', ({ userId, userName }) => {
    showToast(`${userName} left the call.`, "info");
    if (peers[userId]) {
        try { peers[userId].destroy(); } catch (e) {}
        delete peers[userId];
    }
    delete pendingSignals[userId];
    const remoteBox = document.getElementById(`box-${userId}`);
    if (remoteBox) remoteBox.remove();
});

socket.on('room-expired', (msg) => {
    showToast(`Session Expired: ${msg}`, "error");
    setTimeout(() => { cleanUpAndRedirect(); }, 2500);
});

socket.on('error-msg', (msg) => {
    showToast(msg, "error");
    toggleLoading('btn-join', false);
    toggleLoading('btn-create', false);
});

// ─── VIDEO ELEMENT HELPERS ───────────────────────────────────────────────────

function addRemoteVideo(userId, stream, userName) {
    // If box already exists, just update the stream (reconnect case)
    const existing = document.getElementById(`box-${userId}`);
    if (existing) {
        const vid = existing.querySelector('video');
        if (vid) {
            vid.srcObject = stream;
            vid.play().catch(() => {});
        }
        return;
    }

    const videoGrid = document.getElementById('video-grid');
    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = `box-${userId}`;

    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.srcObject = stream;

    // ── FIX: Ensure audio plays – unmute explicitly and handle autoplay policy ──
    video.muted = false;
    video.volume = 1.0;

    video.onloadedmetadata = () => {
        video.play().catch(err => {
            console.warn("Autoplay blocked, adding click-to-play fallback:", err);
            // Show a gentle overlay so user can tap to unmute
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
    videoGrid.appendChild(container);
}

// ── FIX: Autoplay policy workaround – tap-to-play overlay ──
function showUnmuteOverlay(container, video) {
    if (container.querySelector('.tap-play')) return;
    const tapBtn = document.createElement('div');
    tapBtn.className = 'tap-play';
    tapBtn.style.cssText = `
        position:absolute; top:0; left:0; width:100%; height:100%;
        background:rgba(0,0,0,0.55); z-index:10; display:flex;
        align-items:center; justify-content:center; cursor:pointer;
        flex-direction:column; gap:10px; color:white; font-size:14px;
        border-radius:12px;
    `;
    tapBtn.innerHTML = `<i class="fas fa-volume-up" style="font-size:32px"></i><span>Tap to Enable Audio</span>`;
    tapBtn.onclick = () => {
        video.muted = false;
        video.play().then(() => { tapBtn.remove(); }).catch(() => {});
    };
    container.appendChild(tapBtn);
}

function showCallPanel() {
    document.getElementById('setup-panel').classList.add('d-none');
    document.getElementById('call-panel').classList.remove('d-none');
}

function toggleMute() {
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;
    const localMuteIcon = document.getElementById('local-mute-icon');
    audioTrack.enabled = !audioTrack.enabled;
    const muted = !audioTrack.enabled;
    document.getElementById('btn-mute').innerText = muted ? "Unmute" : "Mute";
    if (localMuteIcon) localMuteIcon.classList.toggle('d-none', !muted);
    showToast(muted ? "Microphone Silenced" : "Microphone Active", muted ? "info" : "success");

    const videoTrack = localStream.getVideoTracks()[0];
    socket.emit('update-state', { roomCode: currentRoomCode, isMuted: muted, isCamOff: !videoTrack?.enabled });
}

function toggleCamera() {
    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) return;
    const localCamOverlay = document.getElementById('local-cam-overlay');
    const localVideoElement = document.getElementById('local-video');
    videoTrack.enabled = !videoTrack.enabled;
    const camOff = !videoTrack.enabled;
    document.getElementById('btn-camera').innerText = camOff ? "Start Video" : "Stop Video";
    if (localCamOverlay) localCamOverlay.classList.toggle('d-none', !camOff);
    if (localVideoElement) localVideoElement.style.visibility = camOff ? 'hidden' : 'visible';
    showToast(camOff ? "Video Feed Hidden" : "Video Feed Transmitting", camOff ? "info" : "success");

    const audioTrack = localStream.getAudioTracks()[0];
    socket.emit('update-state', { roomCode: currentRoomCode, isMuted: !audioTrack?.enabled, isCamOff: camOff });
}

function confirmEndCall() {
    if (confirm("Do you want to end call? Doing so will instantly destroy the session.")) {
        cleanUpAndRedirect();
    }
}

function cleanUpAndRedirect() {
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); }
    Object.keys(peers).forEach(userId => { try { peers[userId].destroy(); } catch (e) {} });
    peers = {};
    pendingSignals = {};
    window.location.href = window.location.origin;
}

window.onload = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
        switchTab('join');
        document.getElementById('join-code').value = roomParam;
        showToast("Room invitation applied automatically!", "success");
    }
};
