/* chat.js — Super-Pro client logic for Eclipse Chat
   Version: heavy/full-feature (900+ lines target where practical)
   Features implemented:
   - Socket.IO connection with JWT auth
   - Presence ping + lastSeen handling + online/offline UI updates
   - Optimistic send (tempId) and ack replacement
   - Offline queue with retry on reconnect
   - Typing indicator
   - Edit / Delete (for everyone and local delete)
   - Attachments upload flow (POST /upload/media -> attach to message)
   - New chat modal -> create conversation via /api/conversations
   - Saved messages panel (get/post saved via /api/saved - server stubs expected)
   - Theme switching persisted to localStorage
   - Profile panel editing (PUT /api/me)
   - Virtualized rendering stubs and performance considerations
   - Mobile sidebar toggles and hamburger behavior
   - Detailed inline comments for maintainability
   - Defensive checks and error handling
   - Designed to be used with server_upgraded_final.js
*/

/* ============================== Configuration ============================== */
const API_BASE = '/api';
const UPLOAD_ENDPOINT = '/upload/media';
const SOCKET_PATH = '/'; // root (server listens on same origin)
const THEME_KEY = 'eclipse:theme';
const TOKEN_KEY = 'eclipse:token';
const PRESENCE_PING_INTERVAL = 25000; // ms
const SEEN_BATCH_DELAY = 500; // ms
const OPTIMISTIC_TIMEOUT = 120000; // 2 minutes fallback
const MAX_OFFLINE_QUEUE = 200;

/* ============================== State ===================================== */
let socket = null;
let me = null;
let token = localStorage.getItem(TOKEN_KEY) || null;
let conversations = []; // list of conversations metadata
let activeConv = null; // conversation id string
let messagesCache = new Map(); // convId -> messages array (sorted asc)
let pendingSends = new Map(); // tempId -> {resolve,reject,timeout}
let offlineQueue = []; // queued payloads while offline
let isConnected = false;
let theme = localStorage.getItem(THEME_KEY) || 'theme-telegram';
let seenQueue = new Map(); // convId -> Set(messageId)
let seenTimer = null;
let typingTimers = new Map(); // convId -> timeout
let messageObservers = new Map(); // messageId -> IntersectionObserver

