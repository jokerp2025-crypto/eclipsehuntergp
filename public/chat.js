/* chat.js — بخش 1 (خط 1 تا ~350)
   نسخه مرحله‌ای — این بخش پایه، هِدِرها، اتصال socket، fetchهای اصلی، رندر لیست گفتگو و رندر پیام‌ها را فراهم می‌کند.
   هماهنگ با chat.html و server.js ارسال‌شده. ظاهر HTML دست‌نخورده.
*/

/* =================== تنظیمات اولیه =================== */
const API_BASE = '/api';
const UPLOAD_ENDPOINT = '/upload/media';
const SOCKET_PATH = '/';
const TOKEN_KEY = 'eclipse:token';
const THEME_KEY = 'eclipse:theme';
const PRESENCE_INTERVAL_MS = 25000;
const SEEN_BATCH_MS = 400;
const OPTIMISTIC_TIMEOUT_MS = 120000;
const MAX_OFFLINE_QUEUE = 200;

/* =================== وضعیت محلی =================== */
let token = localStorage.getItem(TOKEN_KEY) || null;
let me = null;
let socket = null;
let isConnected = false;
let conversations = [];           // array of conversation objects
let activeConvId = null;          // currently open conversation id
let messagesCache = new Map();    // convId -> [messages]
let pendingSends = new Map();     // tempId -> {resolve,reject,timeout}
let offlineQueue = [];            // queued sends when offline
let seenQueue = new Map();        // convId -> Set(messageId)
let seenTimer = null;
let presenceTimer = null;
let theme = localStorage.getItem(THEME_KEY) || 'theme-telegram';

