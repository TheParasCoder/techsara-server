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
// agentName -> { clientId }  — preserved sessions (agent offline, session kept until explicit disconnect)
const reconnectTimers = new Map();
// clientId -> { agentSocketId }  — preserved sessions when CLIENT goes offline
const clientReconnectTimers = new Map();

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

// Resolve agent name for a clientId — checks live sessions AND grace-period reconnects
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

  console.log(`Session ended: ${clientId} — reason: ${reason}`);
  broadcastClients();
}

function broadcastClients() {
  // Send ALL known clients — dashboard shows unavailable ones with "ask to enable" message
  const clientList = Array.from(clients.entries())
    .map(([id, c]) => ({
      id,
      available: c.available,
      online: !!c.socketId,
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

      // Restore session if client had an active session before going offline
      if (clientReconnectTimers.has(data.clientId)) {
        const preserved = clientReconnectTimers.get(data.clientId);
        clientReconnectTimers.delete(data.clientId);
        const agentSocketId = preserved.agentSocketId;
        if (agentSocketId && supports.has(agentSocketId)) {
          const sup = supports.get(agentSocketId);
          activeSessions.set(data.clientId, agentSocketId);
          // Tell client to start new WebRTC with agent
          io.to(socket.id).emit('support_request', { supportId: agentSocketId, agentName: sup.name });
          // Tell agent the client is back
          io.to(agentSocketId).emit('client_reconnected', { clientId: data.clientId });
          console.log(`Client ${data.clientId} reconnected — session with ${sup.name} restored`);
        }
      }

    } else if (data.type === 'support') {
      if (data.password !== 'admin123') {
        return socket.emit('login_error', 'Invalid password');
      }

      const agentName = (data.name || 'Agent').trim();

      // ── Grace-period reconnect: restore the session if timer is pending ──
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

        console.log(`Support ${agentName} reconnected — session with ${clientId} restored`);
        broadcastClients();
        return;
      }

      // ── Clear any other stale entries from the same agent name ──
      for (const [sid, sup] of supports.entries()) {
        if (sup.name === agentName && sid !== socket.id) {
          if (sup.targetClientId) activeSessions.delete(sup.targetClientId);
          supports.delete(sid);
        }
      }

      // ── Normal login ──
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
    clientReconnectTimers.clear();
    activeSessions.clear();
    clients.forEach(c => { c.available = false; });
    io.emit('server_reset');
    broadcastClients();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);

    // ── Client disconnected ──
    if (socket.clientId) {
      const agentSocketId = activeSessions.get(socket.clientId);
      if (agentSocketId && supports.has(agentSocketId)) {
        // Preserve session — store it so it's restored when client reconnects
        clientReconnectTimers.set(socket.clientId, { agentSocketId });
        io.to(agentSocketId).emit('client_reconnecting', { clientId: socket.clientId });
        console.log(`Client ${socket.clientId} went offline — session with agent preserved`);
      } else if (activeSessions.has(socket.clientId)) {
        activeSessions.delete(socket.clientId);
      }
      // Keep client in map but mark as offline (socketId = null) so dashboard still shows it
      const clientData = clients.get(socket.clientId);
      if (clientData) { clientData.socketId = null; clientData.available = false; }
      broadcastClients();
    }

    // ── Support agent disconnected ──
    if (supports.has(socket.id)) {
      const sup = supports.get(socket.id);
      supports.delete(socket.id);

      if (sup.targetClientId &&
          clients.has(sup.targetClientId) &&
          activeSessions.has(sup.targetClientId)) {

        const clientId  = sup.targetClientId;
        const agentName = sup.name;

        // Notify client that agent dropped — session is preserved until agent reconnects
        const clientData = clients.get(clientId);
        if (clientData) {
          io.to(clientData.socketId).emit('agent_reconnecting', { agentName });
        }

        // Preserve session indefinitely — only ends on explicit disconnect
        reconnectTimers.set(agentName, { clientId });
        console.log(`Support ${agentName} disconnected — session with ${clientId} preserved`);
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