/* Utility functions */
function log(...args){ console.debug('[chat]', ...args); }
function nowIso(){ return (new Date()).toISOString(); }
function uid(){ return 'id_' + Math.random().toString(36).slice(2,9); }
function escapeHtml(s){ if(!s) return ''; return s.replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function formatTimeISO(iso){ if(!iso) return ''; const d=new Date(iso); return d.toLocaleTimeString(); }

/* ============================== API helpers =============================== */
async function apiFetch(path, opts={}){
  const headers = opts.headers || {};
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if(token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch((API_BASE + path).replace('//','/'), {...opts, headers, credentials:'same-origin'});
  if(!res.ok){ const text = await res.text().catch(()=>null); throw new Error(`API ${path} ${res.status} ${text || ''}`); }
  return res.json();
}

/* For full paths (not under /api) */
async function apiPostFull(path, formData, headers={}){
  if(!token) throw new Error('No token');
  headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { method:'POST', body: formData, headers, credentials:'same-origin' });
  if(!res.ok){ throw new Error('upload failed ' + res.status); }
  return res.json();
}

/* ============================== Socket logic ============================== */
function connectSocket(){
  if(socket && socket.connected) return;
  // Ensure token is set for socket auth
  const auth = token ? { token } : {};
  socket = io(SOCKET_PATH, { auth, transports:['websocket'] });

  socket.on('connect', ()=>{
    isConnected = true;
    log('socket connected', socket.id);
    // join rooms for active conversations
    if(me && socket.id){
      // join all open conversations to receive messages (optional: only join activeConv)
      conversations.forEach(c=>{ if(c._id) socket.emit('private:join', { convId: c._id }); });
    }
    flushOfflineQueue();
  });

  socket.on('disconnect', (reason)=>{
    isConnected = false;
    log('socket disconnected', reason);
  });

  socket.on('reconnect_attempt', ()=> log('reconnect attempt'));
  socket.on('connect_error', (err)=> log('connect_error', err.message));

  socket.on('private:message', ({ conversationId, message }) => {
    // server broadcast
    receiveMessage(conversationId, message);
  });

  socket.on('message:updated', ({ conversationId, message }) => {
    applyMessageUpdate(conversationId, message);
  });

  socket.on('message:deleted', ({ conversationId, messageId, deletedForAll }) => {
    applyMessageDeletion(conversationId, messageId, deletedForAll);
  });

  socket.on('private:message:ack', ({ tempId, message }) => {
    // some servers might emit ack; our server uses ack callback, but handle for safety
    handleSendAck({ tempId, message });
  });

  socket.on('message:seen', ({ conversationId, messageIds, userId }) => {
    messageIds.forEach(mid => markMessageSeen(conversationId, mid, userId));
  });

  socket.on('user:online', ({ userId }) => setUserOnlineUI(userId));
  socket.on('user:offline', ({ userId, lastSeenAt }) => setUserOfflineUI(userId, lastSeenAt));

  socket.on('typing', ({ convId, userId, typing }) => {
    showTypingIndicator(convId, userId, typing);
  });
}

/* Disconnect socket cleanly */
function disconnectSocket(){
  if(!socket) return;
  try{ socket.disconnect(); }catch(e){}
  socket = null;
  isConnected = false;
}

/* ============================== Presence & ping =========================== */
let presenceInterval = null;
function startPresencePing(){
  if(presenceInterval) clearInterval(presenceInterval);
  presenceInterval = setInterval(()=>{
    if(socket && socket.connected){
      socket.emit('presence:ping');
    } else {
      // no-op
    }
  }, PRESENCE_PING_INTERVAL);
}

/* ============================== Conversations ============================= */
async function fetchConversations(){
  try{
    const res = await apiFetch('/conversations');
    conversations = res.conversations || [];
    renderConversationList(conversations);
    // auto open first conversation if none active
    if(!activeConv && conversations.length) openConversation(conversations[0]._id);
  }catch(err){
    console.error('fetchConversations', err);
  }
}

/* Create or open a conversation by user id/username */
async function createOrOpenConversation(userIdentifier){
  try{
    const res = await apiFetch('/conversations', { method: 'POST', body: JSON.stringify({ user: userIdentifier }) });
    const conv = res.conversation;
    // refresh conversation list and open
    await fetchConversations();
    openConversation(conv._id);
  }catch(err){
    alert('خطا در ایجاد گفتگو: ' + err.message);
  }
}

/* Open conversation: fetch messages and render */
async function openConversation(convId){
  if(!convId) return;
  activeConv = convId;
  // UI: show header and mark selected in list
  highlightActiveConversation(convId);
  try{
    const res = await apiFetch(`/conversations/${convId}/messages`);
    const msgs = res.messages || [];
    messagesCache.set(convId, msgs.slice());
    renderMessages(convId, msgs);
    // Join socket room
    if(socket && socket.connected) socket.emit('private:join', { convId });
    // attach observers for seen detection
    attachSeenObservers(convId);
  }catch(err){
    console.error('openConversation', err);
  }
}

/* ============================== Rendering ================================= */
function $(id){ return document.getElementById(id); }

/* Conversation list rendering */
function renderConversationList(list){
  const el = $('convList');
  if(!el) return;
  el.innerHTML = '';
  list.forEach(conv => {
    const li = document.createElement('li');
    li.className = 'conv-item';
    li.dataset.convid = conv._id;
    li.innerHTML = `
      <img class="conv-avatar" src="${conv.avatarUrl || '/default.png'}" />
      <div class="conv-meta">
        <div class="name">${escapeHtml(conv.title || (conv.participants && conv.participants.join(', ')) || 'کاربر')}</div>
        <div class="last">${escapeHtml(conv.lastMessageText || '')}</div>
      </div>
    `;
    li.addEventListener('click', ()=> openConversation(conv._id));
    el.appendChild(li);
  });
}

/* Messages rendering (naive append; virtualized stub later) */
function renderMessages(convId, messages){
  const container = $('messages');
  if(!container) return;
  container.innerHTML = '';
  (messages || []).forEach(m => {
    appendMessageToUI(convId, m, false);
  });
  // scroll to bottom
  container.scrollTop = container.scrollHeight;
}

/* Append single message to DOM */
function appendMessageToUI(convId, message, scroll=true){
  if(convId !== activeConv) return;
  const container = $('messages');
  if(!container) return;
  const tpl = document.getElementById('tpl-message');
  if(!tpl) return;
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = message._id || (message.tempId || '');
  node.classList.add('message-item');
  if(message.senderId && me && String(message.senderId) === String(me._id)) node.classList.add('mine');
  // bubble text
  node.querySelector('.message-text').innerHTML = escapeHtml(message.text || '');
  // attachments
  const attachWrap = node.querySelector('.msg-attachments');
  attachWrap.innerHTML = '';
  if(message.attachments && message.attachments.length){
    message.attachments.forEach(att => {
      if(att.mime && att.mime.startsWith('image/')){
        const img = document.createElement('img');
        img.src = att.url;
        img.alt = att.name || 'image';
        attachWrap.appendChild(img);
      } else {
        const fileBox = document.createElement('div');
        fileBox.className = 'attachment-file';
        fileBox.innerHTML = `<div class="file-name">${escapeHtml(att.name||'file')}</div><div class="file-size">${Math.round((att.size||0)/1024)} KB</div>`;
        attachWrap.appendChild(fileBox);
      }
    });
  }
  // meta (time + status)
  node.querySelector('.msg-time').textContent = formatTimeISO(message.createdAt || message.created_at || message.ts || nowIso());
  const statusEl = node.querySelector('.msg-status');
  if(message.temp) statusEl.textContent = 'در حال ارسال...';
  else statusEl.textContent = message.status || '';
  // actions binding
  const editBtn = node.querySelector('.edit-btn');
  const delBtn = node.querySelector('.delete-btn');
  if(editBtn) editBtn.addEventListener('click', ()=> openEditFlow(message));
  if(delBtn) delBtn.addEventListener('click', ()=> openDeleteFlow(message));
  container.appendChild(node);
  if(scroll) container.scrollTop = container.scrollHeight;
  // observe for seen if incoming and not mine
  if(!(message.senderId && me && String(message.senderId) === String(me._id))){
    observeMessageForSeen(node, message);
  }
}

/* Update an existing message node */
function updateMessageInUI(message){
  const container = $('messages');
  if(!container) return;
  const node = container.querySelector(`[data-id="${message._id}"]`);
  if(node){
    node.querySelector('.message-text').innerHTML = escapeHtml(message.text || '');
    node.querySelector('.msg-time').textContent = formatTimeISO(message.editedAt || message.createdAt || nowIso());
    node.querySelector('.msg-status').textContent = message.status || '';
    // mark edited
    if(message.editedAt) {
      let editedMarker = node.querySelector('.message-edited');
      if(!editedMarker){
        editedMarker = document.createElement('span');
        editedMarker.className = 'message-edited';
        editedMarker.textContent = ' (ویرایش شد)';
        node.querySelector('.message-bubble').appendChild(editedMarker);
      }
    }
  }
}

/* Remove / mark deleted in UI */
function removeMessageInUI(messageId, deletedForAll=false){
  const container = $('messages');
  if(!container) return;
  const node = container.querySelector(`[data-id="${messageId}"]`);
  if(node){
    if(deletedForAll){
      node.classList.add('deleted');
      node.querySelector('.message-text').textContent = 'پیام حذف شد';
      node.querySelector('.msg-attachments').innerHTML = '';
    } else {
      // local delete: just hide the node or mark
      node.classList.add('deleted');
      node.querySelector('.message-text').textContent = 'شما این پیام را حذف کردید';
    }
  }
}

/* ============================== Message flows ============================ */
/* Receive message from server */
function receiveMessage(convId, message){
  // persist to cache
  const arr = messagesCache.get(convId) || [];
  arr.push(message);
  messagesCache.set(convId, arr);
  // if active, append to UI and schedule seen report
  if(convId === activeConv){
    appendMessageToUI(convId, message, true);
    scheduleSeen(convId, message._id);
  } else {
    // increment unread badge
    addUnreadBadge(convId);
  }
}

/* Send message with optimistic UI */
function sendMessage(convId, text, attachments=[]){
  const tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2,9);
  const optimistic = {
    _id: tempId, temp: true, tempId, conversationId: convId, senderId: me._id, text, attachments, createdAt: nowIso(), status:'sending'
  };
  // append optimistic UI
  appendMessageToUI(convId, optimistic, true);
  // add to cache
  const arr = messagesCache.get(convId) || [];
  arr.push(optimistic);
  messagesCache.set(convId, arr);
  // prepare payload for socket
  const payload = { convId, tempId, text, attachments };
  // promise wrapper for ack
  return new Promise((resolve, reject) => {
    // store pending
    const to = setTimeout(()=>{
      // timeout fallback
      pendingSends.delete(tempId);
      updateOptimisticStatus(tempId, 'failed');
      reject(new Error('send timeout'));
    }, OPTIMISTIC_TIMEOUT);
    pendingSends.set(tempId, { resolve, reject, timeout: to });
    if(socket && socket.connected){
      socket.emit('private:message', payload, (ack) => {
        // server might ack immediately or later via event, handle ack here minimally
        if(ack && ack.ok){
          // server saved message; server broadcasts private:message which will call receiveMessage
          resolve(ack.message);
          clearTimeout(to);
          pendingSends.delete(tempId);
          // ensure optimistic replaced when the broadcast arrives
        } else if(ack && ack.error){
          updateOptimisticStatus(tempId, 'failed');
          pendingSends.delete(tempId);
          clearTimeout(to);
          reject(new Error(ack.error));
        }
      });
    } else {
      // offline: queue the payload, mark as queued
      optimistic.status = 'queued';
      offlineQueue.push(payload);
      if(offlineQueue.length > MAX_OFFLINE_QUEUE) offlineQueue.shift();
      resolve(optimistic);
      clearTimeout(to);
      pendingSends.delete(tempId);
    }
  });
}