/* =================== یوتیلیتی‌ها =================== */
function $(id){ return document.getElementById(id); }
function q(sel, ctx=document){ return ctx.querySelector(sel); }
function nowIso(){ return (new Date()).toISOString(); }
function uid(prefix='t'){ return prefix + '_' + Math.random().toString(36).slice(2,10); }
function escapeHtml(s){ if(!s && s!==0) return ''; return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function formatTime(iso){ try{ if(!iso) return ''; const d=new Date(iso); return d.toLocaleTimeString(); }catch(e){ return ''; }}

/* =================== FETCH wrapper با هدر توکن =================== */
async function apiFetch(path, opts = {}){
  const headers = Object.assign({}, opts.headers || {});
  if(!(opts.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if(token) headers['Authorization'] = 'Bearer ' + token;
  const fetchOpts = Object.assign({ credentials: 'same-origin', headers }, opts);
  const url = (API_BASE + path).replace('//','/');
  const res = await fetch(url, fetchOpts);
  const text = await res.text().catch(()=>null);
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }catch(e){ data = null; }
  if(!res.ok){
    const err = (data && data.error) ? data.error : (text || `HTTP ${res.status}`);
    const e = new Error(String(err));
    e.status = res.status;
    e.body = data;
    throw e;
  }
  return data;
}

/* =================== Upload helper (full path) =================== */
async function apiUpload(path, formData){
  if(!token) throw new Error('not_authenticated');
  const res = await fetch(path, { method: 'POST', body: formData, headers: { 'Authorization': 'Bearer ' + token }, credentials:'same-origin' });
  const text = await res.text().catch(()=>null);
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }catch(e){ data = null; }
  if(!res.ok) throw new Error((data && data.error) ? data.error : `Upload failed ${res.status}`);
  return data;
}

/* =================== SOCKET.IO connection =================== */
function connectSocket(){
  if(socket && socket.connected) return;
  const auth = token ? { token } : {};
  socket = io(SOCKET_PATH, { auth, transports:['websocket'] });
  socket.on('connect', ()=> {
    isConnected = true;
    console.info('[chat] socket connected', socket.id);
    // join all conversation rooms
    conversations.forEach(c => { if(c && c._id) socket.emit('private:join', { convId: c._id }); });
    flushOfflineQueue();
  });
  socket.on('disconnect', (reason) => {
    isConnected = false;
    console.warn('[chat] socket disconnected', reason);
  });
  socket.on('connect_error', (err) => { console.error('[chat] socket connect_error', err && err.message); });

  // incoming message broadcast from server
  socket.on('private:message', ({ conversationId, message }) => {
    try { handleIncomingMessage(conversationId, message); } catch(e){ console.error(e); }
  });

  // edits/deletes/seens/presence
  socket.on('message:edited', ({ conversationId, message }) => {
    applyMessageUpdate(conversationId, message);
  });
  socket.on('message:deleted', ({ conversationId, messageId, deletedForAll }) => {
    applyMessageDeletion(conversationId, messageId, deletedForAll);
  });
  socket.on('message:seen', ({ conversationId, messageIds, userId }) => {
    (messageIds || []).forEach(mid => markSeenUI(conversationId, mid, userId));
  });
  socket.on('user:online', ({ userId }) => { setUserPresenceUI(userId, true); });
  socket.on('user:offline', ({ userId, lastSeenAt }) => { setUserPresenceUI(userId, false, lastSeenAt); });
  socket.on('typing', ({ convId, userId, typing }) => { showTyping(convId, userId, typing); });
}

/* =================== Presence ping (keepalive) =================== */
function startPresence(){
  if(presenceTimer) clearInterval(presenceTimer);
  presenceTimer = setInterval(()=> {
    if(socket && socket.connected) socket.emit('presence:ping');
  }, PRESENCE_INTERVAL_MS);
}
function stopPresence(){ if(presenceTimer) clearInterval(presenceTimer); presenceTimer = null; }

/* =================== Flush queued offline messages =================== */
function flushOfflineQueue(){
  if(!isConnected || !socket) return;
  while(offlineQueue.length){
    const payload = offlineQueue.shift();
    socket.emit('private:message', payload, (ack)=> {
      if(!ack || !ack.ok) console.warn('[chat] offline send ack failed', ack);
    });
  }
}

/* =================== بارگذاری اطلاعات کاربر و گفتگوها =================== */
async function loadMe(){
  try{
    const res = await apiFetch('/me');
    if(res && res.user){ me = res.user; applyProfileUI(me); connectSocket(); startPresence(); await fetchConversations(); }
  }catch(err){
    console.error('[chat] loadMe error', err);
    // اگر توکن نامعتبر است یا 401 => پاک کن و ریدایرکت یا اجازه بده لاگین کنه
    if(err.status === 401){
      localStorage.removeItem(TOKEN_KEY); token = null;
      // optional: window.location.href = '/login.html';
    }
  }
}

async function fetchConversations(){
  try{
    const res = await apiFetch('/conversations');
    conversations = (res && res.conversations) ? res.conversations : [];
    renderConversationList(conversations);
    // Open first conversation by default if none active
    if(!activeConvId && conversations.length) openConversation(conversations[0]._id);
  }catch(err){
    console.error('[chat] fetchConversations', err);
  }
}

/* =================== باز کردن گفتگو و بارگذاری پیام‌ها =================== */
async function openConversation(convId){
  if(!convId) return;
  activeConvId = convId;
  highlightActiveConv(convId);
  try{
    const res = await apiFetch(`/conversations/${convId}/messages`);
    const msgs = (res && res.messages) ? res.messages : [];
    messagesCache.set(convId, msgs.slice());
    renderMessages(convId, msgs);
    // notify server to join room
    if(socket && socket.connected) socket.emit('private:join', { convId });
    attachSeenObservers(convId);
  }catch(err){
    console.error('[chat] openConversation', err);
  }
}

/* =================== رندر لیست گفتگوها =================== */
function renderConversationList(list){
  const el = $('convList');
  if(!el) return;
  el.innerHTML = '';
  list.forEach(conv => {
    const partner = (conv.participants || []).find(p => String(p._id) !== String(me && me._id)) || (conv.participants && conv.participants[0]);
    const title = conv.title || (partner ? (partner.displayName || partner.username) : 'کاربر');
    const avatar = (partner && partner.avatarUrl) ? partner.avatarUrl : '/default.png';
    const li = document.createElement('div');
    li.className = 'conv-item';
    li.dataset.convid = conv._id;
    li.innerHTML = `
      <img class="conv-avatar" src="${escapeHtml(avatar)}" alt="avatar">
      <div class="conv-meta">
        <div class="name">${escapeHtml(title)}</div>
        <div class="last">${escapeHtml(conv.lastMessageText || '')}</div>
      </div>
    `;
    li.addEventListener('click', ()=> openConversation(conv._id));
    el.appendChild(li);
  });
}

/* =================== رندر پیام‌ها =================== */
function renderMessages(convId, messages){
  const container = $('messageList');
  if(!container) return;
  container.innerHTML = '';
  (messages || []).forEach(m => appendMessage(convId, m, false));
  container.scrollTop = container.scrollHeight;
}

/* Append a single message to UI (uses template id="tpl-message") */
function appendMessage(convId, message, autoScroll = true){
  if(String(convId) !== String(activeConvId)) return;
  const tpl = document.getElementById('tpl-message');
  const container = $('messageList');
  if(!tpl || !container) return;
  const node = tpl.content.firstElementChild.cloneNode(true);
  const mid = message._id || message.id || uid('tmp');
  node.dataset.id = mid;
  node.classList.add('message-item');
  // mark mine
  const sender = message.from || (message.senderId && (message.senderId._id || message.senderId));
  if(me && sender && String(sender) === String(me._id)) node.classList.add('mine');
  // fill name/time/text
  const nameEl = node.querySelector('.fromName'); if(nameEl) nameEl.textContent = message.fromName || message.senderName || (message.senderId && (message.senderId.displayName || message.senderId.username)) || 'کاربر';
  const timeEl = node.querySelector('.atTime'); if(timeEl) timeEl.textContent = formatTime(message.createdAt || message.ts || message.created_at);
  const textEl = node.querySelector('.message-text'); if(textEl) textEl.innerHTML = escapeHtml(message.text || '');
  // attachments
  let attachWrap = node.querySelector('.msg-attachments');
  if(!attachWrap){
    attachWrap = document.createElement('div'); attachWrap.className = 'msg-attachments';
    const bubble = node.querySelector('.message-bubble') || node;
    bubble.appendChild(attachWrap);
  }
  attachWrap.innerHTML = '';
  if(message.attachments && message.attachments.length){
    message.attachments.forEach(att => {
      if(att.mime && att.mime.startsWith('image/')){
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = att.url;
        img.alt = att.name || 'image';
        attachWrap.appendChild(img);
      } else {
        const fileEl = document.createElement('div'); fileEl.className = 'attachment-file';
        fileEl.innerHTML = `<div class="file-name">${escapeHtml(att.name||'file')}</div><div class="file-size">${Math.round((att.size||0)/1024)} KB</div>`;
        attachWrap.appendChild(fileEl);
      }
    });
  }
  // meta/status
  let meta = node.querySelector('.msg-meta');
  if(!meta){ meta = document.createElement('div'); meta.className = 'msg-meta'; node.querySelector('.message-bubble').appendChild(meta); }
  let timeSpan = node.querySelector('.msg-time');
  if(!timeSpan){ timeSpan = document.createElement('span'); timeSpan.className = 'msg-time muted small'; meta.appendChild(timeSpan); }
  timeSpan.textContent = formatTime(message.createdAt || message.ts || nowIso());
  let statusSpan = node.querySelector('.msg-status');
  if(!statusSpan){ statusSpan = document.createElement('span'); statusSpan.className = 'msg-status muted small'; meta.appendChild(statusSpan); }
  statusSpan.textContent = message.temp ? 'در حال ارسال...' : (message.status || '');

  // actions (edit/delete)
  let actions = node.querySelector('.msg-actions');
  if(!actions){
    actions = document.createElement('div'); actions.className = 'msg-actions';
    const eBtn = document.createElement('button'); eBtn.className = 'edit-btn small-btn'; eBtn.textContent = 'ویرایش';
    const dBtn = document.createElement('button'); dBtn.className = 'delete-btn small-btn'; dBtn.textContent = 'حذف';
    actions.appendChild(eBtn); actions.appendChild(dBtn);
    node.querySelector('.message-bubble').appendChild(actions);
    eBtn.addEventListener('click', ()=> startEditMessage(message));
    dBtn.addEventListener('click', ()=> startDeleteMessage(message));
  }

  container.appendChild(node);
  if(autoScroll) container.scrollTop = container.scrollHeight;
  // observe for seen if not mine
  if(!(me && String(sender) === String(me._id))) observeForSeen(node, message);
}

/* =================== دریافت پیام ورودی =================== */
function handleIncomingMessage(convId, message){
  // update cache
  const arr = messagesCache.get(convId) || [];
  arr.push(message);
  messagesCache.set(convId, arr);
  // if active, append and schedule seen
  if(String(convId) === String(activeConvId)){
    appendMessage(convId, message, true);
    scheduleSeen(convId, message._id || message.id);
  } else {
    incrementUnreadBadge(convId);
  }
}

/* =================== ارسال پیام (optimistic) =================== */
function sendMessage(convId, text, attachments = []){
  if(!convId) { alert('گفتگو انتخاب نشده'); return Promise.reject(new Error('no_conv')); }
  const tempId = uid('tmp');
  const optimisticMsg = { _id: tempId, temp: true, tempId, conversationId: convId, from: me._id, fromName: me.displayName || me.username, text, attachments, createdAt: nowIso(), status: 'sending' };
  // push to UI and cache
  const arr = messagesCache.get(convId) || []; arr.push(optimisticMsg); messagesCache.set(convId, arr);
  appendMessage(convId, optimisticMsg, true);
  // prepare payload
  const payload = { convId, tempId, text, attachments };
  return new Promise((resolve, reject) => {
    const to = setTimeout(()=> {
      pendingSends.delete(tempId);
      updateOptimisticStatus(tempId, 'failed');
      reject(new Error('send_timeout'));
    }, OPTIMISTIC_TIMEOUT_MS);
    pendingSends.set(tempId, { resolve, reject, timeout: to });
    if(socket && socket.connected){
      socket.emit('private:message', payload, (ack) => {
        if(ack && ack.ok){
          // server may broadcast message; resolve here too
          clearTimeout(to); pendingSends.delete(tempId);
          resolve(ack.message || { ok:true });
        } else {
          clearTimeout(to); pendingSends.delete(tempId); updateOptimisticStatus(tempId, 'failed');
          reject(new Error((ack && ack.error) ? ack.error : 'send_failed'));
        }
      });
    } else {
      // offline queue
      optimisticMsg.status = 'queued';
      offlineQueue.push(payload);
      if(offlineQueue.length > MAX_OFFLINE_QUEUE) offlineQueue.shift();
      clearTimeout(to); pendingSends.delete(tempId);
      resolve(optimisticMsg);
    }
  });
}

/* =================== بروزرسانی optimistic UI =================== */
function updateOptimisticStatus(tempId, status){
  const node = document.querySelector(`[data-id="${tempId}"]`);
  if(node){
    const s = node.querySelector('.msg-status');
    if(s) s.textContent = status;
  }
}

/* ===========================
   Conversation Rendering
   =========================== */

function renderConversationList(conversations) {
    const container = document.getElementById('convList');
    if (!container) return;

    container.innerHTML = '';

    conversations.forEach(conv => {
        const other = conv.participants.find(p => p._id !== currentUser._id);
        if (!other) return;

        const el = document.createElement('div');
        el.className = 'conversation-item';
        el.dataset.id = conv._id;

        el.innerHTML = `
            <div class="avatar">
                <img src="${other.avatarUrl || '/default-avatar.png'}" alt="">
            </div>
            <div class="conversation-info">
                <div class="conversation-name">${other.displayName || other.username}</div>
                <div class="conversation-lastmsg">${conv.lastMessage || ''}</div>
            </div>
        `;

        el.addEventListener('click', () => {
            loadConversation(conv._id, other);
        });

        container.appendChild(el);
    });
}

/* ===========================
   Load Conversation
   =========================== */

async function loadConversation(convId, targetUser) {
    activeConversation = convId;

    const header = document.getElementById('chatHeaderName');
    if (header) header.textContent = targetUser.displayName || targetUser.username;

    const avatar = document.getElementById('chatHeaderAvatar');
    if (avatar) avatar.src = targetUser.avatarUrl || '/default-avatar.png';

    await fetchMessages(convId);

    joinSocketRoom(convId);
}

/* ===========================
   Fetch Messages
   =========================== */

async function fetchMessages(conversationId) {
    try {
        const data = await apiFetch(`/conversations/${conversationId}/messages`);
        if (!data || !data.messages) return;

        renderMessages(data.messages);

        scrollMessagesToBottom();
    } catch (err) {
        console.error('Fetch messages error:', err);
    }
}

/* ===========================
   Render Messages
   =========================== */

function renderMessages(messages) {
    const container = document.getElementById('messageList');
    if (!container) return;

    container.innerHTML = '';

    messages.forEach(m => appendMessage(m));
}

/* ===========================
   Append Message
   =========================== */

function appendMessage(m) {
    const container = document.getElementById('messageList');
    if (!container) return;

    const isMine = m.senderId === currentUser._id || m.from === currentUser._id;

    const wrapper = document.createElement('div');
    wrapper.className = isMine ? 'message mine' : 'message';

    let textHTML = '';
    if (m.text && m.text.trim() !== '') {
        textHTML = `<div class="msg-text">${escapeHTML(m.text)}</div>`;
    }

    let attachmentHTML = '';
    if (m.attachments && m.attachments.length > 0) {
        attachmentHTML = m.attachments.map(a => renderAttachment(a)).join('');
    }

    wrapper.innerHTML = `
        <div class="msg-bubble">
            ${textHTML}
            ${attachmentHTML}
            <div class="msg-time">${formatTime(m.createdAt)}</div>
        </div>
    `;

    container.appendChild(wrapper);
}

/* ===========================
   Attachment Renderer
   =========================== */

function renderAttachment(a) {
    if (a.type.startsWith('image/')) {
        return `<img class="msg-img" src="${a.url}" />`;
    }
    return `
        <a class="msg-file" href="${a.url}" target="_blank">
            ${a.name}
        </a>
    `;
}

/* ===========================
   Utility
   =========================== */

function escapeHTML(str) {
    return str.replace(/[&<>"]/g, c => {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ===========================
   Scroll
   =========================== */

function scrollMessagesToBottom() {
    const container = document.getElementById('messageList');
    if (!container) return;
    container.scrollTop = container.scrollHeight;
}

/* ===========================
   Join Room
   =========================== */

function joinSocketRoom(convId) {
    if (!socket) return;
    socket.emit('join:conversation', { conversationId: convId });
}

/* ===========================
   Send Message
   =========================== */

async function sendMessage() {
    if (!activeConversation) return;

    const input = document.getElementById('messageInput');
    if (!input) return;

    const text = input.value.trim();
    if (text === '') return;

    const tempId = 'temp_' + Date.now();

    const optimisticMsg = {
        _id: tempId,
        text,
        senderId: currentUser._id,
        createdAt: new Date().toISOString(),
        attachments: []
    };

    appendMessage(optimisticMsg);
    scrollMessagesToBottom();

    input.value = '';

    socket.emit(
        'private:message',
        { conversationId: activeConversation, text },
        ack => {
            if (!ack || !ack.ok) {
                console.error('Message send failed:', ack);
            }
        }
    );
}

/* ===========================
   Send Button
   =========================== */

const sendBtn = document.getElementById('sendBtn');
if (sendBtn) {
    sendBtn.addEventListener('click', sendMessage);
}

const msgInput = document.getElementById('messageInput');
if (msgInput) {
    msgInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') sendMessage();
    });
}

/* ===========================
   Socket Incoming Messages
   =========================== */

function setupSocketListeners() {
    if (!socket) return;

    socket.on('private:message', payload => {
        if (!payload || payload.conversationId !== activeConversation) return;

        appendMessage(payload.message);
        scrollMessagesToBottom();
    });

    socket.on('message:edited', payload => {
        updateEditedMessage(payload.message);
    });

    socket.on('message:deleted', payload => {
        removeMessageFromUI(payload.messageId);
    });
}

/* ===========================
   Update Edited Message
   =========================== */

function updateEditedMessage(msg) {
    const container = document.getElementById('messageList');
    if (!container) return;

    const nodes = container.querySelectorAll('.message');

    nodes.forEach(n => {
        if (n.dataset.id === msg._id) {
            const bubble = n.querySelector('.msg-bubble');
            if (bubble) {
                bubble.querySelector('.msg-text').textContent = msg.text + ' (edited)';
            }
        }
    });
}

/* ===========================
   Remove Message From UI
   =========================== */

function removeMessageFromUI(id) {
    const container = document.getElementById('messageList');
    if (!container) return;

    const nodes = container.querySelectorAll('.message');

    nodes.forEach(n => {
        if (n.dataset.id === id) {
            n.remove();
        }
    });
}

/* ===========================
   Edit Message
   =========================== */

let editingMessageId = null;

function startEditingMessage(msgId, oldText) {
    const input = document.getElementById('messageInput');
    if (!input) return;

    editingMessageId = msgId;
    input.value = oldText;
    input.focus();

    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) sendBtn.textContent = "Save";
}

async function finishEditingMessage() {
    if (!editingMessageId) return;

    const input = document.getElementById('messageInput');
    if (!input) return;

    const newText = input.value.trim();
    if (newText === '') return;

    socket.emit(
        'message:edit',
        {
            messageId: editingMessageId,
            text: newText
        },
        ack => {
            if (!ack || !ack.ok) {
                console.error("Edit failed:", ack);
            }
        }
    );

    editingMessageId = null;
    input.value = "";

    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) sendBtn.textContent = "Send";
}

