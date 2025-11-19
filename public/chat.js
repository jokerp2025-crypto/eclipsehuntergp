/* chat.js — Clean rebuilt version (A)
   - Readable, modular, compatible with chat۱.html, chat.css and server.js
   - Features: socket connect, optimistic send, upload, edit/delete, seen batching,
     typing indicator, presence ping, responsive-safe DOM handling.
   - Author: rebuilt by assistant
*/

/* =======================
   CONFIG / CONSTANTS
   ======================= */
const API_BASE = '/api';
const UPLOAD_PATH = '/upload/media';
const SOCKET_URL = '/';
const TOKEN_KEY = 'eclipse:token';
const THEME_KEY = 'eclipse:theme';

const PRESENCE_INTERVAL = 25000; // ms
const SEEN_BATCH_DELAY = 400; // ms
const OPTIMISTIC_TIMEOUT = 120000; // ms
const MAX_OFFLINE_QUEUE = 200;

/* =======================
   UTILITIES
   ======================= */
function $id(id){ return document.getElementById(id); }
function q(sel, ctx=document){ return ctx.querySelector(sel); }

function uid(prefix='id'){
  return prefix + '_' + Math.random().toString(36).slice(2,10);
}

function nowIso(){ return (new Date()).toISOString(); }

function escapeHtml(s){
  if(s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function formatTime(iso){
  if(!iso) return '';
  try{
    const d = new Date(iso);
    return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  }catch(e){
    return '';
  }
}

/* =======================
   GLOBAL STATE
   ======================= */
let token = localStorage.getItem(TOKEN_KEY) || null;
let me = null;
let socket = null;
let isConnected = false;

let conversations = [];
let activeConvId = null;
let messagesCache = new Map(); // convId -> array(messages)

let pendingSends = new Map(); // tempId -> {resolve,reject,timeout}
let offlineQueue = []; // payloads
let seenBuffer = new Map(); // convId -> Set(messageIds)
let seenFlushTimer = null;
let presenceTimer = null;

/* =======================
   API HELPERS
   ======================= */
async function apiFetch(path, opts = {}){
  const headers = Object.assign({}, opts.headers || {});
  if(!(opts.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if(token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch((API_BASE + path).replace('//','/'), Object.assign({ credentials:'same-origin', headers }, opts));
  const text = await res.text().catch(()=>null);
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }catch(e){ data = null; }
  if(!res.ok){
    const err = (data && data.error) ? data.error : (text || `HTTP ${res.status}`);
    const ex = new Error(String(err));
    ex.status = res.status;
    ex.body = data;
    throw ex;
  }
  return data;
}

async function apiUpload(path, formData){
  const headers = {};
  if(token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { method:'POST', body: formData, headers, credentials:'same-origin' });
  const data = await res.json().catch(()=>null);
  if(!res.ok) throw new Error((data && data.error) ? data.error : `Upload failed ${res.status}`);
  return data;
}

/* =======================
   SOCKET / PRESENCE
   ======================= */
function connectSocket(){
  if(socket && socket.connected) return;
  if(!token) return;
  socket = io(SOCKET_URL, { auth: { token }, transports:['websocket'] });
  socket.on('connect', ()=> {
    isConnected = true;
    console.info('[chat] socket connected', socket.id);
    // join existing convs
    conversations.forEach(c => { if(c && c._id) socket.emit('private:join', { convId: c._id }); });
    flushOfflineQueue();
  });
  socket.on('disconnect', (reason)=> {
    isConnected = false;
    console.warn('[chat] socket disconnected', reason);
  });
  socket.on('connect_error', err => console.error('[chat] socket connect_error', err && err.message));
  setupSocketListeners();
  startPresence();
}

function startPresence(){
  if(presenceTimer) clearInterval(presenceTimer);
  presenceTimer = setInterval(()=> {
    if(socket && socket.connected) socket.emit('presence:ping');
  }, PRESENCE_INTERVAL);
}
function stopPresence(){ if(presenceTimer) clearInterval(presenceTimer); presenceTimer = null; }

/* =======================
   OFFLINE QUEUE
   ======================= */
function flushOfflineQueue(){
  if(!socket || !socket.connected) return;
  while(offlineQueue.length){
    const payload = offlineQueue.shift();
    socket.emit('private:message', payload, (ack)=> {
      if(!ack || !ack.ok) console.warn('[chat] offline send ack failed', ack);
    });
  }
}

/* =======================
   INITIAL LOAD
   ======================= */
async function loadMe(){
  try{
    const res = await apiFetch('/me');
    if(res && res.user){
      me = res.user;
      token = token || localStorage.getItem(TOKEN_KEY) || null;
      applyProfileUI(me);
      await fetchConversations();
      connectSocket();
    }
  }catch(err){
    console.error('loadMe', err);
    if(err && err.status === 401){
      localStorage.removeItem(TOKEN_KEY);
      token = null;
    }
  }
}

/* =======================
   CONVERSATIONS
   ======================= */
async function fetchConversations(){
  try{
    const res = await apiFetch('/conversations');
    conversations = (res && res.conversations) ? res.conversations : [];
    renderConversationList(conversations);
    if(!activeConvId && conversations.length) openConversation(conversations[0]._id);
  }catch(e){ console.error('fetchConversations', e); }
}
/* =======================
   OPEN CONVERSATION
   ======================= */
async function openConversation(convId){
  if(!convId) return;
  activeConvId = convId;

  // highlight in UI
  highlightActiveConv(convId);

  // fetch messages
  try{
    const res = await apiFetch(`/conversations/${convId}/messages`);
    const msgs = Array.isArray(res.messages) ? res.messages : [];
    messagesCache.set(convId, msgs.slice());
    renderMessages(convId, msgs);

    // join room
    if(socket && socket.connected){
      socket.emit('private:join', { convId });
    }

    // activate seen observer
    attachSeenObservers(convId);
  }catch(e){
    console.error('openConversation', e);
  }
}

/* =======================
   RENDER CONVERSATION LIST
   ======================= */
function renderConversationList(list){
  const wrap = $id('convList');
  if(!wrap) return;
  wrap.innerHTML = '';

  list.forEach(conv=>{
    const partner =
      (conv.participants||[])
        .find(p=>String(p._id)!==String(me && me._id))
      || (conv.participants && conv.participants[0]);

    const title = conv.title ||
      (partner ? (partner.displayName||partner.username) : 'کاربر');

    const avatar =
      (partner && partner.avatarUrl)
        ? partner.avatarUrl
        : '/default.png';

    const item = document.createElement('div');
    item.className = 'conv-item';
    item.dataset.convid = conv._id;
    item.innerHTML = `
      <img class="conv-avatar" src="${escapeHtml(avatar)}" alt="avatar">
      <div class="conv-meta">
        <div class="name">${escapeHtml(title)}</div>
        <div class="last">${escapeHtml(conv.lastMessageText||'')}</div>
      </div>
    `;
    item.addEventListener('click',()=>openConversation(conv._id));
    wrap.appendChild(item);
  });
}

/* =======================
   RENDER MESSAGES
   ======================= */
function renderMessages(convId, messages){
  const box = $id('messageList');
  if(!box) return;
  box.innerHTML = '';
  (messages||[]).forEach(m=>appendMessage(convId, m, false));
  box.scrollTop = box.scrollHeight;
}

/* =======================
   APPEND SINGLE MESSAGE
   ======================= */
function appendMessage(convId, message, autoScroll=true){
  if(String(convId)!==String(activeConvId)) return;

  const tpl = document.getElementById('tpl-message');
  const box = $id('messageList');
  if(!tpl || !box) return;

  const node = tpl.content.firstElementChild.cloneNode(true);
  const mid = message._id || message.id || uid('tmp');

  node.dataset.id = mid;
  node.classList.add('message-item');

  const sender = message.from ||
    (message.senderId && (message.senderId._id||message.senderId));

  // mine?
  if(me && sender && String(sender)===String(me._id)){
    node.classList.add('mine');
  }

  // sender name
  const nameEl = node.querySelector('.fromName');
  if(nameEl){
    nameEl.textContent =
      message.fromName ||
      message.senderName ||
      (message.senderId &&
        (message.senderId.displayName||message.senderId.username)) ||
      'کاربر';
  }

  // time
  const timeEl = node.querySelector('.msg-time');
  if(timeEl){
    timeEl.textContent = formatTime(message.createdAt || message.ts || message.created_at);
  }

  // text
  const textEl = node.querySelector('.message-text');
  if(textEl) textEl.innerHTML = escapeHtml(message.text||'');

  // attachments
  let attWrap = node.querySelector('.msg-attachments');
  if(!attWrap){
    attWrap = document.createElement('div');
    attWrap.className = 'msg-attachments';
    node.querySelector('.message-bubble').appendChild(attWrap);
  }
  attWrap.innerHTML = '';

  if(message.attachments && message.attachments.length){
    message.attachments.forEach(att=>{
      if((att.mime && att.mime.startsWith('image/'))
        || (att.type==='image')){
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = att.url;
        img.alt = att.name||'image';
        attWrap.appendChild(img);
      }else{
        const el = document.createElement('div');
        el.className='attachment-file';
        el.innerHTML = `
          <div class="file-name">${escapeHtml(att.name||'file')}</div>
          <div class="file-size">${Math.round((att.size||0)/1024)} KB</div>
        `;
        attWrap.appendChild(el);
      }
    });
  }

  // meta
  let meta = node.querySelector('.message-meta');
  if(!meta){
    meta = document.createElement('div');
    meta.className='message-meta';
    node.querySelector('.message-bubble').appendChild(meta);
  }

  // actions
  let actions = node.querySelector('.msg-actions');
  if(!actions){
    actions = document.createElement('div');
    actions.className = 'msg-actions';

    const eBtn = document.createElement('button');
    eBtn.className='edit-btn small-btn';
    eBtn.textContent='ویرایش';

    const dBtn = document.createElement('button');
    dBtn.className='delete-btn small-btn';
    dBtn.textContent='حذف';

    actions.appendChild(eBtn);
    actions.appendChild(dBtn);

    eBtn.addEventListener('click',()=>startEditingMessage(mid, message.text||''));
    dBtn.addEventListener('click',()=>startDeleteMessage(message));

    node.querySelector('.message-bubble').appendChild(actions);
  }

  box.appendChild(node);
  if(autoScroll) box.scrollTop = box.scrollHeight;

  // seen tracking only for received msgs
  if(!(me && sender && String(sender)===String(me._id))){
    observeForSeen(node, message);
  }
}
/* =======================
   INCOMING MESSAGES
   ======================= */
function handleIncomingMessage(convId, msg){
  if(!convId || !msg) return;

  if(!messagesCache.has(convId)) messagesCache.set(convId, []);
  messagesCache.get(convId).push(msg);

  if(convId === activeConvId){
    appendMessage(convId, msg);
  }

  updateConvPreview(convId, msg);
}

/* =======================
   UPDATE CONVERSATION PREVIEW
   ======================= */
function updateConvPreview(convId, msg){
  const conv = conversations.find(c => String(c._id) === String(convId));
  if(!conv) return;
  conv.lastMessageText = msg.text || '(پیوست)';
  renderConversationList(conversations);
}

/* =======================
   TYPING INDICATOR
   ======================= */
let typingEmitTimer = null;

function sendTyping(){
  if(!socket || !socket.connected || !activeConvId) return;

  socket.emit('typing', { convId: activeConvId, typing: true });

  if(typingEmitTimer) clearTimeout(typingEmitTimer);
  typingEmitTimer = setTimeout(()=>{
    socket.emit('typing', { convId: activeConvId, typing: false });
  }, 2500);
}

function renderTypingIndicator(username){
  const el = $id('typingIndicator');
  if(!el) return;
  el.style.display = 'block';
  el.textContent = username + ' در حال نوشتن...';
}

function hideTypingIndicator(){
  const el = $id('typingIndicator');
  if(!el) return;
  el.style.display = 'none';
}

/* =======================
   SEEN HANDLING
   ======================= */
let seenObserver = null;

function attachSeenObservers(convId){
  const wrap = $id('messageList');
  if(!wrap) return;

  if(seenObserver){
    seenObserver.disconnect();
    seenObserver = null;
  }

  seenObserver = new IntersectionObserver(entries=>{
    const visibleIds = [];
    entries.forEach(e=>{
      if(e.isIntersecting && e.target.dataset.id){
        visibleIds.push(e.target.dataset.id);
      }
    });
    if(visibleIds.length){
      bufferSeen(convId, visibleIds);
    }
  }, { threshold: 0.6 });

  const nodes = wrap.querySelectorAll('.message-item');
  nodes.forEach(n=>seenObserver.observe(n));
}

function observeForSeen(node){
  if(!seenObserver) return;
  seenObserver.observe(node);
}

function bufferSeen(convId, ids){
  if(!seenBuffer.has(convId)) seenBuffer.set(convId, new Set());
  const set = seenBuffer.get(convId);
  ids.forEach(id=>set.add(id));

  if(seenFlushTimer) clearTimeout(seenFlushTimer);
  seenFlushTimer = setTimeout(flushSeen, SEEN_BATCH_DELAY);
}

function flushSeen(){
  if(!socket || !socket.connected) return;

  seenBuffer.forEach((idSet, convId)=>{
    if(!idSet.size) return;
    const ids = Array.from(idSet);
    idSet.clear();
    socket.emit('message:seen', { convId, ids });
  });
}

function markSeenUI(convId, msgId){
  if(convId !== activeConvId) return;
  const node = document.querySelector(`.message-item[data-id="${msgId}"]`);
  if(!node) return;

  const status = node.querySelector('.msg-status');
  if(status) status.textContent = 'دیده شد';
}

/* =======================
   SEND MESSAGE (TEXT)
   ======================= */
async function sendMessage(){
  const input = $id('messageInput');
  if(!input || !input.value.trim()) return;

  const text = input.value.trim();
  input.value = '';

  const tempId = uid('tmp');
  const tempMsg = {
    _id: tempId,
    text,
    createdAt: nowIso(),
    senderId: me && me._id,
    temp: true
  };

  if(!messagesCache.has(activeConvId)){
    messagesCache.set(activeConvId, []);
  }
  messagesCache.get(activeConvId).push(tempMsg);
  appendMessage(activeConvId, tempMsg);

  const payload = {
    convId: activeConvId,
    text,
    clientTempId: tempId
  };

  if(!socket || !socket.connected){
    offlineQueue.push(payload);
    return;
  }

  socket.emit('private:message', payload, ack=>{
    if(!ack || !ack.ok) return;

    const arr = messagesCache.get(activeConvId) || [];
    const idx = arr.findIndex(m=>m._id === tempId);
    if(idx >= 0) arr[idx] = ack.message;

    const node = document.querySelector(`.message-item[data-id="${tempId}"]`);
    if(node){
      node.dataset.id = ack.message._id;
      const t = node.querySelector('.msg-time');
      if(t) t.textContent = formatTime(ack.message.createdAt);

      const st = node.querySelector('.msg-status');
      if(st) st.textContent = '';
    }
  });
}

/* =======================
   SEND ATTACHMENT
   ======================= */
async function sendAttachment(file){
  if(!file) return;

  const tempId = uid('tmpfile');
  const tempMsg = {
    _id: tempId,
    attachments: [{
      url: '',
      name: file.name,
      size: file.size,
      mime: file.type
    }],
    createdAt: nowIso(),
    senderId: me && me._id,
    temp: true
  };

  if(!messagesCache.has(activeConvId)){
    messagesCache.set(activeConvId, []);
  }
  messagesCache.get(activeConvId).push(tempMsg);
  appendMessage(activeConvId, tempMsg);

  try{
    const form = new FormData();
    form.append('file', file);

    const up = await apiUpload(UPLOAD_PATH, form);
    const att = up.attachment;

    const payload = {
      convId: activeConvId,
      attachments: [att],
      clientTempId: tempId
    };

    if(!socket || !socket.connected){
      offlineQueue.push(payload);
      return;
    }

    socket.emit('private:message', payload, ack=>{
      if(!ack || !ack.ok) return;

      const arr = messagesCache.get(activeConvId) || [];
      const idx = arr.findIndex(m=>m._id === tempId);
      if(idx >= 0) arr[idx] = ack.message;

      const node = document.querySelector(`.message-item[data-id="${tempId}"]`);
      if(node){
        node.dataset.id = ack.message._id;
        const t = node.querySelector('.msg-time');
        if(t) t.textContent = formatTime(ack.message.createdAt);
        const st = node.querySelector('.msg-status');
        if(st) st.textContent = '';
      }
    });

  }catch(e){
    console.error('sendAttachment', e);
  }
}
/* =======================
   EDIT MESSAGE
   ======================= */
let editingMsgId = null;

function startEditingMessage(id, oldText){
  editingMsgId = id;
  const input = $id('messageInput');
  if(!input) return;

  input.value = oldText || '';
  input.focus();

  const btn = $id('sendBtn');
  if(btn) btn.textContent = 'ویرایش';
}

async function finishEditingMessage(){
  if(!editingMsgId) return;

  const input = $id('messageInput');
  if(!input) return;

  const text = input.value.trim();
  if(!text) return;

  socket.emit('message:edit', {
    convId: activeConvId,
    messageId: editingMsgId,
    text
  }, ack=>{
    if(!ack || !ack.ok) return;

    applyMessageEdit(activeConvId, ack.message);

    editingMsgId = null;
    input.value = '';

    const btn = $id('sendBtn');
    if(btn) btn.textContent = 'ارسال';
  });
}

function applyMessageEdit(convId, msg){
  if(!messagesCache.has(convId)) return;

  const arr = messagesCache.get(convId);
  const idx = arr.findIndex(m => String(m._id) === String(msg._id));
  if(idx >= 0) arr[idx] = msg;

  if(convId !== activeConvId) return;

  const node = document.querySelector(`.message-item[data-id="${msg._id}"]`);
  if(!node) return;

  const textEl = node.querySelector('.message-text');
  if(textEl) textEl.innerHTML = escapeHtml(msg.text || '');

  const editedEl = node.querySelector('.message-edited');
  if(editedEl){
    editedEl.style.display = 'inline';
    editedEl.textContent = '(ویرایش شده)';
  }
}

/* =======================
   DELETE MESSAGE
   ======================= */
function startDeleteMessage(msg){
  if(!confirm('حذف پیام؟')) return;

  socket.emit('message:delete', {
    messageId: msg._id,
    forAll: true
  }, (ack)=>{
    if(!ack || !ack.ok){
      console.error('delete failed:', ack);
      return;
    }
  });
}

function applyMessageDeletion(convId, id){
  if(!messagesCache.has(convId)) return;

  const arr = messagesCache.get(convId);
  const filtered = arr.filter(m => String(m._id) !== String(id));
  messagesCache.set(convId, filtered);

  if(convId !== activeConvId) return;

  const node = document.querySelector(`.message-item[data-id="${id}"]`);
  if(node) node.remove();
}

/* =======================
   SOCKET EVENT LISTENERS
   ======================= */
function setupSocketListeners(){
  if(!socket) return;

  socket.off && socket.off('private:message');
  socket.off && socket.off('message:edited');
  socket.off && socket.off('message:deleted');
  socket.off && socket.off('message:seen');
  socket.off && socket.off('typing');
  socket.off && socket.off('user:online');
  socket.off && socket.off('user:offline');

  // incoming message
  socket.on('private:message', payload=>{
    const convId =
      payload.conversationId ||
      payload.convId ||
      (payload.message && payload.message.conversationId);

    const msg = payload.message || payload;
    handleIncomingMessage(convId, msg);
  });

  // edited
  socket.on('message:edited', payload=>{
    const msg = payload.message || payload;
    const convId =
      payload.conversationId ||
      payload.convId ||
      msg.conversationId ||
      activeConvId;

    applyMessageEdit(convId, msg);
  });

  // deleted
  socket.on('message:deleted', payload=>{
    const convId =
      payload.conversationId ||
      payload.convId ||
      activeConvId;

    const id =
      payload.messageId ||
      (payload.message && payload.message._id) ||
      payload.id;

    applyMessageDeletion(convId, id);
  });

  // seen
  socket.on('message:seen', payload=>{
    const convId = payload.conversationId || payload.convId || activeConvId;
    const ids = payload.ids || payload.messageIds || [];
    ids.forEach(id => markSeenUI(convId, id));
  });

  // typing
  socket.on('typing', payload=>{
    const convId = payload.convId || payload.conversationId;
    if(convId !== activeConvId) return;

    if(payload.typing){
      renderTypingIndicator(payload.username || payload.userName || 'کاربر');
    } else {
      hideTypingIndicator();
    }
  });

  // presence
  socket.on('user:online', payload=>{
    setUserPresenceUI(payload.userId || payload.user, true);
  });
  socket.on('user:offline', payload=>{
    setUserPresenceUI(
      payload.userId || payload.user,
      false,
      payload.lastSeenAt
    );
  });
}

/* =======================
   PRESENCE UI
   ======================= */
function setUserPresenceUI(userId, online, lastSeen){
  const el = $id('chatStatus') || $id('typingIndicator');
  if(!el) return;

  if(online){
    el.style.display = 'block';
    el.textContent = 'آنلاین';
  } else {
    el.style.display = 'block';
    el.textContent =
      'آخرین بازدید: ' +
      (lastSeen ? new Date(lastSeen).toLocaleString() : 'نامشخص');
  }
}
/* =======================
   SCROLL HANDLING
   ======================= */
function scrollToBottom(){
  const box = $id('messageList');
  if(!box) return;
  box.scrollTop = box.scrollHeight;
}

/* =======================
   UI: PROFILE APPEARANCE
   ======================= */
function applyProfileUI(user){
  const name = $id('myName');
  if(name) name.textContent = user.displayName || user.username;

  const avatar = $id('myAvatar');
  if(avatar && user.avatarUrl){
    avatar.src = user.avatarUrl;
  }
}

/* =======================
   INPUT HANDLERS
   ======================= */
function setupInputHandlers(){
  const input = $id('messageInput');
  if(!input) return;

  input.addEventListener('input', sendTyping);

  input.addEventListener('keydown', e=>{
    if(e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      if(editingMsgId) finishEditingMessage();
      else sendMessage();
    }
  });

  const fileEl = $id('fileInput');
  if(fileEl){
    fileEl.addEventListener('change', ()=>{
      if(fileEl.files && fileEl.files.length){
        sendAttachment(fileEl.files[0]);
        fileEl.value = '';
      }
    });
  }

  const sendBtn = $id('sendBtn');
  if(sendBtn){
    sendBtn.addEventListener('click', ()=>{
      if(editingMsgId) finishEditingMessage();
      else sendMessage();
    });
  }
}

/* =======================
   SEARCH (Optional)
   ======================= */
function searchMessages(keyword){
  const box = $id('messageList');
  if(!box) return;

  if(!keyword){
    const nodes = box.querySelectorAll('.message-item');
    nodes.forEach(n => n.classList.remove('highlight'));
    return;
  }

  const nodes = box.querySelectorAll('.message-item');
  nodes.forEach(n=>{
    const text = (n.querySelector('.message-text')?.innerText || '').toLowerCase();
    if(text.includes(keyword.toLowerCase())){
      n.classList.add('highlight');
    } else {
      n.classList.remove('highlight');
    }
  });
}

/* =======================
   THEME (Dark/Light)
   ======================= */
function applyTheme(){
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  document.documentElement.dataset.theme = saved;
}

function toggleTheme(){
  const current = localStorage.getItem(THEME_KEY) || 'light';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
}

/* =======================
   INIT
   ======================= */
document.addEventListener('DOMContentLoaded', ()=>{
  applyTheme();
  setupInputHandlers();
  loadMe();

  const themeBtn = $id('themeBtn');
  if(themeBtn){
    themeBtn.addEventListener('click', toggleTheme);
  }
});
/* =======================
   CONTEXT MENU (Right Click)
   ======================= */

let contextMenu = null;

function showContextMenu(event, message){
  event.preventDefault();
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.top = event.pageY + 'px';
  menu.style.left = event.pageX + 'px';

  menu.innerHTML = `
    <div class="ctx-item" data-act="edit">ویرایش</div>
    <div class="ctx-item" data-act="delete">حذف</div>
    <div class="ctx-item" data-act="copy">کپی متن</div>
  `;

  document.body.appendChild(menu);
  contextMenu = menu;

  menu.addEventListener('click', e=>{
    const act = e.target.dataset.act;
    if(!act) return;

    if(act === 'edit'){
      startEditingMessage(message._id, message.text || '');
    }
    else if(act === 'delete'){
      startDeleteMessage(message);
    }
    else if(act === 'copy'){
      navigator.clipboard.writeText(message.text || '').catch(()=>{});
    }

    hideContextMenu();
  });
}

function hideContextMenu(){
  if(contextMenu){
    contextMenu.remove();
    contextMenu = null;
  }
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', function(e){
  if(!e.target.closest('.message-item')) return hideContextMenu();
});

/* =======================
   LONG PRESS (Mobile)
   ======================= */

let touchTimer = null;

function enableLongPress(){
  document.body.addEventListener('touchstart', function(e){
    const msg = e.target.closest('.message-item');
    if(!msg) return;

    clearTimeout(touchTimer);
    touchTimer = setTimeout(()=>{
      const id = msg.dataset.id;
      const convArr = messagesCache.get(activeConvId) || [];
      const found = convArr.find(m=>String(m._id)===String(id));
      if(found){
        showContextMenu({pageX:e.touches[0].pageX, pageY:e.touches[0].pageY, preventDefault(){}}, found);
      }
    }, 450);
  });

  document.body.addEventListener('touchend', ()=>clearTimeout(touchTimer));
  document.body.addEventListener('touchmove', ()=>clearTimeout(touchTimer));
}

/* =======================
   NOTIFICATION / TITLE BLINK
   ======================= */

let blinkInterval = null;
let isWindowFocused = true;

function setWindowFocusHandlers(){
  window.addEventListener('focus', ()=>{
    isWindowFocused = true;
    document.title = 'چت';
    if(blinkInterval) clearInterval(blinkInterval);
  });

  window.addEventListener('blur', ()=>{
    isWindowFocused = false;
  });
}

function notifyIncoming(){
  if(isWindowFocused) return;

  let state = false;
  if(blinkInterval) clearInterval(blinkInterval);

  blinkInterval = setInterval(()=>{
    state = !state;
    document.title = state ? '🔵 پیام جدید' : 'چت';
  }, 800);
}

/* When message arrives */
function handleIncomingMessage(convId, msg){
  if(!convId || !msg) return;

  if(!messagesCache.has(convId)) messagesCache.set(convId, []);
  messagesCache.get(convId).push(msg);

  if(convId === activeConvId){
    appendMessage(convId, msg);
  }

  updateConvPreview(convId, msg);

  notifyIncoming(); // <— اضافه‌شده برای نسخه A
}

/* =======================
   RESPONSIVE (Mobile CSS helpers)
   ======================= */

function applyResponsiveFixes(){
  const root = document.documentElement;
  const isMobile = window.innerWidth < 680;

  if(isMobile){
    root.classList.add('mobile');
  } else {
    root.classList.remove('mobile');
  }
}

window.addEventListener('resize', applyResponsiveFixes);
/* =======================
   EXPORT / GLOBAL ACCESS
   ======================= */

window.ChatApp = {
  sendMessage,
  sendAttachment,
  startEditingMessage,
  finishEditingMessage,
  startDeleteMessage,
  searchMessages,
  toggleTheme
};

/* =======================
   FINAL INIT (after DOM)
   ======================= */

document.addEventListener('DOMContentLoaded', ()=>{
  try{
    applyTheme();
    setupInputHandlers();
    enableLongPress();
    setWindowFocusHandlers();
    applyResponsiveFixes();
    loadMe();
  }catch(err){
    console.error('Chat init failed:', err);
  }
});