/* Handle server ack (if server emits mapping or ack event) */
function handleSendAck({ tempId, message }){
  // find optimistic node and replace
  const container = $('messages');
  if(!container) return;
  const node = container.querySelector(`[data-id="${tempId}"]`);
  if(node){
    node.dataset.id = message._id;
    node.classList.remove('optimistic');
    node.querySelector('.msg-time').textContent = formatTimeISO(message.createdAt || message.created_at || nowIso());
    node.querySelector('.msg-status').textContent = '';
    // update cache: replace temp with real message
    const convArr = messagesCache.get(activeConv) || [];
    for(let i=0;i<convArr.length;i++){
      if(convArr[i]._id === tempId) { convArr[i] = message; break; }
    }
    messagesCache.set(activeConv, convArr);
  } else {
    // append if not found
    appendMessageToUI(activeConv, message, true);
  }
  // resolve pending promise if exists
  const p = pendingSends.get(tempId);
  if(p){ clearTimeout(p.timeout); p.resolve(message); pendingSends.delete(tempId); }
}

/* Update optimistic UI status */
function updateOptimisticStatus(tempId, status){
  const node = document.querySelector(`[data-id="${tempId}"]`);
  if(node){
    const sEl = node.querySelector('.msg-status');
    if(sEl) sEl.textContent = status;
  }
}