/* ===========================
   Delete Message
   =========================== */

function deleteMessage(msgId) {
    socket.emit('message:delete', { messageId: msgId }, ack => {
        if (!ack || !ack.ok) {
            console.error("Delete failed:", ack);
        }
    });
}

/* ===========================
   Seen Indicator
   =========================== */

function sendSeenStatus() {
    if (!activeConversation) return;
    socket.emit('message:seen', { conversationId: activeConversation });
}

function updateSeenUI(messageId) {
    const container = document.getElementById('messageList');
    if (!container) return;

    const nodes = container.querySelectorAll('.message.mine');

    nodes.forEach(n => {
        if (n.dataset.id === messageId) {
            let time = n.querySelector('.msg-time');
            if (time && !time.textContent.includes('✓')) {
                time.textContent += ' ✓';
            }
        }
    });
}

/* ===========================
   Typing Indicator
   =========================== */

let typingTimeout = null;

function sendTyping() {
    if (!activeConversation) return;

    socket.emit('typing:start', { conversationId: activeConversation });

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('typing:stop', { conversationId: activeConversation });
    }, 1500);
}

function renderTypingIndicator(username) {
    const el = document.getElementById('typingIndicator');
    if (!el) return;

    el.textContent = username + " is typing...";
    el.style.display = 'block';
}

function hideTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (!el) return;

    el.style.display = 'none';
}

/* ===========================
   Saved Messages (Self-Chat)
   =========================== */

async function openSavedMessages() {
    try {
        const data = await apiFetch('/conversations/self');
        if (!data || !data.conversationId) return;

        activeConversation = data.conversationId;

        const header = document.getElementById('chatHeaderName');
        if (header) header.textContent = "Saved Messages";

        const avatar = document.getElementById('chatHeaderAvatar');
        if (avatar) avatar.src = "/saved.png";

        await fetchMessages(activeConversation);
        joinSocketRoom(activeConversation);

    } catch (err) {
        console.error("Saved messages error:", err);
    }
}

const savedBtn = document.getElementById('openSaved');
if (savedBtn) {
    savedBtn.addEventListener('click', openSavedMessages);
}

/* ===========================
   Start New Chat
   =========================== */

async function startNewChat() {
    const username = prompt("Enter username or ID:");
    if (!username) return;

    try {
        const user = await apiFetch(`/users/find?query=${username}`);

        if (!user || !user._id) {
            alert("User not found");
            return;
        }

        const conv = await apiFetch('/conversations/create', {
            method: "POST",
            body: JSON.stringify({ userId: user._id })
        });

        if (conv && conv.conversationId) {
            activeConversation = conv.conversationId;
            loadConversation(conv.conversationId, user);
        }

    } catch (err) {
        console.error("Start new chat error:", err);
        alert("Error starting chat");
    }
}

