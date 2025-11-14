/**
 * server_upgraded_final.js
 *
 * Upgraded Node.js + Express + Socket.IO server for Eclipse Chat
 * Adds the five requested features to the existing server:
 *  1) Media upload endpoint (POST /upload/media) using multer -> saves to ./uploads and returns URL
 *  2) Presence (user online/offline + lastSeen) with heartbeat and socket events
 *  3) User search endpoint (GET /users/search?q=...) by username/displayName
 *  4) User profile endpoint (GET /users/:id)
 *  5) Typing indicator via socket events
 *
 * Requirements (install):
 *   npm install express mongoose socket.io cors helmet morgan multer bcrypt jsonwebtoken dotenv
 *
 * Environment variables expected (.env):
 *   MONGO_URI, JWT_SECRET, PORT (optional)
 *
 * Note: This file is self-contained and intentionally commented for clarity.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: '*' }
});

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/eclipse_chat';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

/* ---------------------- Mongoose models ---------------------- */
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=> console.log('MongoDB connected'))
  .catch(err => console.error('Mongo connect error', err));

const Schema = mongoose.Schema;

const UserSchema = new Schema({
  username: { type: String, index: true },
  displayName: String,
  passwordHash: String,
  avatarUrl: String,
  lastSeenAt: Date,
  online: { type: Boolean, default: false },
}, { timestamps: true });

const ConversationSchema = new Schema({
  title: String,
  type: { type: String, default: 'private' },
  participants: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  lastMessageText: String,
  lastMessageAt: Date
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
  replyTo: { type: Schema.Types.ObjectId, ref: 'Message' },
  editedAt: Date,
  deleted: { type: Boolean, default: false },
  deletedForAll: { type: Boolean, default: false },
  deliveredTo: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  seenBy: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);
const Conversation = mongoose.model('Conversation', ConversationSchema);
const Message = mongoose.model('Message', MessageSchema);

/* ---------------------- Middleware ---------------------- */
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

/* Static uploads access */
app.use('/uploads', express.static(UPLOAD_DIR));

/* ---------------------- Auth helpers ---------------------- */
function signToken(user) {
  return jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
}

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer (.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'No token' });
  const token = m[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.id).lean();
    if (!user) return res.status(401).json({ ok: false, error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

/* ---------------------- Multer for uploads ---------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

/* ---------------------- Routes ---------------------- */
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/auth/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username/password required' });
  const existing = await User.findOne({ username });
  if (existing) return res.status(400).json({ ok: false, error: 'username exists' });
  const hash = await bcrypt.hash(password, 10);
  const user = new User({ username, passwordHash: hash, displayName });
  await user.save();
  const token = signToken(user);
  res.json({ ok: true, user: { id: user._id, username: user.username, displayName: user.displayName }, token });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.status(400).json({ ok: false, error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ ok: false, error: 'invalid credentials' });
  const token = signToken(user);
  res.json({ ok: true, user: { id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl }, token });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const u = await User.findById(req.user._id).lean();
  res.json({ ok: true, user: u });
});

app.get('/api/users/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const u = await User.findById(id).lean();
  if (!u) return res.status(404).json({ ok: false, error: 'user not found' });
  res.json({ ok: true, user: u });
});

app.get('/api/users/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, users: [] });
  const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const users = await User.find({ $or: [{ username: regex }, { displayName: regex }] }).limit(20).lean();
  res.json({ ok: true, users });
});

app.put('/api/me', authMiddleware, async (req, res) => {
  const { displayName, avatarUrl } = req.body;
  await User.findByIdAndUpdate(req.user._id, { displayName, avatarUrl }, { new: true });
  res.json({ ok: true });
});

app.get('/api/conversations', authMiddleware, async (req, res) => {
  const convs = await Conversation.find({ participants: req.user._id }).sort({ lastMessageAt: -1 }).limit(100).lean();
  res.json({ ok: true, conversations: convs });
});

app.post('/api/conversations', authMiddleware, async (req, res) => {
  const { user } = req.body;
  let other = null;
  if (mongoose.Types.ObjectId.isValid(user)) other = await User.findById(user);
  else other = await User.findOne({ username: user });
  if (!other) return res.status(404).json({ ok: false, error: 'other user not found' });
  let conv = await Conversation.findOne({ type: 'private', participants: { $all: [req.user._id, other._id] } });
  if (!conv) {
    conv = new Conversation({ type: 'private', participants: [req.user._id, other._id] });
    await conv.save();
  }
  res.json({ ok: true, conversation: conv });
});

app.get('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  const convId = req.params.id;
  const msgs = await Message.find({ conversationId: convId }).sort({ createdAt: 1 }).limit(200).lean();
  res.json({ ok: true, messages: msgs });
});

app.put('/api/messages/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const { text } = req.body;
  const msg = await Message.findById(id);
  if (!msg) return res.status(404).json({ ok: false, error: 'message not found' });
  if (String(msg.senderId) !== String(req.user._id)) return res.status(403).json({ ok: false, error: 'not allowed' });
  msg.text = text;
  msg.editedAt = new Date();
  await msg.save();
  io.to(String(msg.conversationId)).emit('message:updated', { conversationId: msg.conversationId, message: msg });
  res.json({ ok: true, message: msg });
});