/* Flush offline queue on reconnect */
function flushOfflineQueue(){
  if(!isConnected || !socket) return;
  while(offlineQueue.length){
    const payload = offlineQueue.shift();
    socket.emit('private:message', payload, (ack)=>{
      if(!ack || !ack.ok) console.warn('offline send ack failed', ack);
    });
  }
}

/* ============================== Edit/Delete ============================== */
function openEditFlow(message){
  const newText = prompt('متن جدید را وارد کنید:', message.text || '');
  if(newText == null) return;
  // prefer socket edit; fallback to REST
  if(socket && socket.connected){
    socket.emit('message:edit', { messageId: message._id, text: newText }, (res)=>{
      if(res && res.ok){
        // server will broadcast message:updated -> applyMessageUpdate
      } else {
        alert('خطا در ویرایش: ' + (res && res.error));
      }
    });
  } else {
    // REST edit
    apiFetch(`/messages/${message._id}`, { method:'PUT', body: JSON.stringify({ text: newText }) })
      .then(()=>{}).catch(err=>alert('ویرایش ناموفق: '+err.message));
  }
}

function openDeleteFlow(message){
  const forAll = confirm('حذف برای همه؟ OK برای همه، Cancel برای خودتان');
  if(socket && socket.connected){
    socket.emit('message:delete', { messageId: message._id, forAll }, (res)=>{
      if(res && res.ok){ /* server emits message:deleted */ }
      else alert('حذف ناموفق: ' + (res && res.error));
    });
  } else {
    apiFetch(`/messages/${message._id}`, { method:'DELETE', body: JSON.stringify({ forEveryone: forAll }) })
      .then(()=>{}).catch(err=>alert('حذف ناموفق: '+err.message));
  }
}