const newChatBtn = document.getElementById('startChatBtn');
if (newChatBtn) {
    newChatBtn.addEventListener('click', startNewChat);
}

/* ===========================
   Socket Event Listeners
   =========================== */

if (socket) {
    socket.on('private:message', payload => {
        if (!payload) return;

        if (payload.conversationId === activeConversation) {
            appendMessage(payload.message);
            scrollMessagesToBottom();
            sendSeenStatus();
        }
    });

    socket.on('message:edited', payload => {
        updateEditedMessage(payload.message);
    });

    socket.on('message:deleted', payload => {
        removeMessageFromUI(payload.messageId);
    });

    socket.on('message:seen', payload => {
        updateSeenUI(payload.messageId);
    });

    socket.on('typing:start', payload => {
        if (payload.userId !== currentUser._id) {
            renderTypingIndicator(payload.username);
        }
    });

    socket.on('typing:stop', () => {
        hideTypingIndicator();
    });
}

/* ===========================
   Input Typing Listener
   =========================== */

if (msgInput) {
    msgInput.addEventListener('input', () => {
        sendTyping();
    });
}

/* ===========================
   Logout
   =========================== */

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('token');
        sessionStorage.removeItem('token');
        window.location.href = '/login.html';
    });
}

/* ===========================
   Init Application
   =========================== */

async function initChat() {
    try {
        currentUser = await apiFetch('/me');

        await loadConversations();

        setupSocketListeners();

    } catch (err) {
        console.error("Init chat failed:", err);
        alert("Authentication failed, please login again.");
        window.location.href = "/login.html";
    }
}

initChat();
/* ===========================
   File / Media Upload
   =========================== */

const fileInput = document.getElementById('fileInput');
const attachmentBtn = document.getElementById('attachmentBtn');

if (attachmentBtn && fileInput) {
    attachmentBtn.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', handleFileUpload);
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!activeConversation) {
        alert("Select a conversation first.");
        return;
    }

    try {
        const uploaded = await uploadMedia(file);

        socket.emit(
            'private:message',
            {
                conversationId: activeConversation,
                text: "",
                attachments: [uploaded]
            },
            ack => {
                if (!ack || !ack.ok) {
                    console.error("File send failed", ack);
                }
            }
        );
    } catch (err) {
        console.error("Upload error:", err);
        alert("Upload failed.");
    }

    event.target.value = "";
}

