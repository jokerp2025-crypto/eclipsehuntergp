/* server.js — Clean rebuilt & fixed
   Fixes:
   - Correct handling of tempId for message confirmation.
   - Unifies delete flags (forAll + forEveryone) to avoid mismatch.
   - MIME validation for uploads (security).
   - Improved socket emit consistency.
*/

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');

const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');

const { Server } = require('socket.io');

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_SECRET';

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use('/upload/media', express.static(path.join(__dirname, 'upload/media')));

/* ===============================
   MULTER UPLOAD + MIME VALIDATION
   =============================== */

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'upload/media'));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = Date.now() + "_" + Math.random().toString(36).slice(2) + ext;
    cb(null, name);
  }
});

// فقط MIME های امن
const allowedMimes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain'
];

const upload = multer({
  storage,
  fileFilter(req, file, cb) {
    if (!allowedMimes.includes(file.mimetype)) {
      cb(new Error("نوع فایل مجاز نیست"));
    } else {
      cb(null, true);
    }
  }
});
/* ===============================
   AUTH MIDDLEWARE
   =============================== */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ ok: false, error: "توکن موجود نیست" });

  const token = header.split(" ")[1];
  if (!token) return res.status(401).json({ ok: false, error: "توکن نامعتبر" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "توکن منقضی یا نامعتبر است" });
  }
}

/* ===============================
   DATABASE MOCK / REPLACEMENT
   (اینجا فقط ساختار را نگه می‌دارم
   تو دیتابیس اصلیت را جایگزین کن)
   =============================== */

const DB = {
  users: [],
  conversations: [],
  messages: []
};

function findUser(id) {
  return DB.users.find(u => String(u._id) === String(id));
}

function findConversation(id) {
  return DB.conversations.find(c => String(c._id) === String(id));
}

function findMessage(id) {
  return DB.messages.find(m => String(m._id) === String(id));
}

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ===============================
   AUTH ROUTES
   =============================== */

app.post('/auth/register', (req, res) => {
  const { username, password, displayName } = req.body;

  if (!username || !password) {
    return res.json({ ok: false, error: "اطلاعات ناقص" });
  }

  if (DB.users.some(u => u.username === username)) {
    return res.json({ ok: false, error: "این ایمیل قبلاً ثبت شده" });
  }

  const user = {
    _id: newId(),
    username,
    password,
    displayName: displayName || username,
    avatarUrl: null,
    lastSeenAt: null
  };

  DB.users.push(user);

  return res.json({ ok: true, user });
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;

  const user = DB.users.find(u => u.username === username && u.password === password);
  if (!user) {
    return res.status(401).json({ ok: false, error: "ایمیل یا رمز اشتباه است" });
  }

  const token = jwt.sign({ _id: user._id }, JWT_SECRET, { expiresIn: "30d" });

  res.json({ ok: true, token, user });
});

/* ===============================
   USER ROUTES
   =============================== */

app.get('/api/me', authMiddleware, (req, res) => {
  const me = findUser(req.user._id);
  if (!me) return res.status(404).json({ ok: false });

  res.json({ ok: true, user: me });
});
/* ===============================
   CONVERSATIONS ROUTES
   =============================== */

app.get('/api/conversations', authMiddleware, (req, res) => {
  const userId = req.user._id;

  const list = DB.conversations.filter(c =>
    c.participants.includes(userId)
  );

  const enriched = list.map(c => {
    const lastMsg = DB.messages
      .filter(m => m.conversationId === c._id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    return {
      _id: c._id,
      participants: c.participants.map(pid => findUser(pid)),
      lastMessageText: lastMsg ? lastMsg.text : ""
    };
  });

  res.json({ ok: true, conversations: enriched });
});

/* MESSAGES OF CONVERSATION */
app.get('/api/conversations/:id/messages', authMiddleware, (req, res) => {
  const conv = findConversation(req.params.id);
  if (!conv) return res.status(404).json({ ok: false });

  const msgs = DB.messages
    .filter(m => m.conversationId === conv._id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  res.json({ ok: true, messages: msgs });
});

/* ===============================
   SEND MESSAGE VIA HTTP (OPTIONAL)
   =============================== */

app.post('/api/messages', authMiddleware, (req, res) => {
  const { convId, text, attachments } = req.body;

  const conv = findConversation(convId);
  if (!conv) return res.status(404).json({ ok: false });

  const msg = {
    _id: newId(),
    conversationId: convId,
    senderId: req.user._id,
    text: text || "",
    attachments: attachments || [],
    createdAt: new Date().toISOString(),
    seenBy: []
  };

  DB.messages.push(msg);
  res.json({ ok: true, message: msg });
});

/* EDIT MESSAGE */
app.put('/api/messages/:id', authMiddleware, (req, res) => {
  const msg = findMessage(req.params.id);
  if (!msg) return res.status(404).json({ ok: false });

  if (msg.senderId !== req.user._id) {
    return res.status(403).json({ ok: false, error: "اجازه ندارید" });
  }

  msg.text = req.body.text || msg.text;
  msg.editedAt = new Date().toISOString();

  res.json({ ok: true, message: msg });
});

/* DELETE MESSAGE (HTTP) */
app.delete('/api/messages/:id', authMiddleware, (req, res) => {
  const msg = findMessage(req.params.id);
  if (!msg) return res.status(404).json({ ok: false });

  const forEveryone = req.body.forEveryone;

  if (msg.senderId !== req.user._id && !forEveryone) {
    return res.status(403).json({ ok: false, error: "اجازه حذف ندارید" });
  }

  // حذف از دیتابیس
  DB.messages = DB.messages.filter(m => m._id !== msg._id);

  res.json({ ok: true });
});
/* ===============================
   FILE UPLOAD ROUTE (SAFE)
   =============================== */

app.post('/upload/media', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "فایلی انتخاب نشده" });
    }

    const file = req.file;

    // اگر تصویر بود، نسخه فشرده بسازیم:
    let finalUrl = "/upload/media/" + file.filename;

    if (file.mimetype.startsWith("image/")) {
      const output = path.join(__dirname, "upload/media", "c_" + file.filename);

      await sharp(file.path)
        .resize({ width: 1280 })
        .jpeg({ quality: 80 })
        .toFile(output);

      fs.unlinkSync(file.path); // حذف نسخه خام
      finalUrl = "/upload/media/" + "c_" + file.filename;
    }

    const attachment = {
      url: finalUrl,
      name: file.originalname,
      size: file.size,
      mime: file.mimetype
    };

    return res.json({ ok: true, attachment });

  } catch (e) {
    console.error("upload error", e);
    return res.status(500).json({ ok: false, error: "خطا در آپلود" });
  }
});
/* ===============================
   SOCKET.IO
   =============================== */

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

