'use strict';
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline, Transform } = require('stream');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const MAX_MB = Number(process.env.MAX_MB) || 1024;       // bitta fayl uchun limit
const MAX_BYTES = MAX_MB * 1024 * 1024;
const MAX_ROOMS = 300;
const MAX_CLIENTS = 300;                                 // xonadagi receiverlar
const LEAD = 1500;                                       // "Play" bosilgandan keyin boshlanish kechikishi (ms)
const SEEK_LEAD = 700;
const AUTOPLAY_LEAD = 2500;                              // keyingi trekka o'tishda yuklashga vaqt
const IDLE_ROOM_MS = 10 * 60 * 1000;                     // hech kim yo'q xona 10 daqiqadan keyin o'chadi
const MAX_HOSTLESS_MS = 60 * 60 * 1000;

// Qo'llab-quvvatlanadigan fayl turlari (SVG/HTML ataylab yo'q: xavfsizlik uchun)
const KINDS = {
  audio: ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus'],
  video: ['.mp4', '.webm', '.mov', '.m4v', '.ogv'],
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'],
  pdf: ['.pdf'],
  text: ['.txt', '.csv', '.md'],
  doc: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt', '.ods', '.odp'],
};
const EXT_KIND = new Map();
for (const [kind, list] of Object.entries(KINDS)) list.forEach(e => EXT_KIND.set(e, kind));
const kindOf = ext => EXT_KIND.get(ext) || null;
const isMedia = kind => kind === 'audio' || kind === 'video' || kind === 'youtube';
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });  // serverni qayta yoqqanda eski fayllar tozalanadi
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** @type {Map<string, any>} */
const rooms = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

// Fayllar faqat xona tokeni bilan beriladi. Transmitter sozlamalari (ko'rish / yuklab olish) shu yerda tekshiriladi.
app.get('/files/:code/:file', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).end();
  const role = room.tokens.get(String(req.query.t || ''));
  if (!role) return res.status(403).end();
  const file = path.basename(req.params.file);
  const item = room.items.find(i => !i.external && path.basename(i.url) === file);
  if (!item) return res.status(404).end();
  if (role !== 'host') {
    if (!isMedia(item.kind) && !room.cfg.allowView) return res.status(403).send('Transmitter fayllarni ko\'rishni o\'chirgan');
    if (req.query.dl === '1' && !room.cfg.allowDownload) return res.status(403).send('Transmitter yuklab olishni o\'chirgan');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=60');
  if (req.query.dl === '1') res.attachment(item.name);
  res.sendFile(path.join(UPLOAD_DIR, room.code, file), { acceptRanges: true, dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) res.status(err.status || 404).end();
  });
});

function ytIdOf(u) {
  const h = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?]+)/); if (m) id = m[1]; }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

const safeName = n => String(n || 'fayl').replace(/[\u0000-\u001f<>:"\\|?*]/g, '').slice(0, 120) || 'fayl';

function genCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(crypto.randomInt(100000, 1000000));
    if (!rooms.has(c)) return c;
  }
  return null;
}

function defaultCfg() {
  return {
    allowView: true,        // receiver rasm / PDF / matn / hujjatni ko'ra oladimi
    allowDownload: true,    // receiver yuklab ola oladimi
    muteAll: false,         // hamma receiver dinamigi o'chiq
    volume: 100,            // hamma receiver uchun umumiy ovoz (0-100)
    lockVolume: true,       // receiver o'z ovozini o'zgartira olmaydi (hamma bir xil)
    normalize: true,        // ovozni avtomatik tenglashtirish
    duck: true,             // mikrofon gapirganda musiqa pasayadi
    locked: false,          // yangi receiverlar kira olmaydi
    loop: 'off',            // 'off' | 'one' | 'all'
    waitAll: true,          // Play bosilganda hamma qurilma tayyor bo'lguncha (maks. 6 s) kutish
  };
}

function applyCfg(room, p) {
  if (!p || typeof p !== 'object') return;
  const c = room.cfg;
  for (const k of ['allowView', 'allowDownload', 'muteAll', 'lockVolume', 'normalize', 'duck', 'locked', 'waitAll']) {
    if (typeof p[k] === 'boolean') c[k] = p[k];
  }
  if (typeof p.volume === 'number' && Number.isFinite(p.volume)) c.volume = Math.max(0, Math.min(100, Math.round(p.volume)));
  if (['off', 'one', 'all'].includes(p.loop)) c.loop = p.loop;
}

