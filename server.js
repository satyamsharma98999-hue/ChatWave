const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//   IN-MEMORY DATABASE
//   (Data server restart tak rahega)
// ============================================================
const users = {};    // uid -> { uid, name, color, pwHash, contacts[] }
const messages = {}; // chatKey -> [msg, ...]

// ============================================================
//   REST API
// ============================================================

// Check UID availability
app.get('/api/check-uid/:uid', (req, res) => {
  const uid = req.params.uid.toLowerCase();
  res.json({ available: !users[uid] });
});

// Signup
app.post('/api/signup', (req, res) => {
  const { uid, name, color, pwHash } = req.body;
  if (!uid || !name || !pwHash) return res.json({ ok: false, msg: 'Missing fields' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(uid)) return res.json({ ok: false, msg: 'Invalid User ID' });
  if (users[uid]) return res.json({ ok: false, msg: '❌ यह User ID पहले से ली हुई है' });
  users[uid] = { uid, name, color, pwHash, contacts: [], createdAt: Date.now() };
  console.log(`✅ New user: ${name} (@${uid})`);
  res.json({ ok: true });
});

// Login
app.post('/api/login', (req, res) => {
  const { uid, pwHash } = req.body;
  if (!uid || !pwHash) return res.json({ ok: false, msg: 'Missing fields' });
  const u = users[uid.toLowerCase()];
  if (!u) return res.json({ ok: false, msg: '❌ User ID नहीं मिला — पहले Sign Up करें' });
  if (u.pwHash !== pwHash) return res.json({ ok: false, msg: '❌ Password गलत है' });
  res.json({ ok: true, user: { uid: u.uid, name: u.name, color: u.color, contacts: u.contacts } });
});

// Add contact
app.post('/api/add-contact', (req, res) => {
  const { myUID, targetUID } = req.body;
  const target = targetUID.toLowerCase();
  if (!users[target]) return res.json({ ok: false, msg: '❌ User नहीं मिला — ID चेक करें' });
  if (target === myUID) return res.json({ ok: false, msg: '❗ खुद को add नहीं कर सकते' });
  const mu = users[myUID]; const tu = users[target];
  if (!mu.contacts.includes(target)) mu.contacts.push(target);
  if (!tu.contacts.includes(myUID)) tu.contacts.push(myUID);
  res.json({ ok: true, targetUser: { uid: tu.uid, name: tu.name, color: tu.color } });
});

// Get contacts info
app.post('/api/contacts-info', (req, res) => {
  const { uids } = req.body;
  const info = {};
  (uids || []).forEach(uid => { if (users[uid]) info[uid] = { uid: users[uid].uid, name: users[uid].name, color: users[uid].color }; });
  res.json(info);
});

// Get chat history
app.get('/api/history/:key', (req, res) => {
  const msgs = (messages[req.params.key] || []).filter(m => !m.deleted);
  res.json(msgs);
});

// ============================================================
//   SOCKET.IO — REAL-TIME
// ============================================================
const onlineUsers = {}; // uid -> socketId

io.on('connection', socket => {

  // User joins
  socket.on('join', (uid) => {
    socket.uid = uid;
    onlineUsers[uid] = socket.id;
    console.log(`🟢 Online: @${uid}`);
    io.emit('online-update', Object.keys(onlineUsers));
  });

  // Send message
  socket.on('send-msg', (data) => {
    const key = [data.from, data.to].sort().join('::');
    if (!messages[key]) messages[key] = [];
    const msg = {
      ...data,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      ts: Date.now(),
      deleted: false,
      read: false
    };
    messages[key].push(msg);

    // Deliver to receiver if online
    const toSock = onlineUsers[data.to];
    if (toSock) {
      io.to(toSock).emit('new-msg', msg);
      // Auto mark as read after 1s if receiver online
      setTimeout(() => {
        msg.read = true;
        socket.emit('msg-read', { key, msgId: msg.id });
      }, 1200);
    }
    // Confirm to sender
    socket.emit('msg-sent', msg);
  });

  // Typing indicators
  socket.on('typing', ({ to }) => {
    const toSock = onlineUsers[to];
    if (toSock) io.to(toSock).emit('typing', { from: socket.uid });
  });

  socket.on('stop-typing', ({ to }) => {
    const toSock = onlineUsers[to];
    if (toSock) io.to(toSock).emit('stop-typing', { from: socket.uid });
  });

  // Delete message
  socket.on('delete-msg', ({ key, msgId, to }) => {
    const chat = messages[key] || [];
    const m = chat.find(x => x.id === msgId);
    if (m) m.deleted = true;
    const toSock = onlineUsers[to];
    if (toSock) io.to(toSock).emit('msg-deleted', { key, msgId });
    socket.emit('msg-deleted', { key, msgId });
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (socket.uid) {
      delete onlineUsers[socket.uid];
      console.log(`🔴 Offline: @${socket.uid}`);
      io.emit('online-update', Object.keys(onlineUsers));
    }
  });
});

// ============================================================
//   START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 ChatWave Server Started!');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  // Show network IPs
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets))
    for (const n of list)
      if (n.family === 'IPv4' && !n.internal)
        console.log(`📱 Network: http://${n.address}:${PORT}`);
  console.log('\n✅ Server ready!\n');
});