/* ===========================
   Upload Function
   =========================== */

async function uploadMedia(file) {
    const token =
        localStorage.getItem('token') ||
        sessionStorage.getItem('token') ||
        null;

    const form = new FormData();
    form.append("media", file);

    const res = await fetch('/upload/media', {
        method: 'POST',
        headers: {
            'Authorization': token ? 'Bearer ' + token : ''
        },
        body: form
    });

    if (!res.ok) {
        throw new Error("Upload failed " + res.status);
    }

    const data = await res.json();

    return {
        url: data.url,
        type: detectFileType(file),
        name: file.name,
        size: file.size
    };
}

/* ===========================
   Detect File Type
   =========================== */

function detectFileType(file) {
    const type = file.type;

    if (type.startsWith("image/")) return "image";
    if (type.startsWith("audio/")) return "audio";
    if (type.startsWith("video/")) return "video";

    return "file";
}

/* ===========================
   Render Media
   =========================== */

function renderAttachment(msg, wrapper) {
    if (!msg.attachments || msg.attachments.length === 0) return;

    msg.attachments.forEach(att => {
        const el = document.createElement('div');
        el.className = "message-attachment";

        if (att.type === "image") {
            const img = document.createElement('img');
            img.src = att.url;
            img.className = "msg-image";
            el.appendChild(img);
        }

        else if (att.type === "audio") {
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = att.url;
            el.appendChild(audio);
        }

        else if (att.type === "video") {
            const vid = document.createElement('video');
            vid.controls = true;
            vid.style.maxWidth = "240px";
            vid.src = att.url;
            el.appendChild(vid);
        }

        else {
            const a = document.createElement('a');
            a.href = att.url;
            a.textContent = att.name || "Download File";
            a.target = "_blank";
            el.appendChild(a);
        }

        wrapper.appendChild(el);
    });
}

/* ===========================
   Embed in appendMessage()
   =========================== */

function appendMessage(msg) {
    const container = document.getElementById('messageList');
    if (!container) return;

    const wrap = document.createElement('div');
    wrap.className = msg.from === currentUser._id ? "message mine" : "message";

    wrap.dataset.id = msg._id;

    const text = document.createElement('div');
    text.className = "msg-text";
    text.textContent = msg.text || "";
    wrap.appendChild(text);

    renderAttachment(msg, wrap);

    const time = document.createElement('div');
    time.className = "msg-time";
    time.textContent = formatTime(msg.createdAt);
    wrap.appendChild(time);

    container.appendChild(wrap);
}
/* PART 5 — FINAL SYNC, SEEN, TYPING, PRESENCE, CONTEXT MENU, CLEANUP
   Paste this after previous parts. No HTML/CSS changes. */