/* Apply update broadcast */
function applyMessageUpdate(convId, message){
  // update cache
  const arr = messagesCache.get(convId) || [];
  for(let i=0;i<arr.length;i++){ if(String(arr[i]._id) === String(message._id)){ arr[i] = message; break; } }
  messagesCache.set(convId, arr);
  // update UI if active
  if(convId === activeConv) updateMessageInUI(message);
}

/* Apply deletion broadcast */
function applyMessageDeletion(convId, messageId, deletedForAll){
  // update cache
  const arr = messagesCache.get(convId) || [];
  for(let i=0;i<arr.length;i++){ if(String(arr[i]._id) === String(messageId)){ arr[i].deleted = true; arr[i].deletedForAll = !!deletedForAll; break; } }
  messagesCache.set(convId, arr);
  if(convId === activeConv) removeMessageInUI(messageId, !!deletedForAll);
}

/* ============================== Seen detection =========================== */
/* Queue seen message ids per conversation and flush in batch */
function scheduleSeen(convId, messageId){
  if(!convId || !messageId) return;
  if(!seenQueue.has(convId)) seenQueue.set(convId, new Set());
  seenQueue.get(convId).add(messageId);
  if(seenTimer) clearTimeout(seenTimer);
  seenTimer = setTimeout(flushSeenQueue, SEEN_BATCH_DELAY);
}

function flushSeenQueue(){
  for(const [convId, idsSet] of seenQueue.entries()){
    const ids = Array.from(idsSet);
    if(ids.length){
      if(socket && socket.connected){
        socket.emit('message:seen', { convId, messageIds: ids }, (res)=>{ /* optional ack */ });
      } else {
        // maybe fallback to REST if necessary
      }
    }
  }
  seenQueue.clear();
}

/* IntersectionObserver for per-message seen */
function observeMessageForSeen(node, message){
  if(!node || !message || !message._id) return;
  if('IntersectionObserver' in window){
    const io = new IntersectionObserver((entries)=>{
      entries.forEach(en => {
        if(en.isIntersecting){
          setTimeout(()=>{
            if(en.isIntersecting){
              scheduleSeen(message.conversationId || activeConv, message._id);
            }
          }, 800); // short delay to avoid accidental marking
        }
      });
    }, { threshold: 0.6 });
    io.observe(node);
    messageObservers.set(message._id, io);
  } else {
    // fallback: mark seen after a short delay if conversation active
    setTimeout(()=>{ if(activeConv === (message.conversationId||activeConv)) scheduleSeen(activeConv, message._id); }, 1200);
  }
}

/* attach seen observers for current messages */
function attachSeenObservers(convId){
  const container = $('messages');
  if(!container) return;
  container.querySelectorAll('.message-item').forEach(node => {
    const id = node.dataset.id;
    if(id && !messageObservers.has(id)){
      const fakeMsg = { _id: id, conversationId: convId };
      observeMessageForSeen(node, fakeMsg);
    }
  });
}

/* Mark message seen visually (when others send seen event) */
function markMessageSeen(convId, messageId, userId){
  // find node and add seen tick or avatar
  const node = document.querySelector(`[data-id="${messageId}"]`);
  if(node){
    const seenEl = node.querySelector('.msg-status');
    if(seenEl) seenEl.textContent = '✔✔'; // crude; can place avatars later
  }
}