/* احراز هویت سوکت */
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("توکن وجود ندارد"));

    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded._id;
    next();

  } catch (err) {
    next(new Error("توکن نامعتبر است"));
  }
});

/* سوکت اصلی */
io.on('connection', (socket) => {
  const userId = socket.userId;
  const user = findUser(userId);

  if (user) {
    user.online = true;
    user.lastSeenAt = null;

    io.emit('user:online', { userId });
  }

  /* JOIN CONVERSATION */
  socket.on('private:join', ({ convId }) => {
    socket.join(convId);
  });

  /* SEND MESSAGE */
  socket.on('private:message', (payload, cb) => {
    const { convId, text, attachments, tempId } = payload;

    const conv = findConversation(convId);
    if (!conv) {
      cb && cb({ ok: false, error: "conversation not found" });
      return;
    }

    const msg = {
      _id: newId(),
      conversationId: convId,
      senderId: userId,
      text: text || "",
      attachments: attachments || [],
      createdAt: new Date().toISOString(),
      seenBy: []
    };

    DB.messages.push(msg);

    io.to(convId).emit('private:message', { message: msg });

    cb && cb({
      ok: true,
      message: msg,
      tempId
    });
  });

  /* EDIT MESSAGE */
  socket.on("message:edit", (payload, cb) => {
    const { convId, messageId, text } = payload;
    const msg = findMessage(messageId);

    if (!msg) return cb && cb({ ok: false, error: "message not found" });
    if (msg.senderId !== userId) return cb && cb({ ok: false, error: "no permission" });

    msg.text = text;
    msg.editedAt = new Date().toISOString();

    io.to(convId).emit("message:edited", { message: msg });

    cb && cb({ ok: true, message: msg });
  });

  /* DELETE MESSAGE */
  socket.on("message:delete", (payload, cb) => {
    const { messageId, forAll, forEveryone } = payload;

    const msg = findMessage(messageId);
    if (!msg) return cb && cb({ ok: false });

    // اجازه حذف
    if (msg.senderId !== userId && !forAll && !forEveryone) {
      return cb && cb({ ok: false, error: "no permission" });
    }

    DB.messages = DB.messages.filter(m => m._id !== msg._id);

    io.to(msg.conversationId).emit("message:deleted", {
      messageId: msg._id,
      convId: msg.conversationId
    });

    cb && cb({ ok: true });
  });

  /* SEEN */
  socket.on("message:seen", (payload) => {
    const { convId, ids } = payload;

    ids.forEach(id => {
      const msg = findMessage(id);
      if (msg && !msg.seenBy.includes(userId)) {
        msg.seenBy.push(userId);
      }
    });

    io.to(convId).emit("message:seen", {
      convId,
      ids
    });
  });

  /* TYPING */
  socket.on("typing", ({ convId, typing }) => {
    const meUser = findUser(userId);
    io.to(convId).emit("typing", {
      convId,
      typing,
      username: meUser ? (meUser.displayName || meUser.username) : "کاربر"
    });
  });

  /* PRESENCE PING */
  socket.on("presence:ping", () => {
    // می‌شه لاگ گرفت ولی نیازی نیست
  });

  /* DISCONNECT */
  socket.on("disconnect", () => {
    const me = findUser(userId);
    if (me) {
      me.online = false;
      me.lastAgain = new Date().toISOString();
      me.lastSeenAt = new Date().toISOString();
    }

    io.emit('user:offline', {
      userId,
      lastSeenAt: new Date().toISOString()
    });
  });
});

/* ===============================
   START SERVER
   =============================== */

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});