const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  DATABASE (In-Memory)
// ============================================================
// users[uid] = { uid, name, color, pwHash, bio, contacts[], blocked[], pendingIn[], pendingOut[], createdAt }
const users = {};
const messages = {}; // chatKey -> [msg]

// ============================================================
//  HELPERS
// ============================================================
function safeUser(u) {
  if (!u) return null;
  return { uid: u.uid, name: u.name, color: u.color, bio: u.bio || '' };
}

// ============================================================
//  AUTH
// ============================================================
app.get('/api/check-uid/:uid', (req, res) => {
  res.json({ available: !users[req.params.uid.toLowerCase()] });
});

// Helper: ensure user has all fields (for old users)
function fixUser(u) {
  if (!u) return u;
  if (!u.contacts) u.contacts = [];
  if (!u.blocked) u.blocked = [];
  if (!u.pendingIn) u.pendingIn = [];
  if (!u.pendingOut) u.pendingOut = [];
  if (!u.bio) u.bio = '';
  return u;
}

app.post('/api/signup', (req, res) => {
  const { uid, name, color, pwHash } = req.body;
  if (!uid || !name || !pwHash) return res.json({ ok: false, msg: 'Missing fields' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(uid)) return res.json({ ok: false, msg: 'Invalid User ID' });
  if (users[uid]) return res.json({ ok: false, msg: '❌ यह User ID पहले से ली हुई है' });
  users[uid] = { uid, name, color, pwHash, bio: '', contacts: [], blocked: [], pendingIn: [], pendingOut: [], createdAt: Date.now() };
  console.log(`✅ Signup: @${uid} (${name})`);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { uid, pwHash } = req.body;
  const u = fixUser(users[uid?.toLowerCase()]);
  if (!u) return res.json({ ok: false, msg: '❌ User ID नहीं मिला' });
  if (u.pwHash !== pwHash) return res.json({ ok: false, msg: '❌ Password गलत है' });
  res.json({ ok: true, user: { uid: u.uid, name: u.name, color: u.color, bio: u.bio || '', contacts: u.contacts, blocked: u.blocked, pendingIn: u.pendingIn, pendingOut: u.pendingOut } });
});

// ============================================================
//  SEARCH USERS
// ============================================================
app.get('/api/search', (req, res) => {
  const { q, myUID } = req.query;
  if (!q || q.length < 2) return res.json([]);
  const query = q.toLowerCase();
  const me = fixUser(users[myUID]);
  const results = Object.values(users)
    .filter(u => {
      if (u.uid === myUID) return false;
      if (me && me.blocked.includes(u.uid)) return false;
      return u.uid.includes(query) || u.name.toLowerCase().includes(query);
    })
    .slice(0, 15)
    .map(u => ({
      ...safeUser(u),
      isContact: me ? me.contacts.includes(u.uid) : false,
      isBlocked: me ? me.blocked.includes(u.uid) : false,
      isPendingOut: me ? me.pendingOut.includes(u.uid) : false,
      isPendingIn: me ? me.pendingIn.includes(u.uid) : false,
    }));
  res.json(results);
});

// Get all users (for browse)
app.get('/api/users', (req, res) => {
  const { myUID } = req.query;
  const me = fixUser(users[myUID]);
  const list = Object.values(users)
    .filter(u => u.uid !== myUID && !(me && me.blocked.includes(u.uid)))
    .map(u => ({
      ...safeUser(u),
      isContact: me ? me.contacts.includes(u.uid) : false,
      isPendingOut: me ? me.pendingOut.includes(u.uid) : false,
      isPendingIn: me ? me.pendingIn.includes(u.uid) : false,
    }));
  res.json(list);
});

// Get user profile
app.get('/api/profile/:uid', (req, res) => {
  const u = users[req.params.uid.toLowerCase()];
  if (!u) return res.json({ ok: false });
  res.json({ ok: true, user: safeUser(u) });
});

// Update profile (name, bio, color)
app.post('/api/update-profile', (req, res) => {
  const { uid, name, bio, color } = req.body;
  const u = users[uid];
  if (!u) return res.json({ ok: false });
  if (name) u.name = name.slice(0, 24);
  if (bio !== undefined) u.bio = bio.slice(0, 80);
  if (color) u.color = color;
  // Notify contacts
  (u.contacts || []).forEach(cid => {
    const sock = onlineUsers[cid];
    if (sock) io.to(sock).emit('profile-updated', safeUser(u));
  });
  res.json({ ok: true, user: safeUser(u) });
});

// ============================================================
//  FRIEND REQUESTS
// ============================================================

// Send friend request
app.post('/api/friend-request', (req, res) => {
  const { fromUID, toUID } = req.body;
  const from = fixUser(users[fromUID]); const to = fixUser(users[toUID]);
  if (!from || !to) return res.json({ ok: false, msg: 'User नहीं मिला' });
  if (fromUID === toUID) return res.json({ ok: false, msg: 'खुद को add नहीं कर सकते' });
  if (from.blocked.includes(toUID) || to.blocked.includes(fromUID)) return res.json({ ok: false, msg: 'Request नहीं भेज सकते' });
  if (from.contacts.includes(toUID)) return res.json({ ok: false, msg: 'पहले से friend हैं' });
  if (from.pendingOut.includes(toUID)) return res.json({ ok: false, msg: 'Request पहले से भेजी हुई है' });

  // If they already sent me a request → auto accept
  if (from.pendingIn.includes(toUID)) {
    from.contacts.push(toUID); to.contacts.push(fromUID);
    from.pendingIn = from.pendingIn.filter(x => x !== toUID);
    to.pendingOut = to.pendingOut.filter(x => x !== fromUID);
    // Notify both
    const toSock = onlineUsers[toUID];
    if (toSock) io.to(toSock).emit('friend-accepted', { uid: fromUID, user: safeUser(from) });
    const fromSock = onlineUsers[fromUID];
    if (fromSock) io.to(fromSock).emit('friend-accepted', { uid: toUID, user: safeUser(to) });
    return res.json({ ok: true, accepted: true });
  }

  from.pendingOut.push(toUID);
  to.pendingIn.push(fromUID);

  // Real-time notification to receiver
  const toSock = onlineUsers[toUID];
  if (toSock) io.to(toSock).emit('friend-request', { from: safeUser(from) });

  console.log(`📨 Friend request: @${fromUID} → @${toUID}`);
  res.json({ ok: true, accepted: false });
});

// Accept friend request
app.post('/api/accept-request', (req, res) => {
  const { myUID, fromUID } = req.body;
  const me = fixUser(users[myUID]); const from = fixUser(users[fromUID]);
  if (!me || !from) return res.json({ ok: false });
  me.contacts.push(fromUID); from.contacts.push(myUID);
  me.pendingIn = me.pendingIn.filter(x => x !== fromUID);
  from.pendingOut = from.pendingOut.filter(x => x !== myUID);
  // Notify sender
  const fromSock = onlineUsers[fromUID];
  if (fromSock) io.to(fromSock).emit('friend-accepted', { uid: myUID, user: safeUser(me) });
  res.json({ ok: true });
});

// Decline / Cancel request
app.post('/api/decline-request', (req, res) => {
  const { myUID, fromUID } = req.body;
  const me = fixUser(users[myUID]); const from = fixUser(users[fromUID]);
  if (me) me.pendingIn = me.pendingIn.filter(x => x !== fromUID);
  if (from) from.pendingOut = from.pendingOut.filter(x => x !== myUID);
  res.json({ ok: true });
});

// ============================================================
//  BLOCK / UNBLOCK
// ============================================================
app.post('/api/block', (req, res) => {
  const { myUID, targetUID } = req.body;
  const me = fixUser(users[myUID]);
  if (!me) return res.json({ ok: false });
  if (!me.blocked.includes(targetUID)) me.blocked.push(targetUID);
  me.contacts = me.contacts.filter(x => x !== targetUID);
  const target = fixUser(users[targetUID]);
  if (target) target.contacts = target.contacts.filter(x => x !== myUID);
  res.json({ ok: true });
});

app.post('/api/unblock', (req, res) => {
  const { myUID, targetUID } = req.body;
  const me = fixUser(users[myUID]);
  if (!me) return res.json({ ok: false });
  me.blocked = me.blocked.filter(x => x !== targetUID);
  res.json({ ok: true });
});

// ============================================================
//  CONTACTS & MESSAGES
// ============================================================
app.post('/api/contacts-info', (req, res) => {
  const { uids } = req.body;
  const info = {};
  (uids || []).forEach(uid => { if (users[uid]) info[uid] = safeUser(users[uid]); });
  res.json(info);
});

app.get('/api/history/:key', (req, res) => {
  res.json((messages[req.params.key] || []).filter(m => !m.deleted));
});

// ============================================================
//  SOCKET.IO
// ============================================================
const onlineUsers = {};

io.on('connection', socket => {
  socket.on('join', uid => {
    socket.uid = uid;
    onlineUsers[uid] = socket.id;
    io.emit('online-update', Object.keys(onlineUsers));
  });

  socket.on('send-msg', data => {
    const key = [data.from, data.to].sort().join('::');
    if (!messages[key]) messages[key] = [];
    // Check block
    const sender = users[data.from]; const receiver = users[data.to];
    if (receiver && receiver.blocked && receiver.blocked.includes(data.from)) return;
    const msg = { ...data, id: Date.now().toString(36) + Math.random().toString(36).slice(2), ts: Date.now(), deleted: false, read: false };
    messages[key].push(msg);
    const toSock = onlineUsers[data.to];
    if (toSock) {
      io.to(toSock).emit('new-msg', msg);
      setTimeout(() => { msg.read = true; socket.emit('msg-read', { key, msgId: msg.id }); }, 1200);
    }
    socket.emit('msg-sent', msg);
  });

  socket.on('typing', ({ to }) => { const s = onlineUsers[to]; if (s) io.to(s).emit('typing', { from: socket.uid }); });
  socket.on('stop-typing', ({ to }) => { const s = onlineUsers[to]; if (s) io.to(s).emit('stop-typing', { from: socket.uid }); });

  socket.on('delete-msg', ({ key, msgId, to }) => {
    const m = (messages[key] || []).find(x => x.id === msgId);
    if (m) m.deleted = true;
    const s = onlineUsers[to]; if (s) io.to(s).emit('msg-deleted', { key, msgId });
    socket.emit('msg-deleted', { key, msgId });
  });

  socket.on('disconnect', () => {
    if (socket.uid) { delete onlineUsers[socket.uid]; io.emit('online-update', Object.keys(onlineUsers)); }
  });
});

// ============================================================
//  START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ChatWave Server running on port ${PORT}\n`);
});