function issueToken(room, role, want) {
  if (want && room.tokens.get(want) === role) return want;
  const t = crypto.randomBytes(9).toString('hex');
  room.tokens.set(t, role);
  if (room.tokens.size > 3000) room.tokens.delete(room.tokens.keys().next().value);
  return t;
}

function newRoom() {
  const code = genCode();
  if (!code) return null;
  const room = {
    code,
    hostKey: crypto.randomBytes(12).toString('hex'),
    items: [],
    state: { currentId: null, playing: false, playAt: 0, position: 0, autoNext: true },
    cfg: defaultCfg(),
    live: { mic: null, screen: null },
    tokens: new Map(),                                  // fayl tokenlari: token -> 'host' | 'receiver'
    host: null,
    clients: new Set(),
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const everyone = room => [room.host, ...room.clients].filter(Boolean);
const broadcast = (room, msg) => everyone(room).forEach(w => send(w, msg));
const stateMsg = room => ({ type: 'state', state: room.state, serverNow: Date.now() });

function expectedPos(room, t = Date.now()) {
  const s = room.state;
  return s.playing ? s.position + Math.max(0, (t - s.playAt) / 1000) : s.position;
}

// Receiverlar o'lchagan eng katta ping'ga qarab "Play"dan keyingi boshlanish kechikishi (tez tarmoqda qisqa, yomon tarmoqda uzunroq)
function leadMs(room) {
  let mx = 0;
  room.clients.forEach(c => { if (c.ctx && c.ctx.stat && c.ctx.stat.rtt > mx) mx = c.ctx.stat.rtt; });
  return mx ? clampN(Math.round(mx * 2 + 700), 900, 3000) : LEAD;
}
function cancelWait(room) {
  if (room.waitT) { clearInterval(room.waitT); room.waitT = null; broadcast(room, { type: 'waiting', n: 0 }); }
}

function sendMembers(room) {
  const clients = [...room.clients];
  const base = {
    type: 'members',
    total: clients.length,
    ready: clients.filter(c => c.ctx && c.ctx.ready).length,
    hostOnline: !!room.host,
  };
  room.clients.forEach(c => send(c, base));
  send(room.host, {
    ...base,
    list: clients.slice(0, 200).map(c => ({ id: c.ctx.id, name: c.ctx.name, ready: !!c.ctx.ready, muted: !!c.ctx.muted, stat: c.ctx.stat || null })),
  });
}

function removeRoom(room, reason) {
  if (room.waitT) clearInterval(room.waitT);
  broadcast(room, { type: 'closed', reason });
  everyone(room).forEach(w => { try { w.close(); } catch {} });
  rooms.delete(room.code);
  fs.rm(path.join(UPLOAD_DIR, room.code), { recursive: true, force: true }, () => {});
}

function dropItemFile(room, item) {
  if (item.external) return;
  fs.unlink(path.join(UPLOAD_DIR, room.code, path.basename(item.url)), () => {});
}

function selectItem(room, id, autoplay) {
  cancelWait(room);
  if (!room.items.some(i => i.id === id)) return;
  const s = room.state;
  const item = room.items.find(i => i.id === id);
  const play = !!autoplay && isMedia(item.kind);          // rasm/hujjatlar "chalinmaydi"
  s.currentId = id;
  s.position = 0;
  s.playing = play;
  s.playAt = play ? Date.now() + AUTOPLAY_LEAD : 0;
  room.clients.forEach(c => { if (c.ctx) c.ctx.ready = false; });
  broadcast(room, stateMsg(room));
  sendMembers(room);
}

// ---------------------------------------------------------------- REST

app.post('/api/rooms', (req, res) => {
  if (rooms.size >= MAX_ROOMS) return res.status(503).json({ error: 'Server band, keyinroq urinib ko\'ring' });
  const room = newRoom();
  if (!room) return res.status(503).json({ error: 'Kod yaratib bo\'lmadi' });
  res.json({ code: room.code, hostKey: room.hostKey });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ exists: false });
  const key = req.query.key;
  res.json({ exists: true, isHost: !!key && key === room.hostKey });
});

app.get('/api/info', (req, res) => {
  res.json({ lan: lanAddresses(), port: Number(PORT), maxMb: MAX_MB });
});