app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const forAll = req.body && req.body.forEveryone;
  const msg = await Message.findById(id);
  if (!msg) return res.status(404).json({ ok: false, error: 'message not found' });
  if (forAll) {
    if (String(msg.senderId) !== String(req.user._id)) return res.status(403).json({ ok: false, error: 'not allowed' });
    msg.deleted = true; msg.deletedForAll = true; msg.text = '';
    await msg.save();
    io.to(String(msg.conversationId)).emit('message:deleted', { conversationId: msg.conversationId, messageId: msg._id, deletedForAll: true });
  } else {
    msg.deleted = true;
    await msg.save();
    io.to(String(msg.conversationId)).emit('message:deleted', { conversationId: msg.conversationId, messageId: msg._id, deletedForAll: false });
  }
  res.json({ ok: true });
});

app.post('/upload/media', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  const url = `/uploads/${path.basename(req.file.path)}`;
  const attachment = {
    url,
    name: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype
  };
  res.json({ ok: true, attachment });
});

/* ---------------------- Presence helpers ---------------------- */
const socketUser = new Map();
const userSockets = new Map();

async function setUserOnline(userId, socketId) {
  socketUser.set(socketId, String(userId));
  if (!userSockets.has(String(userId))) userSockets.set(String(userId), new Set());
  userSockets.get(String(userId)).add(socketId);
  await User.findByIdAndUpdate(userId, { online: true }, { new: true });
  io.emit('user:online', { userId });
}

async function setUserOffline(userId, socketId) {
  socketUser.delete(socketId);
  if (userSockets.has(String(userId))) {
    const s = userSockets.get(String(userId));
    s.delete(socketId);
    if (s.size === 0) {
      userSockets.delete(String(userId));
      const lastSeen = new Date();
      await User.findByIdAndUpdate(userId, { online: false, lastSeenAt: lastSeen }, { new: true });
      io.emit('user:offline', { userId, lastSeenAt: lastSeen });
    }
  }
}

/* ---------------------- Socket events ---------------------- */
io.on('connection', (socket) => {
  const token = socket.handshake.auth && socket.handshake.auth.token || (socket.handshake.query && socket.handshake.query.token);
  if (!token) {
    console.warn('socket connected without token');
  } else {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const uid = payload.id;
      socket.data.userId = uid;
      setUserOnline(uid, socket.id).catch(console.error);
    } catch (err) {
      console.warn('socket token invalid', err.message);
    }
  }

  socket.on('private:join', ({ convId }) => {
    if (!convId) return;
    socket.join(String(convId));
  });

  socket.on('private:leave', ({ convId }) => {
    socket.leave(String(convId));
  });

  socket.on('typing', ({ convId, typing }) => {
    socket.to(String(convId)).emit('typing', { convId, userId: socket.data.userId, typing });
  });

  socket.on('private:message', async (payload, ack) => {
    try {
      const { convId, tempId, text, attachments } = payload;
      const senderId = socket.data.userId;
      const msg = new Message({
        conversationId: convId,
        senderId,
        text: text || '',
        attachments: attachments || []
      });
      await msg.save();
      await Conversation.findByIdAndUpdate(convId, { lastMessageText: text, lastMessageAt: new Date() });
      io.to(String(convId)).emit('private:message', { conversationId: convId, message: msg });
      if (typeof ack === 'function') ack({ ok: true, tempId, message: msg });
    } catch (err) {
      console.error('private:message error', err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('message:edit', async ({ messageId, text }, cb) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return cb && cb({ ok: false, error: 'not found' });
      if (String(msg.senderId) !== String(socket.data.userId)) return cb && cb({ ok: false, error: 'not allowed' });
      msg.text = text;
      msg.editedAt = new Date();
      await msg.save();
      io.to(String(msg.conversationId)).emit('message:updated', { conversationId: msg.conversationId, message: msg });
      cb && cb({ ok: true, message: msg });
    } catch (err) {
      console.error('edit error', err);
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('message:delete', async ({ messageId, forAll }, cb) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return cb && cb({ ok: false, error: 'not found' });
      if (forAll) {
        if (String(msg.senderId) !== String(socket.data.userId)) return cb && cb({ ok: false, error: 'not allowed' });
        msg.deleted = true; msg.deletedForAll = true; msg.text = '';
        await msg.save();
        io.to(String(msg.conversationId)).emit('message:deleted', { conversationId: msg.conversationId, messageId: msg._id, deletedForAll: true });
      } else {
        msg.deleted = true;
        await msg.save();
        io.to(String(msg.conversationId)).emit('message:deleted', { conversationId: msg.conversationId, messageId: msg._id, deletedForAll: false });
      }
      cb && cb({ ok: true });
    } catch (err) {
      console.error('delete error', err);
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('message:seen', async ({ convId, messageIds }, cb) => {
    try {
      if (!Array.isArray(messageIds)) messageIds = [messageIds];
      await Message.updateMany({ _id: { $in: messageIds } }, { $addToSet: { seenBy: socket.data.userId } });
      io.to(String(convId)).emit('message:seen', { conversationId: convId, messageIds, userId: socket.data.userId });
      cb && cb({ ok: true });
    } catch (err) {
      console.error('seen error', err);
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('presence:ping', async () => {
    const uid = socket.data.userId;
    if (!uid) return;
    await User.findByIdAndUpdate(uid, { lastSeenAt: new Date() });
  });

  socket.on('disconnect', (reason) => {
    const sid = socket.id;
    const uid = socket.data.userId;
    if (uid) setUserOffline(uid, sid).catch(console.error);
  });
});

/* ---------------------- Start server ---------------------- */
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

/* ---------------------- End of file ---------------------- */
