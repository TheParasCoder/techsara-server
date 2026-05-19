const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// clientId -> { socketId, available }
const clients = new Map();
// socketId -> { name, targetClientId }
const supports = new Map();
// clientId -> supportSocketId
const activeSessions = new Map();

app.use(express.static(path.join(__dirname, 'dashboard')));

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', clients: clients.size, time: new Date().toISOString() });
});

// Redirect to GitHub Release for installer download
app.get('/download/windows', (req, res) => {
  res.redirect('https://github.com/TheParasCoder/techsara-server/releases/latest/download/TechsaraSupport-Setup.exe');
});

app.get('/download/mac', (req, res) => {
  res.status(501).send('MacOS support coming soon');
});

app.get('/debug', (req, res) => {
  res.json({
    clients: Array.from(clients.entries()).map(([id, c]) => ({ id, socketId: c.socketId, available: c.available })),
    supports: Array.from(supports.entries()),
    activeSessions: Array.from(activeSessions.entries()),
    serverTime: new Date().toISOString()
  });
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Central session cleanup — called from any disconnect/end path
function endSession(clientId, reason) {
  const supportSocketId = activeSessions.get(clientId);
  activeSessions.delete(clientId);

  const clientData = clients.get(clientId);
  if (clientData) clientData.available = false;

  if (supportSocketId) {
    const sup = supports.get(supportSocketId);
    if (sup) sup.targetClientId = null;
    io.to(supportSocketId).emit('session_ended', { clientId, reason });
  }

  if (clientData) {
    io.to(clientData.socketId).emit('session_ended', { reason });
  }

  console.log(`Session ended: ${clientId} — reason: ${reason}`);
  broadcastClients();
}

// Only broadcast clients that have enabled access
function broadcastClients() {
  const clientList = Array.from(clients.entries())
    .filter(([, c]) => c.available)
    .map(([id, c]) => ({
      id,
      isBusy: activeSessions.has(id),
      agentName: activeSessions.has(id)
        ? (supports.get(activeSessions.get(id))?.name || 'Agent')
        : null
    }));

  for (const socketId of supports.keys()) {
    io.to(socketId).emit('clients_list', clientList);
  }
}

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('register', (data) => {
    if (data.type === 'client') {
      clients.set(data.clientId, { socketId: socket.id, available: false });
      socket.clientId = data.clientId;
      console.log(`Client registered: ${data.clientId} (access not yet granted)`);

    } else if (data.type === 'support') {
      if (data.password === 'admin123') {
        const agentName = (data.name || 'Agent').trim();

        for (const [sid, sup] of supports.entries()) {
          if (sup.name === agentName && sid !== socket.id) {
            if (sup.targetClientId) activeSessions.delete(sup.targetClientId);
            supports.delete(sid);
          }
        }

        supports.set(socket.id, { name: agentName, targetClientId: null });
        console.log(`Support agent registered: ${agentName}`);
        socket.emit('login_success');
        broadcastClients();
      } else {
        socket.emit('login_error', 'Invalid password');
      }
    }
  });

  // Client enables or disables support access
  socket.on('set_availability', (data) => {
    const clientData = clients.get(socket.clientId);
    if (!clientData) return;
    clientData.available = !!data.available;
    console.log(`Client ${socket.clientId} set availability: ${clientData.available}`);
    broadcastClients();
  });

  // Support agent requests to connect to a client
  socket.on('request_connection', (clientId) => {
    const support = supports.get(socket.id);
    if (!support) return;

    const clientData = clients.get(clientId);
    if (!clientData || !clientData.available) {
      return socket.emit('session_blocked', 'Client has not enabled support access');
    }

    const existingSocketId = activeSessions.get(clientId);
    if (existingSocketId && existingSocketId !== socket.id) {
      const existingAgent = supports.get(existingSocketId);
      if (existingAgent && existingAgent.name !== support.name) {
        return socket.emit('session_blocked', `Client is busy with ${existingAgent.name}`);
      }
    }

    activeSessions.set(clientId, socket.id);
    support.targetClientId = clientId;

    io.to(clientData.socketId).emit('support_request', {
      supportId: socket.id,
      agentName: support.name
    });

    console.log(`Session started: ${support.name} -> ${clientId}`);
    broadcastClients();
  });

  // Support ends the session
  socket.on('end_session', (clientId) => {
    endSession(clientId, 'agent_ended');
  });

  // Client ends the session from their side
  socket.on('client_disconnect', () => {
    if (socket.clientId && activeSessions.has(socket.clientId)) {
      endSession(socket.clientId, 'client_ended');
    }
  });

  // WebRTC relay
  socket.on('offer',         (data) => io.to(data.target).emit('offer',         { sender: socket.id, sdp: data.sdp }));
  socket.on('answer',        (data) => io.to(data.target).emit('answer',        { sender: socket.id, sdp: data.sdp }));
  socket.on('ice-candidate', (data) => io.to(data.target).emit('ice-candidate', { sender: socket.id, candidate: data.candidate }));

  socket.on('force_reset_all', () => {
    console.log('Force reset by', socket.id);
    activeSessions.clear();
    clients.forEach(c => { c.available = false; });
    io.emit('server_reset');
    broadcastClients();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);

    if (socket.clientId) {
      if (activeSessions.has(socket.clientId)) {
        endSession(socket.clientId, 'client_offline');
      }
      clients.delete(socket.clientId);
      broadcastClients();
    }

    if (supports.has(socket.id)) {
      const sup = supports.get(socket.id);
      if (sup.targetClientId) {
        endSession(sup.targetClientId, 'agent_offline');
      }
      supports.delete(socket.id);
      broadcastClients();
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
