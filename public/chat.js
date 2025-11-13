/* chat.js — frontend logic for Eclipse Hunter chat
   Features: theme, users list, last seen, send text/file/voice, socket.io integration
*/
(() => {
  const socket = (window.io) ? io() : null;
  const localUser = JSON.parse(localStorage.getItem('user') || 'null');
  if (!localUser) {
    alert('No local user. لطفاً ابتدا ثبت‌نام / ورود کنید.');
    window.location.href = '/login.html';
  }

  // elements
  const userListEl = document.getElementById('userList');
  const chatBody = document.getElementById('chatBody');
  const chatWithEl = document.getElementById('chatWith');
  const otherStatusEl = document.getElementById('otherStatus');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const attachBtn = document.getElementById('attachBtn');
  const fileInput = document.getElementById('fileInput');
  const voiceBtn = document.getElementById('voiceBtn');
  const displayNameInput = document.getElementById('displayName');
  const myAvatar = document.getElementById('myAvatar');
  const searchInput = document.getElementById('searchInput');
  const themeToggle = document.getElementById('themeToggle');
  const app = document.getElementById('app');

  // theme
  function applyTheme(t){ app.className = t==='dark' ? 'dark' : 'light'; localStorage.setItem('eh:theme', t); themeToggle.textContent = t==='dark' ? '☀️' : '🌙'; }
  applyTheme(localStorage.getItem('eh:theme') || 'light');
  themeToggle.addEventListener('click', ()=> applyTheme(app.className==='dark' ? 'light' : 'dark'));

  // avatar
  function avatarFrom(name){
    if(!name) return {letter:'EH', color:'#0088cc'};
    const ch = name.trim()[0].toUpperCase();
    const color = '#'+(Math.abs(name.split('').reduce((a,c)=>a*31+c.charCodeAt(0),0))%0xFFFFFF).toString(16).padStart(6,'0');
    return {letter: ch, color};
  }
  (function initProfile(){
    const name = localStorage.getItem('eh:name') || localUser.displayName || localUser.username;
    displayNameInput.value = name || '';
    const a = avatarFrom(name);
    myAvatar.textContent = a.letter; myAvatar.style.background = a.color;
    if(name) socket && socket.emit && socket.emit('set-display',{displayName:name});
  })();
  displayNameInput.addEventListener('change', ()=>{
    const v = displayNameInput.value.trim();
    localStorage.setItem('eh:name', v);
    const a = avatarFrom(v);
    myAvatar.textContent = a.letter; myAvatar.style.background = a.color;
    socket && socket.emit && socket.emit('set-display',{displayName:v});
  });

  // utility
  function el(tag, cls){ const e=document.createElement(tag); if(cls) e.className=cls; return e; }
  function timestamp(ts){ return new Date(ts||Date.now()).toLocaleTimeString(); }

  // load users from server
  async function loadUsers(q=''){
    try{
      const res = await fetch('/users');
      const users = await res.json();
      renderUsers(users.filter(u=> u._id !== localUser._id && (!q || (u.displayName||u.username||'').toLowerCase().includes(q.toLowerCase()))));
    }catch(e){ console.error('loadUsers',e); }
  }

  function renderUsers(users){
    userListEl.innerHTML='';
    users.forEach(u=>{
      const item = el('div','user-item');
      item.dataset.id = u._id;
      const av = el('div','avatar'); if(u.avatarUrl){ const img=document.createElement('img'); img.src=u.avatarUrl; img.style.width='100%'; img.style.height='100%'; img.style.borderRadius='50%'; av.appendChild(img); } else { const a = avatarFrom(u.displayName||u.username); av.textContent=a.letter; av.style.background=a.color; }
      const meta = el('div','user-meta');
      const name = el('div','name'); name.textContent = u.displayName || u.username;
      const last = el('div','last'); last.textContent = u.online ? 'آنلاین' : (u.lastSeen ? ('آخرین بازدید: '+ new Date(u.lastSeen).toLocaleString()) : 'آفلاین');
      meta.appendChild(name); meta.appendChild(last);
      item.appendChild(av); item.appendChild(meta);
      item.addEventListener('click', ()=> openConversation(u));
      userListEl.appendChild(item);
    });
  }

  let currentConvId = null;
  let currentOther = null;

  async function openConversation(u){
    currentOther = u;
    chatWithEl.textContent = u.displayName || u.username;
    otherStatusEl.textContent = u.online ? 'آنلاین' : (u.lastSeen ? ('آخرین بازدید: '+ new Date(u.lastSeen).toLocaleString()) : 'آفلاین');
    chatBody.innerHTML = '';
    // request server to provide/create conversation via socket or REST
    // try REST
    try{
      const convsRes = await fetch('/conversations/'+localUser._id);
      if(convsRes.ok){
        const convs = await convsRes.json();
        const conv = convs.find(c=> c.participants && c.participants.includes(u._id));
        if(conv) { currentConvId = conv._id; const msgsRes = await fetch('/messages/'+currentConvId); if(msgsRes.ok){ const msgs = await msgsRes.json(); msgs.forEach(addMessage); } }
      }
    }catch(e){ console.error(e); }
    // join socket room
    if(socket) socket.emit('private:join', { userId: localUser._id, otherId: u._id });
  }

  function addMessage(m){
    const elWrap = el('div','message '+(String(m.senderId)===String(localUser._id)?'me':''));
    const meta = el('div','msg-meta'); meta.textContent = (String(m.senderId)===String(localUser._id)?'شما':'') + ' • ' + timestamp(m.createdAt);
    elWrap.appendChild(meta);
    if(m.text) { const p = el('div'); p.textContent = m.text; elWrap.appendChild(p); }
    if(m.media){ if(m.mediaType && m.mediaType.startsWith('image')){ const img=el('img','msg-media'); img.src=m.media; elWrap.appendChild(img); } else { const a=el('a'); a.href=m.media; a.textContent='فایل'; a.target='_blank'; elWrap.appendChild(a); } }
    chatBody.appendChild(elWrap);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  // socket handlers
  if(socket){
    socket.on('connect', ()=> { socket.emit('presence:register',{ userId: localUser._id }); socket.emit('list:users'); });
    socket.on('users:updated', ()=> loadUsers());
    socket.on('load messages', ({convId,messages})=> { chatBody.innerHTML=''; messages.forEach(addMessage); currentConvId=convId; });
    socket.on('message:new', (msg)=> { if(currentConvId && String(msg.conversationId)===String(currentConvId)) addMessage(msg); });
    socket.on('message:deleted', ({messageId})=> { /* optional: remove message */ });
  }

  // send message
  async function sendMessage(text='', media=null, mediaType=null){
    if(!currentOther){ alert('یک مخاطب انتخاب کنید'); return; }
    if(!currentConvId){
      // create/find conv will be handled by socket private:join; optimistic local message only
    }
    // emit socket
    if(socket){
      socket.emit('private:message', { convId: currentConvId, senderId: localUser._id, text, media, mediaType });
    } else {
      // fallback POST (server may implement)
      await fetch('/messages/'+(currentConvId||''), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ senderId: localUser._id, text, media, mediaType }) }).catch(()=>{});
    }
  }

  sendBtn.addEventListener('click', ()=> {
    const text = messageInput.value.trim();
    if(!text) return;
    sendMessage(text,null,'text');
    messageInput.value='';
  });

  attachBtn.addEventListener('click', ()=> fileInput.click());
  fileInput.addEventListener('change', async (e)=>{
    const f = e.target.files[0];
    if(!f) return;
    const fd = new FormData(); fd.append('file', f);
    const r = await fetch('/upload', { method:'POST', body: fd });
    const data = await r.json();
    if(data && data.url) sendMessage('', data.url, f.type);
  });

  // voice recording (basic)
  voiceBtn.addEventListener('click', async ()=>{
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return alert('مرورگر شما ضبط صوت را پشتیبانی نمی‌کند');
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = e=> chunks.push(e.data);
      mr.onstop = async ()=>{
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const fd = new FormData(); fd.append('file', blob, 'voice.webm');
        const up = await fetch('/upload', { method:'POST', body: fd });
        const jd = await up.json();
        if(jd && jd.url) sendMessage('', jd.url, 'audio/webm');
      };
      mr.start();
      alert('در حال ضبط: برای توقف OK را بزنید (حدود 5 ثانیه ضبط خواهد شد)');
      setTimeout(()=> mr.stop(), 5000);
    }catch(e){ console.error(e); alert('خطا در ضبط'); }
  });

  // initial load
  loadUsers();
  // periodic refresh
  setInterval(()=> loadUsers(), 5000);

  searchInput.addEventListener('input', ()=> loadUsers(searchInput.value));
})();