/* ============================== Typing indicator ========================= */
function notifyTyping(convId, isTyping=true){
  if(!socket || !socket.connected) return;
  socket.emit('typing', { convId, typing: isTyping });
}

/* show typing indicator from others */
function showTypingIndicator(convId, userId, typing){
  // simple implementation: append a small "typing..." element in header
  if(convId !== activeConv) return;
  const statusEl = $('chatStatus');
  if(!statusEl) return;
  if(typing){
    statusEl.textContent = 'در حال نوشتن...';
    if(typingTimers.has(convId)) clearTimeout(typingTimers.get(convId));
    const t = setTimeout(()=>{ statusEl.textContent = 'آنلاین'; }, 2500);
    typingTimers.set(convId, t);
  } else {
    statusEl.textContent = 'آنلاین';
  }
}

/* ============================== User online/offline UI ==================== */
function setUserOnlineUI(userId){
  // find conversation items with this user and mark online
  // For simplification, we update header when partner online
  if(!activeConv) return;
  // GET profile of active conv partner to compare ids (or conversation participant list stored)
  // Best to request /api/conversations and refresh UI; simplified:
  $('chatStatus').textContent = 'آنلاین';
}

function setUserOfflineUI(userId, lastSeenAt){
  if(!activeConv) return;
  $('chatStatus').textContent = 'آخرین بازدید: ' + (lastSeenAt ? new Date(lastSeenAt).toLocaleString() : 'ناشناخته');
}

/* ============================== Attachments Upload ======================= */
/* Open file selector and upload */
function initAttachmentFlow(){
  const attachBtn = $('attachmentBtn');
  const fileIn = $('fileInput');
  if(!attachBtn || !fileIn) return;
  attachBtn.addEventListener('click', ()=> fileIn.click());
  fileIn.addEventListener('change', async (e)=>{
    const files = Array.from(e.target.files || []);
    if(!files.length) return;
    for(const f of files){
      try{
        const attachment = await uploadAttachment(f);
        // send as message with attachment only, or append to composer context
        // For simplicity, send immediately as a message with attachment
        await sendMessage(activeConv, '', [attachment]);
      }catch(err){
        alert('آپلود ناموفق: ' + err.message);
      }
    }
    fileIn.value = '';
  });
}

async function uploadAttachment(file){
  const fd = new FormData();
  fd.append('file', file, file.name);
  const res = await apiPostFull(UPLOAD_ENDPOINT, fd);
  if(!res.ok) throw new Error(res.error || 'upload failed');
  return res.attachment;
}

/* ============================== New Chat & Saved Messages ================== */
function initNewChatModal(){
  const btn = $('newChatBtn');
  const modal = $('newChatModal');
  const create = $('createChat');
  const cancel = $('cancelNewChat');
  const input = $('newChatInput');
  if(!btn || !modal) return;
  btn.addEventListener('click', ()=> { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false'); input.focus(); });
  cancel.addEventListener('click', ()=> { modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); input.value=''; });
  create.addEventListener('click', async ()=>{
    const v = input.value.trim();
    if(!v) return alert('آیدی خالی است');
    try{
      await createOrOpenConversation(v);
      modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); input.value='';
    }catch(err){ alert('خطا: ' + err.message); }
  });
}

/* Saved messages - simplified handlers (server endpoints assumed) */
async function fetchSavedMessages(){
  try{
    const res = await apiFetch('/saved'); // server endpoint expected
    const list = res.saved || [];
    renderSavedMessages(list);
  }catch(err){
    console.error('fetchSavedMessages', err);
  }
}

function renderSavedMessages(list){
  const el = $('savedList');
  if(!el) return;
  el.innerHTML = '';
  list.forEach(item => {
    const div = document.createElement('div');
    div.className = 'saved-item p-8';
    div.innerHTML = `<div>${escapeHtml(item.text||'[بدون متن]')}</div>`;
    el.appendChild(div);
  });
}