app.get('/api/qr', async (req, res) => {
  try {
    const text = String(req.query.text || '').slice(0, 500);
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#111111', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  } catch { res.status(400).end(); }
});

// Fayl yuklash: xom oqim (multipart emas) — tez va xotirani to'ldirmaydi
app.post('/api/rooms/:code/upload', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room || req.query.key !== room.hostKey) return res.status(403).json({ error: 'Ruxsat yo\'q' });

  const name = safeName(req.query.name);
  const ext = path.extname(name).toLowerCase();
  const kind = kindOf(ext);
  if (!kind) return res.status(415).json({ error: 'Bu format qo\'llab-quvvatlanmaydi' });
  const cid = String(req.query.cid || '').replace(/[^a-z0-9]/gi, '').slice(0, 20);

  const len = Number(req.headers['content-length']) || 0;
  if (len > MAX_BYTES) return res.status(413).json({ error: `Fayl ${MAX_MB} MB dan katta` });

  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(UPLOAD_DIR, room.code);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + ext);

  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) return cb(new Error('LIMIT'));
      cb(null, chunk);
    },
  });

  pipeline(req, limiter, fs.createWriteStream(file), err => {
    if (err) {
      fs.unlink(file, () => {});
      if (!res.headersSent) res.status(err.message === 'LIMIT' ? 413 : 500).json({ error: err.message === 'LIMIT' ? `Fayl ${MAX_MB} MB dan katta` : 'Yuklashda xato' });
      return;
    }
    if (!rooms.has(room.code)) { fs.unlink(file, () => {}); return res.status(410).end(); }
    const item = { id, cid, name, kind, url: `/files/${room.code}/${id}${ext}`, size, external: false, gainDb: null };
    room.items.push(item);
    let first = false;
    if (!room.state.currentId) { room.state.currentId = id; first = true; }
    broadcast(room, { type: 'items', items: room.items });
    if (first) broadcast(room, stateMsg(room));        // keraksiz state yuborilmaydi: pleyerga tegmaslik uchun
    res.json(item);
  });
});

// ---------------------------------------------------------------- WebSocket

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 128 * 1024 });

