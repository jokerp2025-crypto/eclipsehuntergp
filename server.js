require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const multer = require('multer');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const FileType = require('file-type');

const app = express();
const server = http.createServer(app);

// --- Config ---
const CORS_ORIGINS = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s=>s.trim()).filter(Boolean) : [];
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/eclipsehunter';
const JWT_SECRET = process.env.JWT_SECRET;
const MAIN_PASSWORD = process.env.MAIN_PASSWORD; // intentionally no default
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var is required');
  process.exit(1);
}
if (!MAIN_PASSWORD) {
  console.warn('WARNING: MAIN_PASSWORD not set. /auth/register will be disabled.');
}

// CORS options
const corsOptions = {
  credentials: true,
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!CORS_ORIGINS.length) return cb(new Error('CORS not configured; please set CORS_ORIGINS'), false);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'), false);
  }
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!CORS_ORIGINS.length && origin) {
    console.warn('Request with origin but no CORS_ORIGINS configured:', origin);
  }
  next();
});

app.use(cors(corsOptions));
const io = new Server(server, { cors: { origin: (origin, cb) => {
  if (!origin) return cb(null, true);
  if (!CORS_ORIGINS.length) return cb(new Error('CORS not configured'), false);
  if (CORS_ORIGINS.includes(origin)) return cb(null, true);
  return cb(new Error('Origin not allowed'), false);
}}});

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
  })
);
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// --- DB ---
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB connected'))
  .catch((e) => { console.error('❌ MongoDB error', e); process.exit(1); });

// --- Schemas ---
const userSchema = new mongoose.Schema({
  displayName: String,
  username: { type: String, unique: true },
  password: String,
  avatarUrl: String,
  bio: String,
  lastSeen: Date,
  online: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const conversationSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  backgroundUrl: String,
  createdAt: { type: Date, default: Date.now }
});
const Conversation = mongoose.model('Conversation', conversationSchema);

const messageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  text: String,
  media: String,
  mediaType: String,
  voice: String,
  replyTo: { type: Object, default: null },
  createdAt: { type: Date, default: Date.now },
  readAt: { type: Map, of: Date },
  reactions: { type: Map, of: [String], default: {} },
  deleted: { type: Boolean, default: false },
  deletedAt: Date,
  deletedBy: String
});
const Message = mongoose.model('Message', messageSchema);

// --- Sanitizer ---
function deepSanitize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepSanitize);
  const out = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.indexOf('.') !== -1) continue;
    if (key === '__proto__' || key === 'constructor') continue;
    const val = obj[key];
    if (val && typeof val === 'object') {
      out[key] = deepSanitize(val);
    } else {
      if (typeof val === 'string') out[key] = val.replace(/[\u0000-\u001F]/g, '');
      else out[key] = val;
    }
  }
  return out;
}

app.use((req, res, next) => {
  req.body = deepSanitize(req.body);
  req.query = deepSanitize(req.query);
  req.params = deepSanitize(req.params);
  next();
});

// --- Rate limits ---
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

app.use('/auth/', authLimiter);

// --- Static files ---
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), {
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Multer setup ---
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 9) + ext;
    cb(null, name);
  }
});

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'audio/webm', 'audio/mpeg', 'application/pdf']);
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) return cb(new Error('invalid_file_type'));
    cb(null, true);
  }
});

async function verifyFileMagic(fullPath) {
  const fd = await fs.promises.open(fullPath, 'r');
  try {
    const chunk = await fd.read(Buffer.alloc(4100), 0, 4100, 0);
    const ft = await FileType.fromBuffer(chunk.buffer.slice(0, chunk.bytesRead));
    if (!ft) return false;
    return ALLOWED_MIMES.has(ft.mime);
  } finally {
    await fd.close();
  }
}

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.message === 'invalid_file_type') return res.status(400).json({ ok: false, error: 'invalid_file_type' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ ok: false, error: 'file_too_large' });
  console.error('Unhandled error in middleware', err);
  return res.status(500).json({ ok: false, error: 'server_error' });
});