/* ============================== Profile Panel ============================ */
function initProfilePanel(){
  const hamburger = $('hamburger');
  const profilePanel = $('profilePanel');
  const close = $('closeProfile');
  const save = $('saveProfile');
  const avatarPreview = $('profileAvatarPreview');
  const nameInput = $('editDisplayName');
  const usernameInput = $('editUsername');
  if(!hamburger || !profilePanel) return;
  hamburger.addEventListener('click', ()=> {
    // toggle panels: open profile panel from hamburger menu
    profilePanel.classList.toggle('hidden');
  });
  close.addEventListener('click', ()=> profilePanel.classList.add('hidden'));
  save.addEventListener('click', async ()=>{
    const displayName = nameInput.value.trim();
    const username = usernameInput.value.trim();
    try{
      await apiFetch('/me', { method:'PUT', body: JSON.stringify({ displayName, avatarUrl: avatarPreview.src }) });
      alert('پروفایل ذخیره شد');
      profilePanel.classList.add('hidden');
      await loadMyProfile();
    }catch(err){ alert('خطا در ذخیره: ' + err.message); }
  });
}

/* ============================== Theme switching ========================== */
function initThemeSwitching(){
  const sel = $('themeSelect');
  const panelSel = $('themeSelector');
  const nightToggle = $('nightModeToggle');
  if(sel) sel.value = theme;
  if(panelSel) panelSel.value = theme;
  if(nightToggle) nightToggle.checked = document.body.classList.contains('night-mode');
  function apply(t){
    document.body.classList.remove('theme-telegram','theme-instagram','theme-whatsapp','theme-future');
    document.body.classList.add(t);
    theme = t;
    localStorage.setItem(THEME_KEY, t);
  }
  if(sel) sel.addEventListener('change', (e)=> apply(e.target.value));
  if(panelSel) panelSel.addEventListener('change', (e)=> apply(e.target.value));
  if(nightToggle) nightToggle.addEventListener('change', (e)=>{
    if(e.target.checked) document.body.classList.add('night-mode'); else document.body.classList.remove('night-mode');
  });
  apply(theme);
}

/* ============================== Login / Auth helpers ===================== */
async function loadMyProfile(){
  try{
    const res = await apiFetch('/me');
    me = res.user;
    applyUserToUI(me);
    // after loading profile, connect socket
    connectSocket();
    startPresencePing();
    fetchConversations();
  }catch(err){
    console.error('loadMyProfile', err);
  }
}

function applyUserToUI(user){
  if(!user) return;
  const nameEl = $('myName');
  const idEl = $('myId');
  const avatarEl = $('profileAvatar');
  if(nameEl) nameEl.textContent = user.displayName || user.username || 'کاربر';
  if(idEl) idEl.textContent = '@' + (user.username || user._id);
  if(avatarEl) avatarEl.src = user.avatarUrl || '/default.png';
  // populate profile panel fields
  const editName = $('editDisplayName'), editUser = $('editUsername'), profilePreview = $('profileAvatarPreview');
  if(editName) editName.value = user.displayName || '';
  if(editUser) editUser.value = user.username || '';
  if(profilePreview) profilePreview.src = user.avatarUrl || '/default.png';
}

/* ============================== Misc UI helpers ========================== */
function highlightActiveConversation(convId){
  document.querySelectorAll('.conv-item').forEach(el => { el.classList.toggle('active', el.dataset.convid === convId); });
  // show chat header
  const header = $('chatHeader');
  if(header) header.classList.remove('hidden');
  // optionally display partner name
  const conv = conversations.find(c=>String(c._id)===String(convId));
  if(conv){
    const name = $('chatName'); if(name) name.textContent = conv.title || 'دوست';
    const avatar = $('chatPartnerAvatar'); if(avatar) avatar.src = conv.avatarUrl || '/default.png';
    const status = $('chatStatus'); if(status) status.textContent = conv.online ? 'آنلاین' : (conv.lastSeenAt ? 'آخرین بازدید: ' + new Date(conv.lastSeenAt).toLocaleString() : 'آفلاین');
  }
}

function addUnreadBadge(convId){
  // find conv element and increase badge (simple implementation)
  const el = document.querySelector(`[data-convid="${convId}"]`);
  if(!el) return;
  let badge = el.querySelector('.conv-badge');
  if(!badge){ badge = document.createElement('div'); badge.className = 'conv-badge'; el.appendChild(badge); }
  const cur = parseInt(badge.textContent||'0') || 0; badge.textContent = String(cur+1);
}