wss.on('connection', ws => {
  ws.ctx = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'ping') return send(ws, { type: 'pong', t0: m.t0, serverNow: Date.now() });

    if (m.type === 'join') return onJoin(ws, m);

    const ctx = ws.ctx;
    if (!ctx) return;
    const room = ctx.room;
    room.lastSeen = Date.now();

    if (m.type === 'ready') {
      if (ctx.role === 'receiver' && m.id === room.state.currentId) { ctx.ready = m.ok !== false; sendMembers(room); }
      return;
    }

    if (m.type === 'stat' && ctx.role === 'receiver') {            // receiver tarmoq/sinxron holati (host ro'yxati va adaptiv kechikish uchun)
      const n = v => (Number.isFinite(+v) ? +v : 0);
      ctx.stat = { rtt: clampN(n(m.rtt), 0, 5000), jitter: clampN(n(m.jitter), 0, 5000), q: clampN(Math.round(n(m.q)), 0, 4), drift: clampN(n(m.drift), -60000, 60000), buf: clampN(n(m.buf), 0, 3600), loss: clampN(n(m.loss), 0, 100) };
      room.dirty = true;
      return;
    }

    // Jonli efir (WebRTC) signalizatsiyasi: server faqat uzatadi
    if (m.type === 'rtc-want' && ctx.role === 'receiver') { send(room.host, { type: 'rtc-want', from: ctx.id }); return; }
    if (m.type === 'rtc-signal') {
      if (ctx.role === 'receiver') send(room.host, { type: 'rtc-signal', from: ctx.id, data: m.data });
      else {
        const target = [...room.clients].find(c => c.ctx && c.ctx.id === m.to);
        send(target, { type: 'rtc-signal', data: m.data });
      }
      return;
    }

    if (ctx.role !== 'host') return;                     // pastdagilar faqat Transmitter uchun
    const s = room.state;

    switch (m.type) {
      case 'select':
        selectItem(room, String(m.id), !!m.autoplay);
        break;
      case 'play': {
        const cur = room.items.find(i => i.id === s.currentId);
        if (!cur || !isMedia(cur.kind) || room.waitT) break;
        const notReady = () => [...room.clients].filter(c => c.ctx && !c.ctx.ready).length;
        const go = () => {
          cancelWait(room);
          s.position = s.playing ? expectedPos(room) : s.position;
          s.playing = true;
          s.playAt = Date.now() + leadMs(room);
          broadcast(room, stateMsg(room));
        };
        if (s.playing || !room.cfg.waitAll || notReady() === 0) return go();
        const t0 = Date.now();
        broadcast(room, { type: 'waiting', n: notReady() });
        room.waitT = setInterval(() => {
          const n = notReady();
          if (n === 0 || Date.now() - t0 > 6000) go();
          else broadcast(room, { type: 'waiting', n });
        }, 250);
        break;
      }
      case 'pause':
        cancelWait(room);
        if (s.playing) s.position = expectedPos(room);
        s.playing = false;
        broadcast(room, stateMsg(room));
        break;
      case 'seek': {
        const p = Math.max(0, Number(m.position) || 0);
        s.position = p;
        if (s.playing) s.playAt = Date.now() + Math.round(leadMs(room) / 2);
        broadcast(room, stateMsg(room));
        break;
      }
      case 'settings':
        s.autoNext = !!m.autoNext;
        broadcast(room, stateMsg(room));
        break;
      case 'cfg':
        applyCfg(room, m.patch);
        broadcast(room, { type: 'cfg', cfg: room.cfg });
        break;
      case 'norm': {                                  // Transmitter o'lchagan balandlik tuzatmasi: hamma qurilmaga bir xil
        const it = room.items.find(i => i.id === m.id);
        const g = Number(m.gainDb);
        if (!it || !Number.isFinite(g)) break;
        it.gainDb = Math.max(-24, Math.min(24, Math.round(g * 10) / 10));
        broadcast(room, { type: 'items', items: room.items });
        break;
      }
      case 'stop':
        cancelWait(room);
        s.playing = false; s.position = 0; s.playAt = 0;
        broadcast(room, stateMsg(room));
        break;
      case 'next':
      case 'prev': {
        const idx = room.items.findIndex(i => i.id === s.currentId);
        let target = null;
        if (m.type === 'next') target = room.items[idx + 1] || (room.cfg.loop === 'all' ? room.items[0] : null);
        else target = idx > 0 ? room.items[idx - 1] : room.items[idx];
        if (target) selectItem(room, target.id, true);
        break;
      }
      case 'ended': {
        if (m.id !== s.currentId) break;
        const idx = room.items.findIndex(i => i.id === s.currentId);
        const next = room.items[idx + 1];
        if (room.cfg.loop === 'one') selectItem(room, s.currentId, true);
        else if (next && (s.autoNext || room.cfg.loop === 'all')) selectItem(room, next.id, true);
        else if (room.cfg.loop === 'all' && room.items.length) selectItem(room, room.items[0].id, true);
        else { s.playing = false; s.position = 0; broadcast(room, stateMsg(room)); }
        break;
      }
      case 'mute-one': {
        const c = [...room.clients].find(x => x.ctx && x.ctx.id === m.id);
        if (!c) break;
        c.ctx.muted = !!m.muted;
        send(c, { type: 'you', muted: c.ctx.muted });
        sendMembers(room);
        break;
      }
      case 'kick': {
        const c = [...room.clients].find(x => x.ctx && x.ctx.id === m.id);
        if (!c) break;
        if (c.ctx.tok) room.tokens.delete(c.ctx.tok);
        send(c, { type: 'kicked' });
        try { c.close(); } catch {}
        break;
      }
      case 'rename': {                                  // YouTube sarlavhasi
        const it = room.items.find(i => i.id === m.id);
        const nm = safeName(m.name);
        if (it && it.kind === 'youtube' && nm) { it.name = nm; broadcast(room, { type: 'items', items: room.items }); }
        break;
      }
      case 'announce': {
        const text = String(m.text || '').trim().slice(0, 200);
        if (text) room.clients.forEach(c => send(c, { type: 'notice', message: '📢 ' + text }));
        break;
      }
      case 'live': {
        const id = v => (typeof v === 'string' && v ? v.slice(0, 80) : null);
        room.live = { mic: id(m.mic), screen: id(m.screen) };
        room.clients.forEach(c => send(c, { type: 'live', live: room.live }));
        break;
      }
      case 'add-url': {
        let u;
        try { u = new URL(String(m.url)); } catch { return send(ws, { type: 'notice', message: 'Havola noto\'g\'ri' }); }
        if (!/^https?:$/.test(u.protocol)) return send(ws, { type: 'notice', message: 'Faqat http/https havola' });
        const ext = path.extname(u.pathname).toLowerCase();
        const yid = ytIdOf(u);
        const item = yid ? {
          id: crypto.randomBytes(6).toString('hex'), name: safeName(m.name || 'YouTube video'), cid: '',
          kind: 'youtube', ytId: yid, url: `https://www.youtube.com/watch?v=${yid}`, size: 0, external: true, gainDb: null,
        } : {
          id: crypto.randomBytes(6).toString('hex'),
          name: safeName(m.name || decodeURIComponent(path.basename(u.pathname)) || u.hostname),
          cid: '',
          kind: kindOf(ext) || 'video',
          url: u.href, size: 0, external: true, gainDb: null,
        };
        room.items.push(item);
        let first = false;
        if (!s.currentId) { s.currentId = item.id; first = true; }
        broadcast(room, { type: 'items', items: room.items });
        if (first) broadcast(room, stateMsg(room));
        break;
      }
      case 'remove': {
        const idx = room.items.findIndex(i => i.id === m.id);
        if (idx < 0) break;
        const [item] = room.items.splice(idx, 1);
        dropItemFile(room, item);
        if (s.currentId === item.id) {
          s.currentId = null; s.playing = false; s.position = 0;
          room.clients.forEach(c => { if (c.ctx) c.ctx.ready = false; });
        }
        broadcast(room, { type: 'items', items: room.items });
        broadcast(room, stateMsg(room));
        sendMembers(room);
        break;
      }
      case 'close':
        removeRoom(room, 'Transmitter xonani yopdi');
        break;
    }
  });

  ws.on('close', () => {
    const ctx = ws.ctx;
    if (!ctx) return;
    const room = ctx.room;
    if (ctx.role === 'host') {
      if (room.host === ws) {
        room.host = null;
        room.live = { mic: null, screen: null };      // Transmitter uzildi: jonli efir to'xtaydi
        room.clients.forEach(c => send(c, { type: 'live', live: room.live }));
      }
    }
    else { room.clients.delete(ws); send(room.host, { type: 'rtc-gone', id: ctx.id }); }
    room.lastSeen = Date.now();
    if (rooms.has(room.code)) sendMembers(room);
  });
});

