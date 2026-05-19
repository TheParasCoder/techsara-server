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
// agentName -> { clientId }  â€” preserved sessions (agent offline, session kept until explicit disconnect)
const reconnectTimers = new Map();

app.use(express.static(path.join(__dirname, 'dashboard')));

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', clients: clients.size, time: new Date().toISOString() });
});

app.get('/download/windows', (req, res) => {
  res.redirect('https://github.com/TheParasCoder/techsara-server/releases/latest/download/TechsaraSupport-Setup.exe');
});

app.get('/download/mac', (req, res) => {
  res.status(501).send('MacOS support coming soon');
});

app.get('/debug', (req, res) => {
  res.json({
    clients: Array.from(clients.entries()).map(([id, c]) => ({ id, available: c.available })),
    supports: Array.from(supports.entries()).map(([sid, s]) => ({ sid, name: s.name, target: s.targetClientId })),
    activeSessions: Array.from(activeSessions.entries()),
    pendingReconnects: Array.from(reconnectTimers.entries()).map(([n, p]) => ({ agent: n, client: p.clientId })),
    serverTime: new Date().toISOString()
  });
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Resolve agent name for a clientId â€” checks live sessions AND grace-period reconnects
function getSessionAgentName(clientId) {
  const sid = activeSessions.get(clientId);
  if (sid && supports.has(sid)) return supports.get(sid).name;
  for (const [name, p] of reconnectTimers) {
    if (p.clientId === clientId) return name;
  }
  return null;
}

function endSession(clientId, reason) {
  const supportSocketId = activeSessions.get(clientId);
  activeSessions.delete(clientId);

  const clientData = clients.get(clientId);
  if (clientData) clientData.available = false;

  if (supportSocketId && supports.has(supportSocketId)) {
    const sup = supports.get(supportSocketId);
    if (sup) sup.targetClientId = null;
    io.to(supportSocketId).emit('session_ended', { clientId, reason });
  }

  if (clientData) {
    io.to(clientData.socketId).emit('session_ended', { reason });
  }

  console.log(`Session ended: ${clientId} â€” reason: ${reason}`);
  broadcastClients();
}

function broadcastClients() {
  const clientList = Array.from(clients.entries())
    .filter(([, c]) => c.available)
    .map(([id]) => ({
      id,
      isBusy: activeSessions.has(id),
      agentName: getSessionAgentName(id)
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
      console.log(`Client registered: ${data.clientId}`);

    } else if (data.type === 'support') {
      if (data.password !== 'admin123') {
        return socket.emit('login_error', 'Invalid password');
      }

      const agentName = (data.name || 'Agent').trim();

      // â”€â”€ Grace-period reconnect: restore the session if timer is pending â”€â”€
      if (reconnectTimers.has(agentName)) {
        const pending = reconnectTimers.get(agentName);
        clearTimeout(pending.timer);
        reconnectTimers.delete(agentName);
        const clientId = pending.clientId;

        supports.set(socket.id, { name: agentName, targetClientId: clientId });
        activeSessions.set(clientId, socket.id);

        socket.emit('login_success');
        socket.emit('session_restored', { clientId });

        const clientData = clients.get(clientId);
        if (clientData) {
          io.to(clientData.socketId).emit('support_request', { supportId: socket.id, agentName });
        }

        console.log(`Support ${agentName} reconnected â€” session with ${clientId} restored`);
        broadcastClients();
        return;
      }

      // â”€â”€ Clear any other stale entries from the same agent name â”€â”€
      for (const [sid, sup] of supports.entries()) {
        if (sup.name === agentName && sid !== socket.id) {
          if (sup.targetClientId) activeSessions.delete(sup.targetClientId);
          supports.delete(sid);
        }
      }

      // â”€â”€ Normal login â”€â”€
      supports.set(socket.id, { name: agentName, targetClientId: null });
      console.log(`Support registered: ${agentName}`);
      socket.emit('login_success');
      broadcastClients();
    }
  });

  socket.on('set_availability', (data) => {
    const clientData = clients.get(socket.clientId);
    if (!clientData) return;
    clientData.available = !!data.available;
    console.log(`Client ${socket.clientId} availability: ${clientData.available}`);
    broadcastClients();
  });

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

    io.to(clientData.socketId).emit('support_request', { supportId: socket.id, agentName: support.name });
    console.log(`Session started: ${support.name} -> ${clientId}`);
    broadcastClients();
  });

  socket.on('end_session', (clientId) => {
    endSession(clientId, 'agent_ended');
  });

  socket.on('client_disconnect', () => {
    if (socket.clientId) {
      // Clear any preserved session for this client
      for (const [name, p] of reconnectTimers) {
        if (p.clientId === socket.clientId) {
          reconnectTimers.delete(name);
          break;
        }
      }
      if (activeSessions.has(socket.clientId)) {
        endSession(socket.clientId, 'client_ended');
      }
    }
  });

  socket.on('offer',         (data) => io.to(data.target).emit('offer',         { sender: socket.id, sdp: data.sdp }));
  socket.on('answer',        (data) => io.to(data.target).emit('answer',        { sender: socket.id, sdp: data.sdp }));
  socket.on('ice-candidate', (data) => io.to(data.target).emit('ice-candidate', { sender: socket.id, candidate: data.candidate }));

  socket.on('force_reset_all', () => {
    console.log('Force reset by', socket.id);
    reconnectTimers.clear();
    activeSessions.clear();
    clients.forEach(c => { c.available = false; });
    io.emit('server_reset');
    broadcastClients();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);

    // â”€â”€ Client disconnected â”€â”€
    if (socket.clientId) {
      if (activeSessions.has(socket.clientId)) {
        endSession(socket.clientId, 'client_offline');
      }
      clients.delete(socket.clientId);
      broadcastClients();
    }

    // â”€â”€ Support agent disconnected â”€â”€
    if (supports.has(socket.id)) {
      const sup = supports.get(socket.id);
      supports.delete(socket.id);

      if (sup.targetClientId &&
          clients.has(sup.targetClientId) &&
          activeSessions.has(sup.targetClientId)) {

        const clientId  = sup.targetClientId;
        const agentName = sup.name;

        // Notify client that agent dropped â€” session is preserved until agent reconnects
        const clientData = clients.get(clientId);
        if (clientData) {
          io.to(clientData.socketId).emit('agent_reconnecting', { agentName });
        }

        // Preserve session indefinitely â€” only ends on explicit disconnect
        reconnectTimers.set(agentName, { clientId });
        console.log(`Support ${agentName} disconnected â€” session with ${clientId} preserved`);
        // activeSessions still holds clientId -> deadSocketId so client shows as busy
        broadcastClients();

      } else {
        broadcastClients();
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
