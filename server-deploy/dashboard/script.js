const socket = io();
const video   = document.getElementById('remote-video');

let peerConnection = null;
let dataChannel    = null;
let targetClientId = null;
let agentName      = '';
let logOpen        = false;

const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

function log(msg) {
  const el = document.getElementById('debug-logs');
  if (!el) return;
  const div = document.createElement('div');
  div.textContent = `> ${new Date().toLocaleTimeString()}: ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// â”€â”€ Log toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.getElementById('log-toggle').addEventListener('click', () => {
  logOpen = !logOpen;
  document.getElementById('log-body').style.display = logOpen ? 'block' : 'none';
  document.getElementById('log-chevron').textContent = logOpen ? 'â–´' : 'â–¾';
});

// â”€â”€ Server connection status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const serverIndicator = document.getElementById('server-indicator');

socket.on('connect', () => {
  serverIndicator.classList.remove('offline');
  log('Connected to server');
  // Auto-login after page refresh if credentials are saved
  if (document.getElementById('login-screen').style.display !== 'none') {
    const savedName = sessionStorage.getItem('ts_agent_name');
    const savedPwd  = sessionStorage.getItem('ts_agent_pwd');
    if (savedName && savedPwd) {
      agentName = savedName;
      socket.emit('register', { type: 'support', password: savedPwd, name: savedName });
    }
  }
});

socket.on('disconnect', () => {
  serverIndicator.classList.add('offline');
  log('Disconnected from server');
});

// â”€â”€ Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('admin-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

function doLogin() {
  const name = document.getElementById('admin-name').value.trim();
  const pwd  = document.getElementById('admin-password').value;
  const err  = document.getElementById('login-error');
  if (!name || !pwd) {
    err.textContent = 'Please enter your name and password.';
    err.style.display = 'block';
    return;
  }
  agentName = name;
  sessionStorage.setItem('ts_agent_name', name);
  sessionStorage.setItem('ts_agent_pwd', pwd);
  socket.emit('register', { type: 'support', password: pwd, name });
}

socket.on('login_success', () => {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'flex';
  document.getElementById('agent-row').textContent = `Signed in as ${agentName}`;

  // Set up the download link
  const base = window.location.origin;
  document.getElementById('copy-url').textContent = base + '/download.html';
  document.getElementById('btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(base + '/download.html').then(() => {
      const btn = document.getElementById('btn-copy');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });

  log('Login successful â€” welcome, ' + agentName);
});

// Fired when logging back in restores a preserved session
socket.on('session_restored', (data) => {
  targetClientId = data.clientId;
  document.getElementById('session-client-name').textContent = data.clientId;
  log('Session restored with ' + data.clientId + ' â€” reconnecting video...');
  // Client will send a fresh WebRTC offer via support_request
});

socket.on('login_error', (msg) => {
  sessionStorage.removeItem('ts_agent_name');
  sessionStorage.removeItem('ts_agent_pwd');
  const err = document.getElementById('login-error');
  err.textContent = 'Login failed: ' + msg;
  err.style.display = 'block';
});

// â”€â”€ Client list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
socket.on('clients_list', (clients) => {
  const countEl = document.getElementById('client-count');
  const listEl  = document.getElementById('client-list');

  countEl.textContent = clients.length;

  if (clients.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No clients available.<br>Clients must click <strong>"Allow Support Access"</strong> in their app.</div>';
    return;
  }

  listEl.innerHTML = '';
  clients.forEach(client => {
    const isMySession = client.isBusy && client.agentName === agentName;
    const isActive    = targetClientId === client.id;

    const div = document.createElement('div');
    div.className = `client-item${isActive ? ' active' : ''}${client.isBusy && !isMySession ? ' busy' : ''}`;

    let statusText = 'Available â€” click to connect';
    if (isMySession) statusText = 'In session with you';
    else if (client.isBusy) statusText = `In session with ${client.agentName}`;

    div.innerHTML = `
      <div class="client-item-name">${client.id}</div>
      <div class="client-item-status">${statusText}</div>
    `;

    if (!client.isBusy || isMySession) {
      div.addEventListener('click', () => {
        if (targetClientId === client.id) return;
        connectToClient(client.id);
      });
    }

    listEl.appendChild(div);
  });
});

// â”€â”€ Session blocked â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
socket.on('session_blocked', (msg) => {
  log('Blocked: ' + msg);
  alert('Cannot connect: ' + msg);
});

// â”€â”€ Connect to client â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function connectToClient(clientId) {
  if (peerConnection) closeConnection();
  targetClientId = clientId;
  document.getElementById('session-client-name').textContent = clientId;
  log('Requesting connection to ' + clientId);
  socket.emit('request_connection', clientId);
}

// â”€â”€ Disconnect button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.getElementById('disconnect-btn').addEventListener('click', closeConnection);

function closeConnection() {
  log('Ending session...');
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (dataChannel)    { dataChannel.close();    dataChannel = null;    }
  if (targetClientId) {
    socket.emit('end_session', targetClientId);
    targetClientId = null;
  }
  video.srcObject = null;
  showPlaceholder();
  log('Session ended.');
}

// â”€â”€ Session ended by server (client disconnected) â”€â”€
socket.on('session_ended', () => {
  log('Session ended (remote side)');
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (dataChannel)    { dataChannel.close();    dataChannel = null;    }
  targetClientId = null;
  video.srcObject = null;
  showPlaceholder();
});

// â”€â”€ Fullscreen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.getElementById('fullscreen-btn').addEventListener('click', () => {
  const wrapper = document.getElementById('video-wrapper');
  if (!document.fullscreenElement) {
    wrapper.requestFullscreen().catch(() => video.requestFullscreen());
  } else {
    document.exitFullscreen();
  }
});

// â”€â”€ WebRTC â€” receive offer from client â”€â”€â”€
socket.on('offer', async (data) => {
  log('WebRTC offer received from client');
  peerConnection = new RTCPeerConnection(iceConfig);

  peerConnection.ontrack = (event) => {
    log('Video stream received');
    if (video.srcObject !== event.streams[0]) {
      video.srcObject = event.streams[0];
      showVideo();
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { target: data.sender, candidate: event.candidate });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    log('ICE state: ' + peerConnection.iceConnectionState);
  };

  peerConnection.ondatachannel = (event) => {
    dataChannel = event.channel;
    dataChannel.onopen = () => log('Input channel open â€” remote control active');
  };

  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('answer', { target: data.sender, sdp: answer });
  log('WebRTC answer sent');
});

socket.on('answer', async (data) => {
  if (peerConnection) {
    try { await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp)); }
    catch (e) { log('Answer error: ' + e.message); }
  }
});

socket.on('ice-candidate', async (data) => {
  if (peerConnection) {
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); }
    catch (e) {}
  }
});

// â”€â”€ Force reset â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.getElementById('force-reset-btn').addEventListener('click', () => {
  if (confirm('Disconnect ALL active sessions? Clients will need to re-enable access.')) {
    socket.emit('force_reset_all');
  }
});

socket.on('server_reset', () => {
  alert('Server was reset. Page will reload.');
  window.location.reload();
});

// â”€â”€ UI helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showVideo() {
  document.getElementById('placeholder').style.display = 'none';
  document.getElementById('video-topbar').style.display = 'flex';
}

function showPlaceholder() {
  document.getElementById('placeholder').style.display = 'flex';
  document.getElementById('video-topbar').style.display = 'none';
}

// â”€â”€ Remote input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const throttle = (fn, ms) => {
  let t;
  return (...args) => {
    if (t) return;
    fn(...args);
    t = setTimeout(() => (t = null), ms);
  };
};

const sendMouseMove = throttle((e) => {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  const r = video.getBoundingClientRect();
  dataChannel.send(JSON.stringify({
    type: 'mousemove',
    x: (e.clientX - r.left) / r.width,
    y: (e.clientY - r.top)  / r.height
  }));
}, 30);

video.addEventListener('mousemove', sendMouseMove);

video.addEventListener('mousedown', (e) => {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  const btn = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
  dataChannel.send(JSON.stringify({ type: 'mousedown', button: btn }));
});

video.addEventListener('mouseup', (e) => {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  const btn = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
  dataChannel.send(JSON.stringify({ type: 'mouseup', button: btn }));
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