(function(){
  // compatibility aliases (in case earlier parts used different names)
  if(typeof currentUser === 'undefined' && typeof me !== 'undefined') currentUser = me;
  if(typeof me === 'undefined' && typeof currentUser !== 'undefined') me = currentUser;
  if(typeof activeConversation === 'undefined' && typeof activeConvId !== 'undefined') activeConversation = activeConvId;
  if(typeof activeConvId === 'undefined' && typeof activeConversation !== 'undefined') activeConvId = activeConversation;

  // local state
  let seenBuffer = new Map(); // convId -> Set(messageId)
  let seenFlushTimer = null;
  const SEEN_FLUSH_DELAY = 600; // ms
  let typingState = { lastSent: 0, sending: false, throttle: 800 };
  let presenceShown = new Map(); // userId -> {online,lastSeenAt}
  let contextMenu = null;

  // safe getters
  function getActiveConv(){ return (typeof activeConversation !== 'undefined' && activeConversation) ? activeConversation : (typeof activeConvId !== 'undefined' ? activeConvId : null); }
  function getCurrentUserId(){ return (me && me._id) ? String(me._id) : (currentUser && currentUser._id ? String(currentUser._id) : null); }

  /* -------------------- Seen batching -------------------- */
  function queueSeen(convId, messageId){
    if(!convId || !messageId) return;
    if(!seenBuffer.has(convId)) seenBuffer.set(convId, new Set());
    seenBuffer.get(convId).add(messageId);
    if(seenFlushTimer) clearTimeout(seenFlushTimer);
    seenFlushTimer = setTimeout(flushSeenBuffer, SEEN_FLUSH_DELAY);
  }

  function flushSeenBuffer(){
    if(!socket || !socket.connected) { seenBuffer.clear(); return; }
    for(const [convId, setIds] of seenBuffer.entries()){
      const ids = Array.from(setIds);
      if(ids.length){
        socket.emit('message:seen', { conversationId: convId, messageIds: ids }, (ack) => {
          // optional ack handling
        });
      }
    }
    seenBuffer.clear();
    if(seenFlushTimer){ clearTimeout(seenFlushTimer); seenFlushTimer = null; }
  }

  function scheduleSeenForVisibleMessages(){
    const convId = getActiveConv();
    if(!convId) return;
    const list = document.getElementById('messageList');
    if(!list) return;
    const nodes = list.querySelectorAll('.message-item, .message');
    nodes.forEach(node => {
      const id = node.dataset.id || node.dataset['id'] || node.dataset['msgid'];
      if(!id) return;
      // choose threshold: if element is in view (50% visible)
      const rect = node.getBoundingClientRect();
      const viewH = window.innerHeight || document.documentElement.clientHeight;
      if(rect.top >= 0 && rect.top < viewH - 40){
        queueSeen(getActiveConv(), id);
      }
    });
  }

  // call scheduleSeen on scroll and focus
  const messagesContainer = document.getElementById('messageList');
  if(messagesContainer){
    messagesContainer.addEventListener('scroll', debounce(scheduleSeenForVisibleMessages, 220));
    window.addEventListener('focus', scheduleSeenForVisibleMessages);
  }

  /* -------------------- Mark seen UI -------------------- */
  function markSeenUI(convId, messageId, userId){
    const node = document.querySelector(`[data-id="${messageId}"], [data-id='${messageId}']`);
    if(!node) return;
    // if userId equals currentUserId, mark tick for own messages
    const curId = getCurrentUserId();
    if(String(userId) === String(curId)){
      const statusEl = node.querySelector('.msg-status, .msg-time, .status');
      if(statusEl) statusEl.textContent = '✔✔';
    } else {
      // show user seen small indicator near message (optional)
      let seenEl = node.querySelector('.msg-seen-by');
      if(!seenEl){
        seenEl = document.createElement('span');
        seenEl.className = 'msg-seen-by small muted';
        node.querySelector('.message-bubble')?.appendChild(seenEl);
      }
      const info = presenceShown.get(String(userId)) || {};
      seenEl.textContent = info.displayName ? `seen by ${info.displayName}` : 'seen';
    }
  }

  /* -------------------- Socket presence & typing handlers -------------------- */
  function setupRealtimeHandlers(){
    if(!socket) return;

    socket.off('message:edited').on('message:edited', payload => {
      if(!payload) return;
      applyMessageEdit(payload.conversationId || payload.convId, payload.message || payload);
    });

    socket.off('message:deleted').on('message:deleted', payload => {
      if(!payload) return;
      applyMessageDeletion(payload.conversationId || payload.convId, payload.messageId || payload.id, payload.deletedForAll);
    });

    socket.off('message:seen').on('message:seen', payload => {
      if(!payload) return;
      const conv = payload.conversationId || payload.convId;
      const ids = payload.messageIds || payload.ids || [];
      const userId = payload.userId || payload.user;
      ids.forEach(id => markSeenUI(conv, id, userId));
    });

    socket.off('typing').on('typing', ({ convId, userId, typing }) => {
      if(!convId || convId !== getActiveConv()) return;
      if(typing){
        renderTypingIndicator((presenceShown.get(String(userId))||{}).displayName || 'typing...');
      } else {
        hideTypingIndicator();
      }
    });

    socket.off('user:online').on('user:online', ({ userId }) => {
      setUserPresenceUI(userId, true);
    });

    socket.off('user:offline').on('user:offline', ({ userId, lastSeenAt }) => {
      setUserPresenceUI(userId, false, lastSeenAt);
    });
  }

  // ensure setup once
  setupRealtimeHandlers();

  /* -------------------- Apply edits/deletes -------------------- */
  function applyMessageEdit(convId, message){
    // update cache
    const arr = messagesCache.get(convId) || [];
    for(let i=0;i<arr.length;i++){
      if(String(arr[i]._id || arr[i].id) === String(message._id || message.id)){
        arr[i] = message;
        break;
      }
    }
    messagesCache.set(convId, arr);
    // update UI
    const node = document.querySelector(`[data-id="${message._id}"], [data-id='${message.id}']`);
    if(node){
      const mt = node.querySelector('.message-text, .msg-text, .msg-text');
      if(mt) mt.innerHTML = escapeHtml(message.text || '');
      // show edited badge
      let edited = node.querySelector('.message-edited');
      if(!edited){
        edited = document.createElement('span'); edited.className = 'message-edited small muted'; edited.textContent = ' (edited)';
        node.querySelector('.message-bubble')?.appendChild(edited);
      }
    }
  }

  function applyMessageDeletion(convId, messageId, deletedForAll){
    const arr = messagesCache.get(convId) || [];
    for(let i=0;i<arr.length;i++){
      if(String(arr[i]._id || arr[i].id) === String(messageId)){
        arr[i].deleted = true;
        arr[i].deletedForAll = !!deletedForAll;
        break;
      }
    }
    messagesCache.set(convId, arr);
    const node = document.querySelector(`[data-id="${messageId}"]`);
    if(node){
      if(deletedForAll){
        const mt = node.querySelector('.message-text, .msg-text');
        if(mt) mt.textContent = 'Message deleted';
        const attach = node.querySelector('.msg-attachments');
        if(attach) attach.innerHTML = '';
      } else {
        const mt = node.querySelector('.message-text, .msg-text');
        if(mt) mt.textContent = 'You deleted this message';
      }
      node.classList.add('deleted');
    }
  }

  /* -------------------- Context menu for messages -------------------- */
  function createContextMenu(){
    if(contextMenu) return contextMenu;
    const menu = document.createElement('div');
    menu.className = 'chat-context-menu';
    menu.style.position = 'absolute';
    menu.style.display = 'none';
    menu.style.zIndex = 9999;
    menu.innerHTML = `
      <div class="ctx-item" data-action="copy">Copy</div>
      <div class="ctx-item" data-action="edit">Edit</div>
      <div class="ctx-item" data-action="delete">Delete</div>
      <div class="ctx-item" data-action="save">Save</div>
    `;
    document.body.appendChild(menu);
    menu.addEventListener('click', (ev)=>{
      const item = ev.target.closest('.ctx-item');
      if(!item) return;
      const action = item.dataset.action;
      const targetId = menu.dataset.msgid;
      handleContextAction(action, targetId);
      hideContextMenu();
    });
    contextMenu = menu;
    document.addEventListener('click', (e)=> { if(contextMenu && !e.target.closest('.chat-context-menu')) hideContextMenu(); });
    window.addEventListener('resize', hideContextMenu);
    return menu;
  }

  function showContextMenuFor(node, msgId, x, y){
    const menu = createContextMenu();
    menu.dataset.msgid = msgId;
    menu.style.left = (x + 2) + 'px';
    menu.style.top = (y + 2) + 'px';
    menu.style.display = 'block';
  }

  function hideContextMenu(){
    if(contextMenu) contextMenu.style.display = 'none';
  }

  function handleContextAction(action, msgId){
    const node = document.querySelector(`[data-id="${msgId}"]`);
    if(!node) return;
    const message = findMessageInCache(msgId);
    switch(action){
      case 'copy':
        copyTextToClipboard(message && (message.text || ''));
        break;
      case 'edit':
        if(message && String(message.from || message.senderId) === String(getCurrentUserId())){
          startEditingMessage(msgId, message.text || '');
        } else {
          alert('You can only edit your own messages.');
        }
        break;
      case 'delete':
        if(confirm('Delete this message for everyone? OK = yes')){
          if(socket && socket.connected) socket.emit('message:delete', { messageId: msgId, forAll: true }, ()=>{});
          else apiFetch(`/messages/${msgId}`, { method:'DELETE', body: JSON.stringify({ forEveryone: true }) }).catch(()=>{});
        }
        break;
      case 'save':
        // Save to saved messages via server endpoint
        if(message){
          apiFetch('/saved', { method:'POST', body: JSON.stringify({ messageId: msgId }) }).then(()=>{ alert('Saved'); }).catch(()=>{ alert('Save failed'); });
        }
        break;
    }
  }

  function attachMessageContextHandlers(){
    const list = document.getElementById('messageList');
    if(!list) return;
    list.addEventListener('contextmenu', (ev)=>{
      ev.preventDefault();
      const node = ev.target.closest('.message-item, .message');
      if(!node) return;
      const msgId = node.dataset.id;
      showContextMenuFor(node, msgId, ev.pageX, ev.pageY);
    });
  }

  attachMessageContextHandlers();

  /* -------------------- Utility helpers -------------------- */
  function findMessageInCache(msgId){
    for(const [convId, arr] of messagesCache.entries()){
      for(const m of arr){
        if(String(m._id || m.id) === String(msgId)) return m;
      }
    }
    return null;
  }

  function copyTextToClipboard(text){
    if(!navigator.clipboard) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); alert('Copied'); } catch(e){ alert('Copy failed'); }
      ta.remove();
      return;
    }
    navigator.clipboard.writeText(text).then(()=>{ /* copied */ }, ()=>{ alert('Copy failed'); });
  }

  function escapeHtml(s){ if(!s && s!==0) return ''; return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  /* -------------------- Typing send throttle -------------------- */
  function userTyped(){
    const now = Date.now();
    if(!socket || !socket.connected) return;
    if(now - typingState.lastSent > typingState.throttle){
      socket.emit('typing', { convId: getActiveConv(), typing: true });
      typingState.lastSent = now;
      if(typingState.sending) clearTimeout(typingState.sending);
      typingState.sending = setTimeout(()=> {
        socket.emit('typing', { convId: getActiveConv(), typing: false });
        typingState.sending = null;
      }, 1500);
    }
  }

  const inputEl = document.getElementById('composerInput') || document.getElementById('messageInput');
  if(inputEl){
    inputEl.addEventListener('input', debounce(()=>{ userTyped(); }, 180));
  }

  /* -------------------- Presence UI update -------------------- */
  function setUserPresenceUI(userId, online, lastSeenAt){
    presenceShown.set(String(userId), { online: !!online, lastSeenAt: lastSeenAt || null, displayName: (userId===getCurrentUserId() ? (me && (me.displayName||me.username)) : null) });
    // if the user is the current chat partner, update header
    const conv = conversations.find(c => String(c._id) === String(getActiveConv()));
    if(conv){
      const partner = (conv.participants || []).find(p => String(p._id) !== String(getCurrentUserId()));
      if(partner && String(partner._id) === String(userId)){
        const status = document.getElementById('chatStatus') || document.getElementById('convSubtitle') || document.getElementById('convSubtitle');
        if(status){
          status.textContent = online ? 'online' : ('last seen: ' + (lastSeenAt ? new Date(lastSeenAt).toLocaleString() : 'unknown'));
        }
      }
    }
  }

  /* -------------------- Clear local caches / logout -------------------- */
  function clearLocalData(){
    messagesCache.clear();
    conversations = [];
    pendingSends.clear();
    offlineQueue = [];
    localStorage.removeItem('chat_cache');
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    // clear UI
    const convList = document.getElementById('convList'); if(convList) convList.innerHTML = '';
    const msgList = document.getElementById('messageList'); if(msgList) msgList.innerHTML = '';
  }

  function doLogout(){
    clearLocalData();
    if(socket){ try{ socket.disconnect(); }catch(e){} socket = null; }
    window.location.href = '/login.html';
  }

  const clearBtn = document.getElementById('clearLocalBtn');
  if(clearBtn) clearBtn.addEventListener('click', ()=> { if(confirm('Clear local data?')) clearLocalData(); });

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', doLogout);