function onJoin(ws, m) {
  const room = rooms.get(String(m.code));
  if (!room) {
    send(ws, { type: 'error', code: 'NO_ROOM', message: 'Bunday kodli xona topilmadi' });
    return ws.close();
  }
  const isHost = m.role === 'host';
  if (isHost && m.key !== room.hostKey) {
    send(ws, { type: 'error', code: 'BAD_KEY', message: 'Transmitter kaliti noto\'g\'ri' });
    return ws.close();
  }
  const known = !isHost && m.tok && room.tokens.get(String(m.tok)) === 'receiver';   // qayta ulanayotgan receiver
  if (!isHost && room.cfg.locked && !known) {
    send(ws, { type: 'error', code: 'LOCKED', message: 'Transmitter xonani qulflagan' });
    return ws.close();
  }
  if (!isHost && room.clients.size >= MAX_CLIENTS) {
    send(ws, { type: 'error', code: 'FULL', message: 'Xona to\'lgan' });
    return ws.close();
  }

  ws.ctx = {
    room, role: isHost ? 'host' : 'receiver',
    id: crypto.randomBytes(3).toString('hex'),
    name: String(m.name || '').slice(0, 24).trim() || 'Receiver',
    ready: false, muted: false,
  };
  ws.ctx.tok = issueToken(room, ws.ctx.role, m.tok && String(m.tok));
  if (isHost) {
    if (room.host && room.host !== ws) { try { room.host.close(); } catch {} }
    room.host = ws;
  } else {
    room.clients.add(ws);
  }
  room.lastSeen = Date.now();
  send(ws, {
    type: 'joined', role: ws.ctx.role, code: room.code, items: room.items, state: room.state,
    cfg: room.cfg, live: room.live, myId: ws.ctx.id, tok: ws.ctx.tok, serverNow: Date.now(),
  });
  if (isHost) room.clients.forEach(c => send(c, { type: 'live', live: room.live, resync: true }));   // host qayta ulandi: efirni tiklash
  sendMembers(room);
}

// Proksi/hosting uzilib qolmasligi uchun yurak urishi
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 25000);

// Receiver statistikasini hostga siyraklashtirib yuborish
setInterval(() => { for (const room of rooms.values()) if (room.dirty) { room.dirty = false; sendMembers(room); } }, 2000);

// Bo'sh xonalarni tozalash
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const empty = !room.host && room.clients.size === 0;
    if ((empty && now - room.lastSeen > IDLE_ROOM_MS) || (!room.host && now - room.lastSeen > MAX_HOSTLESS_MS)) {
      removeRoom(room, 'Xona vaqti tugadi');
    }
  }
}, 60 * 1000);

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  SyncCast ishga tushdi\n');
  console.log(`  Shu kompyuterda:   http://localhost:${PORT}`);
  lanAddresses().forEach(ip => console.log(`  Wi-Fi tarmog'ida:  http://${ip}:${PORT}`));
  console.log('\n  Transmitter xona yaratadi, Receiverlar kod bilan kiradi.\n');
});

process.on('SIGINT', () => { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); process.exit(0); });