/* ============================== Initialization =========================== */
function wireUI(){
  // send form
  const sendForm = $('sendForm');
  if(sendForm){
    sendForm.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const input = $('msgInput');
      const text = input.value.trim();
      if(!text && !document.getElementById('fileInput').files.length) return;
      try{
        await sendMessage(activeConv, text, []);
        input.value = '';
      }catch(err){
        alert('ارسال پیام ناموفق: ' + err.message);
      }
    });
  }

  // attachments
  initAttachmentFlow();

  // new chat modal
  initNewChatModal();

  // profile panel
  initProfilePanel();

  // saved messages open
  const savedBtn = $('openSaved');
  if(savedBtn) savedBtn.addEventListener('click', ()=> {
    const panel = $('savedMessagesPanel');
    panel.classList.toggle('hidden');
    if(!panel.classList.contains('hidden')) fetchSavedMessages();
  });

  // theme switching
  initThemeSwitching();

  // logout
  const logout = $('logoutBtn');
  if(logout) logout.addEventListener('click', ()=> {
    localStorage.removeItem(TOKEN_KEY);
    token = null;
    disconnectSocket();
    window.location.reload();
  });

  // hamburger toggles sidebar on mobile
  const hamb = $('hamburger');
  if(hamb) hamb.addEventListener('click', ()=> {
    const side = $('sidebar');
    if(side) side.classList.toggle('open');
  });

  // search quick create (globalSearch)
  const gsearch = $('globalSearch');
  if(gsearch){
    let tmo = null;
    gsearch.addEventListener('keyup', (e)=>{
      if(tmo) clearTimeout(tmo);
      tmo = setTimeout(()=>{
        const v = gsearch.value.trim();
        if(!v) return;
        // quick create chat by id/username if Enter pressed
        if(e.key === 'Enter'){
          createOrOpenConversation(v);
          gsearch.value = '';
        }
      }, 400);
    });
  }

  // attachment drag/drop onto messages area
  const messagesArea = $('messages');
  if(messagesArea){
    messagesArea.addEventListener('dragover', (ev)=>{ ev.preventDefault(); messagesArea.classList.add('drag-over'); });
    messagesArea.addEventListener('dragleave', ()=> messagesArea.classList.remove('drag-over'));
    messagesArea.addEventListener('drop', async (ev)=>{
      ev.preventDefault(); messagesArea.classList.remove('drag-over');
      const files = Array.from(ev.dataTransfer.files || []);
      for(const f of files){
        try{
          const att = await uploadAttachment(f);
          await sendMessage(activeConv, '', [att]);
        }catch(err){ alert('آپلود کشیده شده ناموفق: ' + err.message); }
      }
    });
  }
}

/* ============================== Virtualized Rendering Stub =============== */
/*
  For very long conversations, integrate a virtualization library (e.g. react-window or a simple windowing implementation).
  This code provides a stub and basic heuristic: if messages > 400, we only render the last 200.
*/
function ensureVirtualized(convId){
  const arr = messagesCache.get(convId) || [];
  if(arr.length > 400){
    // render last 200 only to keep DOM light
    const slice = arr.slice(Math.max(0, arr.length - 200));
    renderMessages(convId, slice);
  } else {
    renderMessages(convId, arr);
  }
}

/* ============================== Boot sequence ============================ */
document.addEventListener('DOMContentLoaded', ()=>{
  wireUI();
  // set theme early
  document.body.classList.add(theme);

  // If token exists, load profile and proceed
  if(token){
    loadMyProfile().catch(err=>{
      console.error('Failed to load profile', err);
      // Maybe token expired: remove and redirect to login
      localStorage.removeItem(TOKEN_KEY);
      token = null;
    });
  } else {
    // no token - redirect to login.html or show a message
    console.warn('No token, please login first');
    // Optionally: redirect to /login.html
    // window.location.href = '/login.html';
  }

  // periodic housekeeping: flush offline queue attempts every 30s
  setInterval(()=>{ if(isConnected) flushOfflineQueue(); }, 30000);
});
/* End of chat.js */
