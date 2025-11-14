// server.js
'use strict';

/**
 * Server (Full, Heavy, Compatible)
 * - Auth (register/login/access)
 * - JWT auth middleware
 * - /api/me
 * - Conversations & Messages endpoints (with populate)
 * - Uploads (multer) -> public/uploads
 * - socket.io with auth (token in handshake.auth.token)
 * - presence (online/lastSeen)
 * - message edit/delete, seen events
 * - security (helmet), rate-limit, logging (morgan)
 *
 * NOTE: Set these ENV variables:
 *   - MONGO_URI (or MONGODB_URI)
 *   - JWT_SECRET
 *   - SITE_PASSWORD (optional gate)
 *   - PORT (optional)
 *
 * Install dependencies (if not installed):
 * npm i express http mongoose socket.io helmet cors morgan multer bcrypt jsonwebtoken express-rate-limit dotenv
 */

// --- modules
const fs = require('fs');
const path = require('path');
const http = require('http');

const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- config
const PORT = parseInt(process.env.PORT || '3000', 10);
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/eclipse_chat';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_jwt_secret';
const SITE_PASSWORD = process.env.SITE_PASSWORD || ''; // optional site gate
console.log(">>> SITE_PASSWORD =", SITE_PASSWORD);
const UPLOADS_REL = path.join('public', 'uploads');
const UPLOADS_DIR = path.join(__dirname, UPLOADS_REL);

// ensure upload dir
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- express + server + socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7
});

// --- middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/auth', authLimiter);

// serve uploads and public dir
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// default root -> access or index
app.get('/', (req, res) => {
  const accessFile = path.join(__dirname, 'public', 'access.html');
  const indexFile = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(accessFile)) return res.sendFile(accessFile);
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  return res.send('OK');
});

// --- mongoose models
mongoose.connect(MONGO_URI, { })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connect err:', err));

const { Schema } = mongoose;

const UserSchema = new Schema({
  username: { type: String, index: true, unique: true },
  passwordHash: String,
  displayName: String,
  avatarUrl: String,
  online: { type: Boolean, default: false },
  lastSeenAt: Date,
}, { timestamps: true });

const AttachmentSchema = new Schema({
  url: String,
  name: String,
  size: Number,
  mime: String
}, { _id: false });

