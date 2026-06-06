const socket = io();
let localStream;
let currentRoomCode = "";
let myUserName = "";
let peers = {};
let pendingSignals = {};
let userNames = {};

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
}

async function startMedia() {
    if (localStream) return;

    const constraints = {
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user", frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    };

    const getUserMedia = (
        navigator.mediaDevices && navigator.mediaDevices.getUserMedia
            ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
            : (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia)
                ? (c) => new Promise((res, rej) => {
                    (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia).call(navigator, c, res, rej);
                  })
                : null
    );

    if (!getUserMedia) {
        showToast("Your browser does not support video calls. Please use Chrome, Firefox, or Edge.", "error");
        throw new Error("getUserMedia not supported");
    }

    try {
        localStream = await getUserMedia(constraints);
    } catch (err) {
        try {
            localStream = await getUserMedia({ video: true, audio: true });
        } catch (err2) {
            try {
                localStream = await getUserMedia({ video: false, audio: true });
                showToast("Camera not available — joining with audio only.", "info");
            } catch (err3) {
                let msg = "Camera & Microphone access denied.";
                if (err3.name === 'NotAllowedError' || err3.name === 'PermissionDeniedError') {
                    msg = "Permission denied! Please allow Camera & Mic in browser settings and reload.";
                } else if (err3.name === 'NotFoundError' || err3.name === 'DevicesNotFoundError') {
                    msg = "No camera or microphone found on this device.";
                } else if (err3.name === 'NotReadableError' || err3.name === 'TrackStartError') {
                    msg = "Camera/Mic is being used by another app. Close it and try again.";
                } else if (err3.name === 'OverconstrainedError') {
                    msg = "Camera constraints not supported on this device.";
                }
                showToast(msg, "error");
                throw err3;
            }
        }
    }

    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;

    try { await localVideo.play(); } catch (e) {}
}

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

socket.on('room-created', async (code) => {
    try {
        await startMedia();
        document.getElementById('local-name-tag').innerText = `${myUserName} (You)`;
        try { navigator.clipboard.writeText(`${window.location.origin}?room=${code}`); } catch(e) {}
        showToast(`Room [${code}] Created!`, "success");
        showToast("Share link copied to clipboard!", "info");
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

socket.on('existing-users', ({ users }) => {
    users.forEach(({ userId, userName }) => {
        userNames[userId] = userName;
        createPeer(userId, true, userName);
    });
});

socket.on('user-connected', ({ userId, userName }) => {
    showToast(`${userName} joined the call!`, "success");
    if (!localStream) return;
    userNames[userId] = userName;
    createPeer(userId, false, userName);
});

function createPeer(userId, initiator, userName) {
    if (peers[userId]) {
        try { peers[userId].destroy(); } catch (e) {}
        delete peers[userId];
    }

    const iceServers = [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: ['stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302'] },
        { urls: 'stun:global.stun.twilio.com:3478' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ];

    const peer = new SimplePeer({
        initiator,
        trickle: true,
        stream: localStream,
        config: { iceServers, iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' },
        offerOptions: { offerToReceiveAudio: true, offerToReceiveVideo: true }
    });

    peer.on('signal', (data) => {
        socket.emit('signal', { to: userId, signal: data });
    });

    peer.on('stream', (remoteStream) => {
        addRemoteVideo(userId, remoteStream, userName);
        monitorVideoHealth(userId, remoteStream);
        const audio = localStream && localStream.getAudioTracks()[0];
        const video = localStream && localStream.getVideoTracks()[0];
        socket.emit('update-state', {
            roomCode: currentRoomCode,
            isMuted: audio ? !audio.enabled : true,
            isCamOff: video ? !video.enabled : true
        });
    });

    if (peer._pc) {
        peer._pc.ontrack = (event) => {
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
        };
    }

    peer.on('connect', () => {
        console.log(`[✓] Connected: ${userName} (${userId})`);
    });

    peer.on('error', (err) => {
        console.warn(`[!] Peer error ${userId}:`, err.message);
        if (document.getElementById(`box-${userId}`)) {
            setTimeout(() => attemptReconnect(userId, userName), 2000);
        }
    });

    peer.on('close', () => {
        console.log(`[x] Peer closed: ${userId}`);
    });

    peers[userId] = peer;

    if (pendingSignals[userId] && pendingSignals[userId].length) {
        const toFlush = pendingSignals[userId].splice(0);
        toFlush.forEach(sig => {
            try { peer.signal(sig); } catch (e) {}
        });
        delete pendingSignals[userId];
    }

    return peer;
}

socket.on('signal', (data) => {
    const userId = data.from;
    const remoteName = data.remoteName || userNames[userId] || "Participant";

    if (!peers[userId]) {
        if (!localStream) {
            if (!pendingSignals[userId]) pendingSignals[userId] = [];
            pendingSignals[userId].push(data.signal);
            return;
        }
        userNames[userId] = remoteName;
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
    showToast(`${userName} left the call.`, "info");
    try { if (peers[userId]) peers[userId].destroy(); } catch (e) {}
    delete peers[userId];
    delete pendingSignals[userId];
    delete userNames[userId];
    const box = document.getElementById(`box-${userId}`);
    if (box) box.remove();
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

    video.onclick = () => {
        video.muted = false;
        playVideo(video);
    };

    const overlay = document.createElement('div');
    overlay.className = 'camera-off-overlay d-none';
    overlay.id = `cam-overlay-${userId}`;
    overlay.innerHTML = '<i class="fas fa-video-slash"></i>';

    const tag = document.createElement('div');
    tag.className = 'name-tag';
    tag.innerHTML = `<span>${userName}</span><i class="fas fa-microphone-slash mute-icon d-none" id="mute-${userId}"></i>`;

    container.appendChild(video);
    container.appendChild(overlay);
    container.appendChild(tag);
    grid.appendChild(container);
}

function showUnmuteOverlay(container, video) {
    if (!container || container.querySelector('.tap-play')) return;
    const btn = document.createElement('div');
    btn.className = 'tap-play';
    btn.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);
        z-index:10;display:flex;align-items:center;justify-content:center;cursor:pointer;
        flex-direction:column;gap:10px;color:white;font-size:14px;border-radius:12px;`;
    btn.innerHTML = '<i class="fas fa-volume-up" style="font-size:32px"></i><span>Tap to Enable Audio</span>';
    btn.onclick = () => {
        video.muted = false;
        video.volume = 1.0;
        playVideo(video);
        btn.remove();
    };
    container.appendChild(btn);
}

function monitorVideoHealth(userId, stream) {
    const getVideo = () => document.querySelector(`#box-${userId} video`);
    let lastTime = -1;
    let frozenCount = 0;

    const check = setInterval(() => {
        const box = document.getElementById(`box-${userId}`);
        if (!box) { clearInterval(check); return; }

        const videoEl = getVideo();
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

function attemptReconnect(userId, userName) {
    if (!localStream || !document.getElementById(`box-${userId}`)) return;
    socket.emit('request-reconnect', { to: userId, roomCode: currentRoomCode });
    createPeer(userId, true, userName || userNames[userId] || "Participant");
}

function toggleMute() {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    document.getElementById('btn-mute').innerText = muted ? "Unmute" : "Mute";
    const icon = document.getElementById('local-mute-icon');
    if (icon) icon.classList.toggle('d-none', !muted);
    showToast(muted ? "Microphone Silenced" : "Microphone Active", muted ? "info" : "success");
    const vt = localStream.getVideoTracks()[0];
    socket.emit('update-state', { roomCode: currentRoomCode, isMuted: muted, isCamOff: vt ? !vt.enabled : true });
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
    showToast(off ? "Video Feed Hidden" : "Video Feed Transmitting", off ? "info" : "success");
    const at = localStream.getAudioTracks()[0];
    socket.emit('update-state', { roomCode: currentRoomCode, isMuted: at ? !at.enabled : true, isCamOff: off });
}

function confirmEndCall() {
    if (confirm("End call? This will destroy the session.")) cleanUpAndRedirect();
}

function cleanUpAndRedirect() {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    Object.values(peers).forEach(p => { try { p.destroy(); } catch (e) {} });
    peers = {};
    pendingSignals = {};
    userNames = {};
    window.location.href = window.location.origin;
}

window.onload = () => {
    const room = new URLSearchParams(window.location.search).get('room');
    if (room) {
        switchTab('join');
        document.getElementById('join-code').value = room;
        showToast("Room invitation applied automatically!", "success");
    }
};
