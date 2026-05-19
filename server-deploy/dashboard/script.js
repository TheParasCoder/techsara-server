const socket = io();
const video   = document.getElementById('remote-video');

let peerConnection = null;
let dataChannel    = null;
let targetClientId = null;
let agentName      = '';
let logOpen        = false;

// Remote control toggles (on by default)
let mouseEnabled    = true;
let keyboardEnabled = true;

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
  showVideo();  // Show topbar immediately so Reconnect button is visible
  log('Session restored with ' + data.clientId + ' â€” waiting for client to reconnect...');
  // Close any stale peer â€” server already sends support_request to client
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (dataChannel)    { dataChannel.close();    dataChannel = null;    }
  video.srcObject = null;
  // NOTE: do NOT emit request_connection here â€” server already sent support_request directly
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

  const availableCount = clients.filter(c => c.available || c.isBusy).length;
  countEl.textContent = availableCount;

  if (clients.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No clients yet.<br>Share the download link so clients install the app.</div>';
    return;
  }

  listEl.innerHTML = '';
  clients.forEach(client => {
    const isMySession = client.isBusy && client.agentName === agentName;
    const isActive    = targetClientId === client.id;
    const isOffline   = !client.online;
    const isUnavail   = client.online && !client.available && !client.isBusy;

    let extraClass = '';
    if (isActive) extraClass = ' active';
    else if (client.isBusy && !isMySession) extraClass = ' busy';
    else if (isOffline) extraClass = ' offline';
    else if (isUnavail) extraClass = ' unavailable';

    const div = document.createElement('div');
    div.className = 'client-item' + extraClass;

    let statusText = 'Available â€” click to connect';
    let statusClass = '';
    if (isMySession)       { statusText = 'In session with you'; }
    else if (client.isBusy){ statusText = `In session with ${client.agentName}`; }
    else if (isOffline)    { statusText = 'App is closed â€” will reconnect automatically'; statusClass = 'status-offline'; }
    else if (isUnavail)    { statusText = 'Ask client to click "Allow Support Access"'; statusClass = 'status-unavail'; }

    div.innerHTML = `
      <div class="client-item-name">${client.id}</div>
      <div class="client-item-status ${statusClass}">${statusText}</div>
    `;

    if ((client.available && !client.isBusy) || isMySession) {
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

// â”€â”€ Reconnect button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.getElementById('reconnect-btn').addEventListener('click', reconnectVideo);

function reconnectVideo() {
  if (!targetClientId) return;
  log('Forcing video reconnect...');
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (dataChannel)    { dataChannel.close();    dataChannel = null;    }
  video.srcObject = null;
  socket.emit('request_connection', targetClientId);
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
    dataChannel.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'clipboard_content') {
          if (!msg.text) { showToast('Client clipboard is empty', true); return; }
          navigator.clipboard.writeText(msg.text).then(() => {
            showToast('Client clipboard copied âœ“');
            log('Got client clipboard (' + msg.text.length + ' chars)');
          }).catch(() => showToast('Could not write to your clipboard', true));
        }
      } catch (_) {}
    };
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

// â”€â”€ Client went offline (session preserved) â”€â”€
socket.on('client_reconnecting', (data) => {
  log('Client ' + data.clientId + ' went offline â€” session preserved, waiting to reconnect...');
});

// â”€â”€ Client came back online â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
socket.on('client_reconnected', (data) => {
  log('Client ' + data.clientId + ' is back online â€” video reconnecting...');
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (dataChannel)    { dataChannel.close();    dataChannel = null;    }
  video.srcObject = null;
  // Client will send a fresh offer
});

// â”€â”€ Controls bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.getElementById('ctrl-mouse').addEventListener('click', () => {
  mouseEnabled = !mouseEnabled;
  const btn = document.getElementById('ctrl-mouse');
  btn.textContent = mouseEnabled ? 'ðŸ–± Mouse: ON' : 'ðŸ–± Mouse: OFF';
  btn.className = 'ctrl-toggle' + (mouseEnabled ? ' ctrl-on' : ' ctrl-off');
  log('Mouse control: ' + (mouseEnabled ? 'ON' : 'OFF'));
});

document.getElementById('ctrl-keyboard').addEventListener('click', () => {
  keyboardEnabled = !keyboardEnabled;
  const btn = document.getElementById('ctrl-keyboard');
  btn.textContent = keyboardEnabled ? 'âŒ¨ Keyboard: ON' : 'âŒ¨ Keyboard: OFF';
  btn.className = 'ctrl-toggle' + (keyboardEnabled ? ' ctrl-on' : ' ctrl-off');
  log('Keyboard control: ' + (keyboardEnabled ? 'ON' : 'OFF'));
});

document.getElementById('ctrl-send-clip').addEventListener('click', async () => {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { showToast('Your clipboard is empty', true); return; }
    dataChannel.send(JSON.stringify({ type: 'clipboard_write', text }));
    showToast('Clipboard sent to client âœ“');
    log('Clipboard sent to client (' + text.length + ' chars)');
  } catch (e) {
    showToast('Clipboard access denied â€” allow in browser settings', true);
  }
});

document.getElementById('ctrl-get-clip').addEventListener('click', () => {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  dataChannel.send(JSON.stringify({ type: 'clipboard_request' }));
  log('Requesting clipboard from client...');
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
  document.getElementById('controls-bar').style.display = 'flex';
}

function showPlaceholder() {
  document.getElementById('placeholder').style.display = 'flex';
  document.getElementById('video-topbar').style.display = 'none';
  document.getElementById('controls-bar').style.display = 'none';
}

function showToast(msg, isError) {
  const t = document.getElementById('clip-toast');
  t.textContent = msg;
  t.style.background = isError ? 'rgba(239,68,68,0.92)' : 'rgba(16,185,129,0.92)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
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

function dc() { return dataChannel && dataChannel.readyState === 'open'; }

const sendMouseMove = throttle((e) => {
  if (!mouseEnabled || !dc()) return;
  const r = video.getBoundingClientRect();
  dataChannel.send(JSON.stringify({
    type: 'mousemove',
    x: (e.clientX - r.left) / r.width,
    y: (e.clientY - r.top)  / r.height
  }));
}, 30);

video.addEventListener('mousemove', sendMouseMove);

video.addEventListener('mousedown', (e) => {
  if (!mouseEnabled || !dc()) return;
  const btn = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
  dataChannel.send(JSON.stringify({ type: 'mousedown', button: btn }));
});

video.addEventListener('mouseup', (e) => {
  if (!mouseEnabled || !dc()) return;
  const btn = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
  dataChannel.send(JSON.stringify({ type: 'mouseup', button: btn }));
});

video.addEventListener('contextmenu', e => e.preventDefault());

video.addEventListener('wheel', (e) => {
  if (!mouseEnabled || !dc()) return;
  e.preventDefault();
  dataChannel.send(JSON.stringify({ type: 'scroll', deltaX: e.deltaX, deltaY: e.deltaY }));
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!keyboardEnabled || !dc()) return;
  // Prevent browser shortcuts from firing when sending to client
  if (e.ctrlKey || e.altKey || e.key.startsWith('F') || ['Tab','Delete','Backspace','Insert','Home','End','PageUp','PageDown'].includes(e.key)) {
    e.preventDefault();
  }
  dataChannel.send(JSON.stringify({ type: 'keydown', key: e.key, code: e.code }));
}, true);

window.addEventListener('keyup', (e) => {
  if (!keyboardEnabled || !dc()) return;
  dataChannel.send(JSON.stringify({ type: 'keyup', key: e.key, code: e.code }));
}, true);
