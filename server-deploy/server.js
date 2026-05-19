const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// State maps
const clients = new Map();       // clientId -> socket.id
const supports = new Map();      // socket.id -> { name, targetClientId }
const activeSessions = new Map();// clientId -> supportSocketId

// Serve dashboard (lives next to this file in the deploy package)
app.use(express.static(path.join(__dirname, 'dashboard')));

// Health check endpoint (used by Render + keep-alive pingers to prevent cold starts)
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', clients: clients.size, time: new Date().toISOString() });
});

// Download routes (client installer is distributed separately, not from this server)
app.get('/download/windows', (req, res) => {
  res.status(501).send('Windows client installer is distributed separately.');
});

app.get('/download/mac', (req, res) => {
  res.status(501).send('MacOS support coming soon');
});

// Debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    clients: Array.from(clients.entries()).map(([id, sid]) => ({ id, socketId: sid })),
    supports: Array.from(supports.entries()).map(([sid, s]) => ({ socketId: sid, name: s.name, target: s.targetClientId })),
    activeSessions: Array.from(activeSessions.entries()),
    serverTime: new Date().toISOString()
  });
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

function broadcastClients() {
  const clientList = Array.from(clients.keys()).map(id => ({
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
      // If same clientId reconnects, update its socket.id
      clients.set(data.clientId, socket.id);
      socket.clientId = data.clientId;
      console.log(`Client registered: ${data.clientId}`);
      broadcastClients();

    } else if (data.type === 'support') {
      if (data.password === 'admin123') {
        const agentName = (data.name || 'Agent').trim();

        // Clear any stale sessions from a previous connection with the same name
        for (const [sid, sup] of supports.entries()) {
          if (sup.name === agentName && sid !== socket.id) {
            console.log(`Clearing stale session for agent: ${agentName}`);
            if (sup.targetClientId) {
              activeSessions.delete(sup.targetClientId);
            }
            supports.delete(sid);
          }
        }

        supports.set(socket.id, { name: agentName, targetClientId: null });
        console.log(`Support registered: ${agentName}`);
        socket.emit('login_success');
        broadcastClients();
      } else {
        socket.emit('login_error', 'Invalid password');
      }
    }
  });

  socket.on('request_connection', (clientId) => {
    const support = supports.get(socket.id);
    if (!support) return;

    const existingSocketId = activeSessions.get(clientId);

    // Block if a DIFFERENT agent is in session
    if (existingSocketId && existingSocketId !== socket.id) {
      const existingAgent = supports.get(existingSocketId);
      if (existingAgent && existingAgent.name !== support.name) {
        return socket.emit('session_blocked', `Client is busy with ${existingAgent.name}`);
      }
    }

    const clientSocketId = clients.get(clientId);
    if (!clientSocketId) {
      return socket.emit('session_blocked', 'Client is not connected');
    }

    // Set session
    activeSessions.set(clientId, socket.id);
    support.targetClientId = clientId;

    io.to(clientSocketId).emit('support_request', socket.id);
    console.log(`Session started: ${support.name} -> ${clientId}`);
    broadcastClients();
  });

  socket.on('end_session', (clientId) => {
    activeSessions.delete(clientId);
    const support = supports.get(socket.id);
    if (support) support.targetClientId = null;

    const clientSocketId = clients.get(clientId);
    if (clientSocketId) io.to(clientSocketId).emit('end_session');

    console.log(`Session ended for client: ${clientId}`);
    broadcastClients();
  });

  // WebRTC relay
  socket.on('offer',         (data) => io.to(data.target).emit('offer',         { sender: socket.id, sdp: data.sdp }));
  socket.on('answer',        (data) => io.to(data.target).emit('answer',        { sender: socket.id, sdp: data.sdp }));
  socket.on('ice-candidate', (data) => io.to(data.target).emit('ice-candidate', { sender: socket.id, candidate: data.candidate }));

  socket.on('force_reset_all', () => {
    console.log('FORCE RESET by', socket.id);
    activeSessions.clear();
    io.emit('server_reset');
    broadcastClients();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);

    // Clean up client
    if (socket.clientId) {
      clients.delete(socket.clientId);
      activeSessions.delete(socket.clientId);
    }

    // Clean up support agent
    if (supports.has(socket.id)) {
      const sup = supports.get(socket.id);
      if (sup.targetClientId) {
        activeSessions.delete(sup.targetClientId);
        const clientSid = clients.get(sup.targetClientId);
        if (clientSid) io.to(clientSid).emit('end_session');
      }
      supports.delete(socket.id);
    }

    broadcastClients();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