// --- JWT helpers ---
function signToken(user) {
  return jwt.sign({ id: String(user._id), username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ ok: false, error: 'user_not_found' });
    req.user = { id: String(user._id), username: user.username };
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

// --- Protected registration (owner only) ---
if (MAIN_PASSWORD) {
  app.post('/auth/register', upload.single('avatar'), async (req, res) => {
    try {
      const { sitePassword, displayName, username, password } = req.body;
      if (sitePassword !== MAIN_PASSWORD) return res.status(403).json({ ok: false, error: 'site_password_invalid' });
      if (!displayName || !username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

      const exists = await User.findOne({ username });
      if (exists) return res.status(409).json({ ok: false, error: 'username_taken' });

      let avatarUrl = null;
      if (req.file) {
        const full = path.join(uploadDir, req.file.filename);
        const ok = await verifyFileMagic(full).catch(()=>false);
        if (!ok) {
          try { await fs.promises.unlink(full); } catch(e){}
          return res.status(400).json({ ok: false, error: 'invalid_file_type' });
        }
        avatarUrl = `/uploads/${req.file.filename}`;
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      const user = new User({ displayName, username, password: hashedPassword, avatarUrl, lastSeen: new Date(), online: true });
      await user.save();

      const token = signToken(user);
      const safeUser = { id: String(user._id), displayName: user.displayName, username: user.username, avatarUrl: user.avatarUrl };
      return res.json({ ok: true, user: safeUser, token });
    } catch (e) {
      console.error('Register error', e);
      if (e.code === 11000) return res.status(409).json({ ok: false, error: 'username_taken' });
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });
} else {
  app.post('/auth/register', (req, res) => res.status(403).json({ ok: false, error: 'registration_disabled' }));
}

// --- Login ---
app.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ ok: false, error: 'wrong_password' });

    user.online = true;
    user.lastSeen = new Date();
    await user.save();

    const token = signToken(user);
    const safeUser = { id: String(user._id), displayName: user.displayName, username: user.username, avatarUrl: user.avatarUrl, bio: user.bio };
    return res.json({ ok: true, user: safeUser, token });
  } catch (e) {
    console.error('Login error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- User endpoints ---
app.get('/users', authMiddleware, async (req, res) => {
  const users = await User.find().select('-__v -password').sort({ createdAt: -1 });
  res.json({ ok: true, users });
});

app.get('/users/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password -__v');
  if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
  res.json({ ok: true, user });
});

app.post('/users/me', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const { displayName, bio, username } = req.body;
    const update = {};
    if (displayName) update.displayName = displayName;
    if (bio) update.bio = bio;
    if (username) update.username = username;

    if (req.file) {
      const full = path.join(uploadDir, req.file.filename);
      const ok = await verifyFileMagic(full).catch(()=>false);
      if (!ok) { try { await fs.promises.unlink(full); } catch(e){} return res.status(400).json({ ok: false, error: 'invalid_file_type' }); }
      update.avatarUrl = `/uploads/${req.file.filename}`;
    }

    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select('-password -__v');
    res.json({ ok: true, user });
  } catch (e) {
    console.error('Update profile error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Conversations & messages ---
app.get('/conversations/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    if (String(req.user.id) !== String(userId)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const convs = await Conversation.find({ participants: userId });
    res.json({ ok: true, conversations: convs });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.post('/conversations/:convId/background', authMiddleware, upload.single('background'), async (req, res) => {
  try {
    const { convId } = req.params;
    const conv = await Conversation.findById(convId);
    if (!conv) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
    if (!conv.participants.map(String).includes(String(req.user.id))) return res.status(403).json({ ok: false, error: 'forbidden' });

    if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });
    const full = path.join(uploadDir, req.file.filename);
    const ok = await verifyFileMagic(full).catch(()=>false);
    if (!ok) { try{ await fs.promises.unlink(full); }catch(e){} return res.status(400).json({ ok: false, error: 'invalid_file_type' }); }

    conv.backgroundUrl = `/uploads/${req.file.filename}`;
    await conv.save();
    res.json({ ok: true, backgroundUrl: conv.backgroundUrl });
  } catch (e) { console.error('bg upload error', e); res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.get('/messages/:convId', authMiddleware, async (req, res) => {
  try {
    const { convId } = req.params;
    const conv = await Conversation.findById(convId);
    if (!conv) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
    if (!conv.participants.map(String).includes(String(req.user.id))) return res.status(403).json({ ok: false, error: 'forbidden' });
    const msgs = await Message.find({ conversationId: convId }).sort({ createdAt: 1 });
    const norm = msgs.map(m => normalizeMessage(m));
    res.json({ ok: true, messages: norm });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.delete('/conversations/:convId/messages', authMiddleware, async (req, res) => {
  try {
    const { convId } = req.params;
    const conv = await Conversation.findById(convId);
    if (!conv) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
    if (!conv.participants.map(String).includes(String(req.user.id))) return res.status(403).json({ ok: false, error: 'forbidden' });
    // permanent delete for simplicity (you can change to soft-delete)
    await Message.deleteMany({ conversationId: convId });
    res.json({ ok: true });
  } catch (e) { console.error('clear history', e); res.status(500).json({ ok: false, error: 'server_error' }); }
});

// --- Upload endpoint (protected) ---
app.post('/upload', uploadLimiter, authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });
  const full = path.join(uploadDir, req.file.filename);
  const ok = await verifyFileMagic(full).catch(()=>false);
  if (!ok) {
    try { await fs.promises.unlink(full); } catch(e){}
    return res.status(400).json({ ok: false, error: 'invalid_file_type' });
  }
  const originalName = path.basename(req.file.originalname).replace(/[<>"'`]/g, '');
  return res.json({ ok: true, url: `/uploads/${req.file.filename}`, originalName });
});

// --- Logout ---
app.post('/logout', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    await User.findByIdAndUpdate(userId, { online: false, lastSeen: new Date() }).catch(()=>{});
    return res.json({ ok: true });
  } catch (e) { console.error('Logout error', e); return res.status(500).json({ ok: false }); }
});

function normalizeMessage(m) {
  if (!m) return m;
  const obj = m.toObject ? m.toObject() : JSON.parse(JSON.stringify(m));
  if (obj.readAt && typeof obj.readAt === 'object') {
    try {
      obj.readAt = Object.fromEntries(Object.entries(obj.readAt).map(([k,v]) => [k, new Date(v).toISOString()]));
    } catch (e) { }
  } else {
    obj.readAt = {};
  }
  if (obj.reactions && typeof obj.reactions === 'object') {
    try {
      obj.reactions = Object.fromEntries(Object.entries(obj.reactions).map(([k,v]) => [k, Array.isArray(v) ? v : []]));
    } catch (e) { obj.reactions = {}; }
  } else obj.reactions = {};
  return obj;
}

// --- Socket.io auth & handlers ---
const socketAttemptMap = new Map();
const SOCKET_ATTEMPT_WINDOW = 60 * 1000;
const SOCKET_ATTEMPT_MAX = 20;

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const ip = socket.handshake.address || socket.handshake.headers['x-forwarded-for'] || 'unknown';
    const key = token ? `t:${token}` : `ip:${ip}`;
    const rec = socketAttemptMap.get(key) || { count: 0, firstAt: Date.now() };
    if (Date.now() - rec.firstAt > SOCKET_ATTEMPT_WINDOW) { rec.count = 0; rec.firstAt = Date.now(); }
    rec.count += 1;
    socketAttemptMap.set(key, rec);
    if (rec.count > SOCKET_ATTEMPT_MAX) return next(new Error('rate_limited'));

    if (!token) return next(new Error('unauthorized'));
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.data.userId = decoded.id;
    socket.data.username = decoded.username;
    await User.findByIdAndUpdate(decoded.id, { online: true, lastSeen: new Date() }).catch(()=>{});
    return next();
  } catch (e) {
    console.error('Socket auth failed', e && e.message);
    return next(new Error('unauthorized'));
  }
});

const onlineMap = new Map();

io.on('connection', (socket) => {
  const uid = String(socket.data.userId);
  const set = onlineMap.get(uid) || new Set();
  set.add(socket.id);
  onlineMap.set(uid, set);
  io.emit('users:updated');

  socket.on('presence:register', async () => {
    await User.findByIdAndUpdate(uid, { online: true, lastSeen: new Date() }).catch(()=>{});
    io.emit('users:updated');
  });

  socket.on('private:join', async ({ otherId }) => {
    try {
      if (!otherId) return socket.emit('error', { error: 'missing_otherId' });
      let conv = await Conversation.findOne({ participants: { $all: [socket.data.userId, otherId] } });
      if (!conv) {
        conv = new Conversation({ participants: [socket.data.userId, otherId] });
        await conv.save();
      }
      socket.join(conv._id.toString());
      const msgs = await Message.find({ conversationId: conv._id }).sort({ createdAt: 1 });
      const norm = msgs.map(m => normalizeMessage(m));
      socket.emit('load messages', { convId: conv._id.toString(), messages: norm });
    } catch (e) {
      console.error('private:join', e);
      socket.emit('error', { error: 'server_error' });
    }
  });

  socket.on('private:message', async ({ convId, text, media, mediaType, voice, replyTo }) => {
    try {
      const conv = await Conversation.findById(convId);
      if (!conv) return socket.emit('error', { error: 'conversation_not_found' });
      if (!conv.participants.map(String).includes(uid)) return socket.emit('error', { error: 'forbidden' });

      const msg = new Message({ conversationId: convId, senderId: uid, text, media, mediaType, voice, replyTo: replyTo || null, createdAt: new Date() });
      await msg.save();
      const norm = normalizeMessage(msg);
      io.to(convId).emit('message:new', norm);
    } catch (e) { console.error('private:message', e); socket.emit('error', { error: 'server_error' }); }
  });

  socket.on('typing', ({ convId }) => {
    if (!convId) return;
    socket.to(convId).emit('typing', { convId, userId: uid });
  });

  socket.on('message:react', async ({ messageId, emoji }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return socket.emit('error', { error: 'message_not_found' });

      if (!msg.reactions) msg.reactions = {};
      const reactionsObj = (msg.reactions.toObject) ? msg.reactions.toObject() : msg.reactions;
      const arr = Array.isArray(reactionsObj[emoji]) ? reactionsObj[emoji] : [];
      const has = arr.includes(uid);
      const nextArr = has ? arr.filter(x => x !== uid) : [...arr, uid];
      reactionsObj[emoji] = nextArr;
      msg.reactions = reactionsObj;
      msg.markModified('reactions');
      await msg.save();
      const norm = normalizeMessage(msg);
      io.to(String(msg.conversationId)).emit('message:updated', norm);
    } catch (e) {
      console.error('message:react', e);
      socket.emit('error', { error: 'server_error' });
    }
  });

  socket.on('message:delete', async ({ messageId, forAll }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return socket.emit('error', { error: 'message_not_found' });
      if (forAll && String(msg.senderId) !== uid) return socket.emit('error', { error: 'forbidden' });

      if (forAll) {
        msg.deleted = true;
        msg.deletedAt = new Date();
        msg.deletedBy = uid;
        msg.text = ''; msg.media = null; msg.mediaType = null;
        await msg.save();
        const norm = normalizeMessage(msg);
        io.to(String(msg.conversationId)).emit('message:deleted', { messageId, forAll: true, message: norm });
      } else {
        socket.emit('message:deleted_local', { messageId });
      }
    } catch (e) { console.error('message:delete', e); socket.emit('error', { error: 'server_error' }); }
  });

  socket.on('message:read', async ({ messageId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return socket.emit('error', { error: 'message_not_found' });
      if (!msg.readAt) msg.readAt = {};
      msg.readAt.set ? msg.readAt.set(uid, new Date()) : (msg.readAt[uid] = new Date().toISOString());
      await msg.save();
      const norm = normalizeMessage(msg);
      io.to(String(msg.conversationId)).emit('message:read', { messageId, readerId: uid, readAt: (norm.readAt || {})[uid] });
    } catch (e) { console.error('message:read', e); socket.emit('error', { error: 'server_error' }); }
  });

  socket.on('disconnecting', async () => {
    const set = onlineMap.get(uid);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineMap.delete(uid);
        await User.findByIdAndUpdate(uid, { online: false, lastSeen: new Date() }).catch(()=>{});
      } else {
        onlineMap.set(uid, set);
      }
    }
    io.emit('users:updated');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server listening on port ${PORT}`));
