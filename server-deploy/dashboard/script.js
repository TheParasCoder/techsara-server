const socket = io();
const video = document.getElementById('remote-video');
const clientList = document.getElementById('client-list');
const clientCount = document.getElementById('client-count');
const disconnectBtn = document.getElementById('disconnect-btn');
const adminPassword = document.getElementById('admin-password');
const loginBtn = document.getElementById('login-btn');
const loginContainer = document.getElementById('login-container');
const dashboardControls = document.getElementById('dashboard-controls');
const connectionStatus = document.getElementById('connection-status');
const videoControls = document.getElementById('video-controls');
const placeholder = document.getElementById('placeholder');
const forceResetBtn = document.getElementById('force-reset-btn');
const debugLogs = document.getElementById('debug-logs');

function log(msg) {
    const div = document.createElement('div');
    div.textContent = `> ${new Date().toLocaleTimeString()}: ${msg}`;
    debugLogs.appendChild(div);
    debugLogs.scrollTop = debugLogs.scrollHeight;
}

forceResetBtn.addEventListener('click', () => {
    if (confirm('This will disconnect ALL clients and ALL support agents. Are you sure?')) {
        socket.emit('force_reset_all');
    }
});

socket.on('server_reset', () => {
    alert('Server was reset by an admin. Page will reload.');
    window.location.reload();
});

let peerConnection;
let dataChannel;
let targetClientId = null;

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { 
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

socket.on('connect', () => {
    connectionStatus.style.display = 'block';
    log('Connected to signaling server');
});

loginBtn.addEventListener('click', () => {
    const pwd = adminPassword.value;
    const name = document.getElementById('admin-name').value;
    if (!pwd || !name) return alert('Please enter name and password');
    socket.emit('register', { type: 'support', password: pwd, name: name });
});

socket.on('login_success', () => {
    log('Login successful');
    loginContainer.style.display = 'none';
    dashboardControls.style.display = 'block';
});

socket.on('login_error', (msg) => {
    log('Login failed: ' + msg);
    alert('Login Failed: ' + msg);
});

socket.on('session_blocked', (msg) => {
    log('Session blocked: ' + msg);
    alert('Cannot connect: ' + msg);
});

socket.on('clients_list', (clients) => {
    clientCount.textContent = clients.length;
    clientList.innerHTML = '';
    
    if (clients.length === 0) {
        clientList.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem; text-align: center; margin-top: 2rem;">No clients online</p>';
        return;
    }

    clients.forEach(client => {
        const currentAgentName = document.getElementById('admin-name').value;
        const isMe = client.isBusy && client.agentName === currentAgentName;

        const div = document.createElement('div');
        div.className = `client-item ${targetClientId === client.id ? 'active' : ''} ${client.isBusy ? 'busy' : ''}`;
        
        let statusHtml = '<div style="font-size: 0.75rem; color: var(--success);">Available</div>';
        if (client.isBusy) {
            statusHtml = `<div style="font-size: 0.75rem; color: var(--danger);">Busy (with ${client.agentName}) ${isMe ? '<strong>[YOU]</strong>' : ''}</div>`;
        }

        div.innerHTML = `
            <div style="font-weight: 600; font-size: 0.9rem;">${client.id}</div>
            ${statusHtml}
        `;
        
        if (!client.isBusy || isMe || targetClientId === client.id) {
            div.addEventListener('click', () => {
                if (targetClientId === client.id) return;
                connectToClient(client.id);
            });
        } else {
            div.style.opacity = '0.6';
            div.style.cursor = 'not-allowed';
        }
        clientList.appendChild(div);
    });
});

function connectToClient(clientId) {
    if (peerConnection) closeConnection();
    
    targetClientId = clientId;
    log('Starting session with ' + clientId);
    
    // UI Update
    document.querySelectorAll('.client-item').forEach(el => {
        el.classList.remove('active');
        if (el.innerText.includes(clientId)) el.classList.add('active');
    });

    placeholder.style.display = 'none';
    videoControls.style.display = 'flex';

    socket.emit('request_connection', clientId);
}

disconnectBtn.addEventListener('click', () => {
    closeConnection();
});

function closeConnection() {
    log('Closing connection...');
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    if (targetClientId) {
        socket.emit('end_session', targetClientId);
    }
    
    video.srcObject = null;
    targetClientId = null;
    placeholder.style.display = 'flex';
    videoControls.style.display = 'none';
    
    document.querySelectorAll('.client-item').forEach(el => el.classList.remove('active'));
    log('Session ended.');
}

socket.on('offer', async (data) => {
    log('Received WebRTC offer from client');
    
    peerConnection = new RTCPeerConnection(configuration);
    
    peerConnection.ontrack = (event) => {
        log('Remote track received!');
        if (video.srcObject !== event.streams[0]) {
            video.srcObject = event.streams[0];
            log('Video stream attached to element');
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { target: data.sender, candidate: event.candidate });
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        log('ICE State: ' + peerConnection.iceConnectionState);
    };

    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        dataChannel.onopen = () => log('Data channel (Input) opened');
    };

    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer', { target: data.sender, sdp: answer });
    log('Sent WebRTC answer to client');
});

socket.on('ice-candidate', async (data) => {
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            console.error('Error adding ICE candidate', e);
        }
    }
});

// Input capturing with throttling for smoothness
function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    }
}

const handleMouseMove = throttle((e) => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    const rect = video.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    dataChannel.send(JSON.stringify({ type: 'mousemove', x, y }));
}, 30);

video.addEventListener('mousemove', handleMouseMove);

video.addEventListener('mousedown', (e) => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    const button = e.button === 0 ? 'left' : (e.button === 2 ? 'right' : 'middle');
    dataChannel.send(JSON.stringify({ type: 'mousedown', button }));
});

video.addEventListener('mouseup', (e) => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    const button = e.button === 0 ? 'left' : (e.button === 2 ? 'right' : 'middle');
    dataChannel.send(JSON.stringify({ type: 'mouseup', button }));
});

video.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('keydown', (e) => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    dataChannel.send(JSON.stringify({ type: 'keydown', key: e.key, code: e.code }));
});

window.addEventListener('keyup', (e) => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    dataChannel.send(JSON.stringify({ type: 'keyup', key: e.key, code: e.code }));
});