const MessageSchema = new Schema({
  conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
  senderId: { type: Schema.Types.ObjectId, ref: 'User' },
  text: String,
  attachments: [AttachmentSchema],
  editedAt: Date,
  deleted: { type: Boolean, default: false },
  deletedForAll: { type: Boolean, default: false },
  seenBy: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

const ConversationSchema = new Schema({
  type: { type: String, default: 'private' },
  participants: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  title: String,
  lastMessageAt: Date,
  lastMessageText: String
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema);
const Message = mongoose.models.Message || mongoose.model('Message', MessageSchema);

// --- multer config for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = Date.now() + '-' + Math.random().toString(36).slice(2,8) + ext;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// --- helpers
function signToken(user) {
  return jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer (.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'no_token' });
  const token = m[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.id).lean();
    if (!user) return res.status(401).json({ ok: false, error: 'invalid_token' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

// --- AUTH routes
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const exists = await User.findOne({ username });
    if (exists) return res.status(409).json({ ok: false, error: 'username_exists' });

    const hash = await bcrypt.hash(password, 10);
    const user = new User({ username, passwordHash: hash, displayName: displayName || username });
    await user.save();
    return res.json({ ok: true });
  } catch (err) {
    console.error('register err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    const token = signToken(user);
    await User.findByIdAndUpdate(user._id, { online: true, lastSeenAt: new Date() });
    return res.json({ ok: true, token, user: { id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl } });
  } catch (err) {
    console.error('login err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/auth/access', (req, res) => {
  try {
    const { sitePassword } = req.body || {};
    if (!sitePassword) return res.status(400).json({ ok: false, error: 'missing_password' });
    if (SITE_PASSWORD && sitePassword === SITE_PASSWORD) return res.json({ ok: true });
    return res.status(401).json({ ok: false, error: 'invalid_site_password' });
  } catch (err) {
    console.error('access err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- helper route for frontend to get current user
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const u = await User.findById(req.user._id).select('_id username displayName avatarUrl online lastSeenAt').lean();
    return res.json({ ok: true, user: u });
  } catch (err) {
    console.error('/api/me err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- CONVERSATIONS
app.get('/api/conversations', authMiddleware, async (req, res) => {
  try {
    const convs = await Conversation.find({ participants: req.user._id })
      .sort({ lastMessageAt: -1 })
      .limit(200)
      .populate('participants', 'username displayName avatarUrl')
      .lean();
    return res.json({ ok: true, conversations: convs });
  } catch (err) {
    console.error('GET /api/conversations err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/conversations', authMiddleware, async (req, res) => {
  try {
    const { user } = req.body || {};
    if (!user) return res.status(400).json({ ok: false, error: 'missing_user' });

    let other = null;
    if (mongoose.Types.ObjectId.isValid(user)) other = await User.findById(user);
    else other = await User.findOne({ username: user });

    if (!other) return res.status(404).json({ ok: false, error: 'other_not_found' });

    let conv = await Conversation.findOne({ type: 'private', participants: { $all: [req.user._id, other._id] } });
    if (!conv) {
      conv = new Conversation({ type: 'private', participants: [req.user._id, other._id], title: '' });
      await conv.save();
    }
    const populated = await Conversation.findById(conv._id).populate('participants', 'username displayName avatarUrl').lean();
    return res.json({ ok: true, conversation: populated });
  } catch (err) {
    console.error('POST /api/conversations err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- MESSAGES
app.get('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  try {
    const convId = req.params.id;
    const msgs = await Message.find({ conversationId: convId }).sort({ createdAt: 1 }).limit(1000).populate('senderId', 'username displayName avatarUrl').lean();
    // transform messages for front (from, fromName, fromAvatar)
    const out = msgs.map(m => ({
      ...m,
      from: m.senderId ? m.senderId._id : null,
      fromName: m.senderId ? (m.senderId.displayName || m.senderId.username) : null,
      fromAvatar: m.senderId ? m.senderId.avatarUrl : null
    }));
    return res.json({ ok: true, messages: out });
  } catch (err) {
    console.error('GET messages err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.put('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const { text } = req.body || {};
    const msg = await Message.findById(id);
    if (!msg) return res.status(404).json({ ok: false, error: 'not_found' });
    if (String(msg.senderId) !== String(req.user._id)) return res.status(403).json({ ok: false, error: 'not_allowed' });
    msg.text = text;
    msg.editedAt = new Date();
    await msg.save();
    const populated = await Message.findById(msg._id).populate('senderId', 'username displayName avatarUrl').lean();
    const payload = {
      ...populated,
      from: populated.senderId ? populated.senderId._id : null,
      fromName: populated.senderId ? (populated.senderId.displayName || populated.senderId.username) : null,
      fromAvatar: populated.senderId ? populated.senderId.avatarUrl : null
    };
    io.to(String(msg.conversationId)).emit('message:edited', payload);
    return res.json({ ok: true, message: payload });
  } catch (err) {
    console.error('PUT /api/messages/:id err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const { forEveryone } = req.body || {};
    const msg = await Message.findById(id);
    if (!msg) return res.status(404).json({ ok: false, error: 'not_found' });
    if (forEveryone) {
      if (String(msg.senderId) !== String(req.user._id)) return res.status(403).json({ ok: false, error: 'not_allowed' });
      msg.deleted = true;
      msg.deletedForAll = true;
      msg.text = '';
      await msg.save();
      io.to(String(msg.conversationId)).emit('message:deleted', { conversationId: msg.conversationId, messageId: msg._id, deletedForAll: true });
    } else {
      msg.deleted = true;
      await msg.save();
      io.to(String(msg.conversationId)).emit('message:deleted', { conversationId: msg.conversationId, messageId: msg._id, deletedForAll: false });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/messages/:id err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- UPLOAD route
app.post('/upload/media', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });
    const url = `/${UPLOADS_REL}/${path.basename(req.file.path)}`.replace(/\\/g, '/');
    const att = { url, name: req.file.originalname, size: req.file.size, mime: req.file.mimetype };
    return res.json({ ok: true, attachment: att });
  } catch (err) {
    console.error('upload err', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- presence maps
const socketUser = new Map(); // socketId -> userId
const userSockets = new Map(); // userId -> Set(socketId)

async function setOnline(userId, socketId) {
  socketUser.set(socketId, String(userId));
  if (!userSockets.has(String(userId))) userSockets.set(String(userId), new Set());
  userSockets.get(String(userId)).add(socketId);
  await User.findByIdAndUpdate(userId, { online: true, lastSeenAt: new Date() });
  io.emit('user:online', { userId });
}

async function setOffline(userId, socketId) {
  socketUser.delete(socketId);
  if (userSockets.has(String(userId))) {
    const s = userSockets.get(String(userId));
    s.delete(socketId);
    if (s.size === 0) {
      userSockets.delete(String(userId));
      const lastSeen = new Date();
      await User.findByIdAndUpdate(userId, { online: false, lastSeenAt: lastSeen });
      io.emit('user:offline', { userId, lastSeenAt: lastSeen });
    }
  }
}

// --- socket.io handlers
io.on('connection', (socket) => {
  // token from handshake auth or query
  const token = (socket.handshake.auth && socket.handshake.auth.token) || (socket.handshake.query && socket.handshake.query.token);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.data.userId = payload.id;
      setOnline(payload.id, socket.id).catch(console.error);
    } catch (err) {
      console.warn('socket auth invalid', err.message);
    }
  }

  // join/leave conv rooms
  socket.on('private:join', ({ convId }) => {
    if (convId) socket.join(String(convId));
  });
  socket.on('private:leave', ({ convId }) => {
    if (convId) socket.leave(String(convId));
  });

  // typing indicator
  socket.on('typing', ({ convId, typing }) => {
    if (!convId) return;
    socket.to(String(convId)).emit('typing', { convId, userId: socket.data.userId, typing });
  });

  // private message
  socket.on('private:message', async (payload, ack) => {
    try {
      const { convId, tempId, text, attachments } = payload || {};
      const senderId = socket.data.userId;
      if (!senderId) return ack && ack({ ok: false, error: 'not_authenticated' });

      const msg = new Message({ conversationId: convId, senderId, text: text || '', attachments: attachments || [] });
      await msg.save();
      await Conversation.findByIdAndUpdate(convId, { lastMessageText: text, lastMessageAt: new Date() });

      // populate message BEFORE emit for front-friendly fields
      const populated = await Message.findById(msg._id).populate('senderId', 'username displayName avatarUrl').lean();
      const sendMsg = {
        ...populated,
        from: populated.senderId ? populated.senderId._id : null,
        fromName: populated.senderId ? (populated.senderId.displayName || populated.senderId.username) : null,
        fromAvatar: populated.senderId ? populated.senderId.avatarUrl : null
      };

      io.to(String(convId)).emit('private:message', { conversationId: convId, message: sendMsg });
      if (typeof ack === 'function') ack({ ok: true, tempId, message: sendMsg });
    } catch (err) {
      console.error('socket private:message err', err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // edit message
  socket.on('message:edit', async ({ messageId, text }, cb) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return cb && cb({ ok: false, error: 'not_found' });
      if (String(msg.senderId) !== String(socket.data.userId)) return cb && cb({ ok: false, error: 'not_allowed' });
      msg.text = text; msg.editedAt = new Date(); await msg.save();
      const populated = await Message.findById(msg._id).populate('senderId', 'username displayName avatarUrl').lean();
      const payload = { ...populated, from: populated.senderId ? populated.senderId._id : null, fromName: populated.senderId ? (populated.senderId.displayName || populated.senderId.username) : null };
      io.to(String(msg.conversationId)).emit('message:edited', payload);
      cb && cb({ ok: true, message: payload });
    } catch (err) {
      console.error('socket message:edit err', err);
      cb && cb({ ok: false, error: err.message });
    }
  });

  // delete message
  socket.on('message:delete', async ({ messageId, forAll }, cb) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return cb && cb({ ok: false, error: 'not_found' });
      if (forAll) {
        if (String(msg.senderId) !== String(socket.data.userId)) return cb && cb({ ok: false, error: 'not_allowed' });
        msg.deleted = true; msg.deletedForAll = true; msg.text = ''; await msg.save();
        io.to(String(msg.conversationId)).emit('message:deleted', { conversationId: msg.conversationId, messageId: msg._id, deletedForAll: true });
      } else {
        msg.deleted = true; await msg.save();
        io.to(String(msg.conversationId)).emit('message:deleted', { conversationId: msg.conversationId, messageId: msg._id, deletedForAll: false });
      }
      cb && cb({ ok: true });
    } catch (err) {
      console.error('socket message:delete err', err);
      cb && cb({ ok: false, error: err.message });
    }
  });

  // seen
  socket.on('message:seen', async ({ convId, messageIds }, cb) => {
    try {
      if (!Array.isArray(messageIds)) messageIds = [messageIds];
      await Message.updateMany({ _id: { $in: messageIds } }, { $addToSet: { seenBy: socket.data.userId } });
      io.to(String(convId)).emit('message:seen', { conversationId: convId, messageIds, userId: socket.data.userId });
      cb && cb({ ok: true });
    } catch (err) {
      console.error('socket message:seen err', err);
      cb && cb({ ok: false, error: err.message });
    }
  });

  // presence ping
  socket.on('presence:ping', async () => {
    const uid = socket.data.userId; if (!uid) return;
    await User.findByIdAndUpdate(uid, { lastSeenAt: new Date() });
  });

  socket.on('disconnect', () => {
    const sid = socket.id;
    const uid = socket.data.userId;
    if (uid) setOffline(uid, sid).catch(console.error);
  });
});

// --- start server
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// graceful shutdown
function shutdown() {
  console.log('Shutting down server...');
  server.close(() => {
    mongoose.disconnect().then(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);