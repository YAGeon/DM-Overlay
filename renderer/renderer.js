'use strict';

/* ------------------------------------------------------------------ утилиты */

const $ = (id) => document.getElementById(id);

const SOURCES = ['discord', 'telegram'];
const LABELS = { discord: 'Discord', telegram: 'Telegram' };
const EMOJI = { discord: '💬', telegram: '✈️' };

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const k = dayKey(iso);
  if (k === dayKey(now.toISOString())) return 'Сегодня';
  if (k === dayKey(new Date(now.getTime() - 86400000).toISOString())) return 'Вчера';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function newCtx() {
  return { lastAuthor: null, lastOwn: null, lastTime: null, lastDay: null };
}
/* --------------------------------------------------------------- состояние */

const state = {
  config: null,
  statuses: {
    discord: { state: 'disconnected', text: 'Загрузка…' },
    telegram: { state: 'disconnected', text: 'Загрузка…' },
  },
  accounts: { discord: null, telegram: null },
  active: 'discord',
  messages: { discord: [], telegram: [] },
  ids: { discord: new Set(), telegram: new Set() },
  chatUnread: { discord: {}, telegram: {} },
  unread: { discord: 0, telegram: 0 },
  view: { discord: 'list', telegram: 'list' },
  chat: { discord: null, telegram: null },
  extraChats: { discord: {}, telegram: {} },
  tgStatus: {}, // chatId -> { state, wasOnline }
  ctx: { discord: newCtx(), telegram: newCtx() },
  scroll: { discord: {}, telegram: {} },
  atBottom: true,
  reply: null,
  editing: null,
  forward: null,
  forwardTab: 'discord',
  newChatSource: 'discord',
  picker: { seg: 'emoji', gifResults: null, gifQuery: '' },
  stickers: { discord: null, telegram: null },
  stickersLoading: { discord: null, telegram: null },
  stickerPack: { discord: 0, telegram: 0 },
  settingsOpen: false,
  settingsSource: 'discord',
  tgPromptNeed: null,
  screen: 'messenger',
  music: {
    ready: false,
    error: '',
    view: 'reco',
    lib: [],
    results: [],
    reco: { loaded: false, loading: false, songs: [], playlists: [], error: '' },
    current: null,
    queue: [],
    index: -1,
    mode: 'audio',
    busy: false,
    volume: 0.8,
  },
};

const feed = $('feed');
const empty = $('empty');
const input = $('input');
const sendBtn = $('sendBtn');
const settings = $('settings');
const toastEl = $('toast');

/* ------------------------------------------------------- аватарки и медиа */

// Аватарки Telegram приходят по IPC (data URL) и кэшируются по id пользователя.
const tgAvatarCache = new Map(); // userId -> data URL | null
const tgAvatarLoading = new Map();

function tgAvatarUrl(userId) {
  const key = String(userId || '');
  if (!key || key === 'me' || key === 'unknown') return Promise.resolve(null);
  if (tgAvatarCache.has(key)) return Promise.resolve(tgAvatarCache.get(key));
  if (tgAvatarLoading.has(key)) return tgAvatarLoading.get(key);

  const p = window.api
    .telegramAvatar(key)
    .then((res) => {
      const url = res && res.ok ? res.url : null;
      tgAvatarCache.set(key, url);
      tgAvatarLoading.delete(key);
      return url;
    })
    .catch(() => {
      tgAvatarCache.set(key, null);
      tgAvatarLoading.delete(key);
      return null;
    });

  tgAvatarLoading.set(key, p);
  return p;
}

// Имя автора пересылки Telegram приходит по IPC и кэшируется по "kind:id".
const fwdNameCache = new Map(); // "kind:id" -> имя
const fwdNameLoading = new Map();

function fwdPeerName(id, kind) {
  const key = `${kind || 'user'}:${id}`;
  if (fwdNameCache.has(key)) return Promise.resolve(fwdNameCache.get(key));
  if (fwdNameLoading.has(key)) return fwdNameLoading.get(key);

  const p = window.api
    .telegramPeerName({ id, kind: kind || 'user' })
    .then((res) => {
      const name = res && res.ok ? res.name || '' : '';
      fwdNameCache.set(key, name);
      fwdNameLoading.delete(key);
      return name;
    })
    .catch(() => {
      fwdNameCache.set(key, '');
      fwdNameLoading.delete(key);
      return '';
    });

  fwdNameLoading.set(key, p);
  return p;
}

// Подставляет имя автора в уже отрисованную пометку «Переслано от …».
function resolveForwardedFrom(el, msg) {
  fwdPeerName(msg.forwardedFromId, msg.forwardedFromKind).then((name) => {
    if (!name || !el.isConnected) return;
    el.textContent = `↪ Переслано от ${name}`;
  });
}

function setAvatarImage(el, url, name) {
  if (!url) return;
  // Убираем прежнюю картинку и текст с инициалами, но оставляем индикатор статуса.
  el.querySelectorAll('img').forEach((n) => n.remove());
  for (const node of [...el.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) node.remove();
  }
  const img = document.createElement('img');
  img.alt = '';
  img.src = url;
  img.addEventListener('error', () => img.remove());
  el.insertBefore(img, el.firstChild);
  if (name) el.title = name;
}

function lazyTgAvatar(el, userId, name) {
  const key = String(userId || '');
  el.dataset.tg = key;
  if (tgAvatarCache.has(key)) {
    setAvatarImage(el, tgAvatarCache.get(key), name);
    return;
  }
  tgAvatarUrl(key).then((url) => {
    if (url && el.isConnected && el.dataset.tg === key) setAvatarImage(el, url, name);
  });
}

// Медиа Telegram отдаётся байтами по IPC; превращаем в blob-URL и кэшируем.
const mediaCache = new Map(); // key -> { url, mime }
const mediaLoading = new Map();

function bytesToBlobUrl(data, mime) {
  let bytes;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (data && data.type === 'Buffer' && Array.isArray(data.data)) bytes = new Uint8Array(data.data);
  else if (Array.isArray(data)) bytes = new Uint8Array(data);
  else bytes = new Uint8Array(data?.data || data || []);
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
}

async function getMedia(a) {
  if (a.url) return { url: a.url, mime: a.contentType || '' };
  const key = `${a.chatId}:${a.msgId}:${a.download || a.kind || 'auto'}`;
  if (mediaCache.has(key)) return mediaCache.get(key);
  if (mediaLoading.has(key)) return mediaLoading.get(key);

  const p = window.api
    .fetchMedia({ chatId: a.chatId, msgId: a.msgId, kind: a.download || a.kind || 'auto' })
    .then((res) => {
      mediaLoading.delete(key);
      if (!res || !res.ok) throw new Error(res?.error || 'не удалось получить медиа');
      const entry = { url: bytesToBlobUrl(res.data, res.mime), mime: res.mime || '' };
      mediaCache.set(key, entry);
      return entry;
    })
    .catch((e) => {
      mediaLoading.delete(key);
      throw e;
    });

  mediaLoading.set(key, p);
  return p;
}

// Медиа подгружается, когда элемент попадает в зону видимости ленты.
const mediaObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      mediaObserver.unobserve(entry.target);
      if (typeof entry.target._loadMedia === 'function') entry.target._loadMedia();
    }
  },
  { root: feed, rootMargin: '400px 0px' }
);

function makeLazyMedia(a, build, onFail) {
  if (a.url) return build({ url: a.url, mime: a.contentType || '' });

  const holder = document.createElement('div');
  holder.className = 'att-lazy';
  holder.textContent = mediaIcon(a);
  holder._loadMedia = () => {
    getMedia(a)
      .then((entry) => {
        if (holder.isConnected) holder.replaceWith(build(entry));
      })
      .catch(() => {
        if (holder.isConnected) holder.replaceWith(onFail ? onFail() : makeFileChip(a));
      });
  };
  mediaObserver.observe(holder);
  return holder;
}

// Просмотрщик медиа прямо в окне — без браузера и без скачивания файлов.
function openLightbox(url, kind, title) {
  const body = $('lightboxBody');
  body.replaceChildren();
  let node;
  if (kind === 'video') {
    node = document.createElement('video');
    node.src = url;
    node.controls = true;
    node.autoplay = true;
    node.playsInline = true;
  } else {
    node = document.createElement('img');
    node.src = url;
    node.alt = title || '';
  }
  if (title) node.title = title;
  body.appendChild(node);
  $('lightbox').hidden = false;
}

function closeLightbox() {
  const body = $('lightboxBody');
  body.querySelectorAll('video').forEach((v) => {
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch {}
  });
  body.replaceChildren();
  $('lightbox').hidden = true;
}

/* -------------------------------------------------------------------- чаты */

function initials(name) {
  const parts = String(name || '?')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function makeChatAvatar(name, url, source, userId) {
  const el = document.createElement('div');
  el.className = 'chat-avatar';
  el.textContent = initials(name);
  if (url) {
    setAvatarImage(el, url, name);
  } else if (source === 'telegram' && userId) {
    lazyTgAvatar(el, userId, name);
  }
  if (source === 'telegram' && userId && userId !== 'me') {
    el.dataset.chatAvatar = String(userId);
    const me = String(state.accounts?.telegram?.id || '');
    const dot = String(userId) === me ? null : makeStatusDot(userId);
    if (dot) el.appendChild(dot);
  }
  return el;
}

/* ---------------------------------------------------------- статусы Telegram */

const STATUS_META = {
  online: { short: 'в сети', cls: 'online' },
  recently: { short: 'не активен (недавно)', cls: 'idle' },
  lastweek: { short: 'не активен (на этой неделе)', cls: 'idle' },
  lastmonth: { short: 'не активен (в этом месяце)', cls: 'idle' },
  offline: { short: 'офлайн', cls: 'offline' },
};

function lastSeenText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const k = dayKey(iso);
  const now = new Date();
  if (k === dayKey(now.toISOString())) return `сегодня в ${time}`;
  if (k === dayKey(new Date(now.getTime() - 86400000).toISOString())) return `вчера в ${time}`;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()} в ${time}`;
}

// Человекочитаемый статус собеседника Telegram.
function statusText(st) {
  if (!st) return '';
  const meta = STATUS_META[st.state];
  if (!meta) return '';
  if (st.state === 'offline') {
    const seen = st.wasOnline ? lastSeenText(st.wasOnline) : '';
    return seen ? `был(а) в сети ${seen}` : 'офлайн';
  }
  return meta.short;
}

function makeStatusDot(chatId) {
  const st = state.tgStatus[String(chatId)];
  if (!st) return null;
  const meta = STATUS_META[st.state];
  const dot = document.createElement('span');
  dot.className = `status-dot ${meta ? meta.cls : ''}`;
  dot.dataset.statusChat = String(chatId);
  dot.title = statusText(st);
  return dot;
}

// Догружает статусы собеседников (только Telegram) и обновляет точки на месте.
function ensureStatuses(ids) {
  const me = String(state.accounts?.telegram?.id || '');
  const missing = ids
    .map((id) => String(id))
    .filter((id) => id && id !== 'me' && id !== me && !(id in state.tgStatus));
  if (!missing.length) return;
  for (const id of missing) state.tgStatus[id] = null; // помечаем «запрошено»
  window.api
    .telegramStatuses(missing)
    .then((res) => {
      if (!res || !res.ok) return;
      for (const [id, st] of Object.entries(res.statuses || {})) {
        state.tgStatus[id] = st;
      }
      applyStatuses(missing);
    })
    .catch(() => {});
}

// Обновляет точки статуса в списке чатов и в шапке без полной перерисовки.
function applyStatuses(ids) {
  const dots = [...document.querySelectorAll('.status-dot')];
  const me = String(state.accounts?.telegram?.id || '');
  for (const id of ids) {
    const key = String(id);
    if (key === me) continue;
    const st = state.tgStatus[key];
    const dot = dots.find((d) => d.dataset.statusChat === key);
    if (dot) {
      dot.className = `status-dot ${st ? STATUS_META[st.state]?.cls || '' : ''}`;
      dot.title = statusText(st);
      continue;
    }
    if (!st) continue;
    // Точки ещё нет, а статус появился — добавим её к аватару.
    const holder = [...document.querySelectorAll('.chat-avatar[data-chat-avatar]')].find(
      (h) => h.dataset.chatAvatar === key
    );
    if (holder) holder.appendChild(makeStatusDot(key));
  }
  updateChatHead();
}

// Имя собеседника: для входящих — автор, для своих — получатель.
function peerTitle(msg) {
  if (!msg) return 'Личка';
  if (!msg.own) return msg.author?.globalName || msg.author?.username || msg.channelTitle || 'Личка';
  const first = (msg.recipients || [])[0];
  if (first?.name) return first.name;
  if (msg.source === 'telegram') return msg.channelTitle || 'Личка';
  return msg.channelTitle || 'Личка';
}

function peerAvatar(msg) {
  if (!msg) return null;
  if (msg.own) return (msg.recipients || [])[0]?.avatar || null;
  return msg.author?.avatar || null;
}

function chatPreview(msg) {
  if (!msg) return '';
  let text = '';
  if (msg.content) text = String(msg.content).replace(/\s+/g, ' ').trim();
  else if (msg.sticker) text = '🎨 Стикер';
  else if (msg.attachments?.length) {
    const a = msg.attachments[0];
    const kind = mediaKindOf(a);
    if (kind === 'photo') text = '🖼 Фото';
    else if (kind === 'sticker') text = '🎨 Стикер';
    else if (kind === 'round') text = '⭕ Кружок';
    else if (kind === 'gif') text = '🖼 Гифка';
    else if (kind === 'video') text = '🎬 Видео';
    else if (kind === 'voice') text = '🎧 Голосовое';
    else if (kind === 'audio') text = '🎧 Аудио';
    else if (a.filename) text = `📎 ${a.filename}`;
    else text = '📎 Вложение';
  } else {
    text = '—';
  }
  if (text.length > 44) text = `${text.slice(0, 44)}…`;
  return msg.own ? `Вы: ${text}` : text;
}

function chatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (dayKey(iso) === dayKey(now.toISOString())) return formatTime(iso);
  if (dayKey(iso) === dayKey(new Date(now.getTime() - 86400000).toISOString())) return 'Вчера';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getChats(src) {
  const map = new Map();
  for (const msg of state.messages[src]) {
    const id = String(msg.channelId || '');
    if (!id) continue;
    let chat = map.get(id);
    if (!chat) {
      chat = { id, title: '', avatar: null, last: null, lastTime: 0 };
      map.set(id, chat);
    }
    const t = new Date(msg.timestamp).getTime() || 0;
    if (!chat.last || t >= chat.lastTime) {
      chat.last = msg;
      chat.lastTime = t;
    }
    if (!msg.own && !chat.title) {
      chat.title = peerTitle(msg);
      chat.avatar = peerAvatar(msg);
    }
    if (msg.channelType === 3 && (msg.recipients || []).length > 1) {
      chat.group = true;
      chat.title = (msg.recipients || []).map((r) => r.name).join(', ');
    }
  }
  for (const chat of map.values()) {
    if (!chat.title) {
      chat.title = peerTitle(chat.last);
      chat.avatar = peerAvatar(chat.last);
    }
  }
  // Чаты, начатые вручную («＋ Новое»), в которых пока нет сообщений.
  for (const extra of Object.values(state.extraChats[src] || {})) {
    if (map.has(extra.id)) continue;
    map.set(extra.id, {
      id: extra.id,
      title: extra.title || 'Новый чат',
      avatar: extra.avatar || null,
      last: null,
      lastTime: extra.createdAt || 0,
      channelType: extra.channelType,
      empty: true,
    });
  }
  return [...map.values()]
    .filter((c) => !isChatIgnored(src, c.id))
    .sort((a, b) => b.lastTime - a.lastTime);
}

// Игнорируемые чаты не показываем в списке (и в пересылке).
function isChatIgnored(src, id) {
  const list = state.config?.[src]?.ignored || [];
  return list.some((e) => String(e.id) === String(id));
}

function getChat(src, id) {
  if (!id) return null;
  return getChats(src).find((c) => c.id === String(id)) || null;
}

function recountUnread(src) {
  const counts = state.chatUnread[src] || {};
  state.unread[src] = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

function saveScroll() {
  const src = state.active;
  const id = state.chat[src];
  if (state.view[src] === 'chat' && id) state.scroll[src][id] = feed.scrollTop;
}

function clearActiveUnread() {
  const src = state.active;
  const id = state.chat[src];
  if (state.view[src] !== 'chat' || !id) return;
  state.chatUnread[src][id] = 0;
  recountUnread(src);
}

/* ------------------------------------------------------------- рендер HTML */

function renderContent(raw) {
  if (!raw) return '';
  const blocks = [];
  const inline = [];

  let text = String(raw).replace(/```(?:[a-zA-Z0-9+#-]+)?\n?([\s\S]*?)```/g, (_m, code) => {
    blocks.push(code);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    inline.push(code);
    return `\u0000I${inline.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  text = text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<u>$1</u>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(>])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(>])_([^_\n]+)_/g, '$1<em>$2</em>');

  text = text.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g, (url) => {
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`;
  });

  text = text
    .replace(/&lt;@!?(\d+)&gt;/g, '@упомянутый')
    .replace(/&lt;#(\d+)&gt;/g, '#канал')
    .replace(/&lt;@&amp;(\d+)&gt;/g, '@роль');

  text = text.replace(/\u0000I(\d+)\u0000/g, (_m, i) => `<code>${escapeHtml(inline[i])}</code>`);
  text = text.replace(/\u0000B(\d+)\u0000/g, (_m, i) => `<pre>${escapeHtml(blocks[i])}</pre>`);

  return text.replace(/\n/g, '<br>');
}

function makeAvatar(author, msg) {
  const av = document.createElement('div');
  av.className = 'avatar';
  av.dataset.user = author.id || '';
  const src = (msg && msg.source) || state.active;
  const name = author.globalName || author.username || '';
  av.textContent = (name || '?').slice(0, 1).toUpperCase();

  if (author.avatar) {
    setAvatarImage(av, author.avatar, name);
  } else if (src === 'telegram' && author.id && author.id !== 'me' && author.id !== 'unknown') {
    lazyTgAvatar(av, author.id, name);
  }
  return av;
}

function mediaIcon(a) {
  const kind = a.kind || '';
  if (kind === 'sticker') return '🎨';
  if (kind === 'photo' || (a.contentType || '').startsWith('image/')) return '📷';
  if (kind === 'round') return '⭕';
  if (kind === 'gif') return '🖼';
  if (kind === 'video' || (a.contentType || '').startsWith('video/')) return '🎬';
  if (kind === 'voice' || (a.contentType || '').startsWith('audio/')) return '🎧';
  return '📎';
}

function mediaKindOf(a) {
  if (a.kind) return a.kind;
  const ct = a.contentType || '';
  if (ct.startsWith('image/')) return 'photo';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'file';
}

function makeAttachment(a) {
  const kind = mediaKindOf(a);
  const fail = () => makeFileChip(a);

  if (kind === 'sticker') return makeLazyMedia(a, ({ url, mime }) => buildStickerNode(url, mime, a), fail);
  if (kind === 'photo') return makeLazyMedia(a, ({ url }) => buildPhotoNode(url, a), fail);
  if (kind === 'round') return makeLazyMedia(a, ({ url }) => buildRoundNode(url, a), fail);
  if (kind === 'gif') return makeLazyMedia(a, ({ url }) => buildGifNode(url, a), fail);
  if (kind === 'video') return makeLazyMedia(a, ({ url }) => buildVideoNode(url, a), fail);
  if (kind === 'voice' || kind === 'audio') return makeLazyMedia(a, ({ url }) => buildAudioNode(url, a), fail);
  return makeFileChip(a);
}

function buildPhotoNode(url, a) {
  const img = document.createElement('img');
  img.className = 'att-img';
  img.src = url;
  img.alt = a.filename || '';
  img.loading = 'lazy';
  img.title = a.filename || 'Фото';
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    openLightbox(url, 'image', a.filename);
  });
  return img;
}

function buildStickerNode(url, mime, a) {
  const isVideo = (mime || '').startsWith('video/') || /\.(webm|mp4)$/i.test(a.filename || '');
  if (isVideo) {
    const v = document.createElement('video');
    v.className = 'att-sticker';
    v.src = url;
    v.autoplay = true;
    v.loop = true;
    v.muted = true;
    v.playsInline = true;
    v.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(url, 'video', 'Стикер');
    });
    return v;
  }
  const img = document.createElement('img');
  img.className = 'att-sticker';
  img.src = url;
  img.alt = 'Стикер';
  img.loading = 'lazy';
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    openLightbox(url, 'image', 'Стикер');
  });
  return img;
}

function buildRoundNode(url, a) {
  const v = document.createElement('video');
  v.className = 'att-round';
  v.src = url;
  v.autoplay = true;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  v.addEventListener('click', (e) => {
    e.stopPropagation();
    openLightbox(url, 'video', a.filename || 'Видеосообщение');
  });
  return v;
}

function buildGifNode(url, a) {
  const mime = a.contentType || '';
  const isImage = mime.startsWith('image/');
  if (isImage) {
    const img = document.createElement('img');
    img.className = 'att-gif';
    img.src = url;
    img.alt = a.filename || 'Гифка';
    img.loading = 'lazy';
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(url, 'image', a.filename || 'Гифка');
    });
    return img;
  }
  const v = document.createElement('video');
  v.className = 'att-gif';
  v.src = url;
  v.autoplay = true;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  v.addEventListener('click', (e) => {
    e.stopPropagation();
    openLightbox(url, 'video', a.filename || 'Гифка');
  });
  return v;
}

function buildVideoNode(url, a) {
  const v = document.createElement('video');
  v.className = 'att-video';
  v.src = url;
  v.controls = true;
  v.preload = 'metadata';
  v.playsInline = true;
  if (a.filename) v.title = a.filename;
  return v;
}

function buildAudioNode(url, a) {
  const wrap = document.createElement('div');
  wrap.className = 'att-audio';
  const icon = document.createElement('span');
  icon.className = 'att-audio-icon';
  icon.textContent = a.kind === 'voice' ? '🎤' : '🎵';
  const audio = document.createElement('audio');
  audio.src = url;
  audio.controls = true;
  audio.preload = 'metadata';
  wrap.append(icon, audio);
  return wrap;
}

function makeFileChip(a) {
  const chip = document.createElement('div');
  chip.className = 'att-file';

  const icon = document.createElement('span');
  icon.textContent = mediaIcon(a);

  const name = document.createElement('span');
  name.className = 'fname';
  name.textContent = a.label || a.filename || 'файл';

  const size = document.createElement('span');
  size.className = 'fsize';
  size.textContent = formatSize(a.size);

  chip.append(icon, name, size);

  chip.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!a.url) {
      toast('Скачиваю файл…');
      const res = await window.api.openMedia({ chatId: a.chatId, msgId: a.msgId });
      if (!res.ok) toast(`Не удалось скачать: ${res.error}`, true);
      return;
    }
    window.api.openUrl(a.url);
  });

  chip.title = a.filename || '';
  return chip;
}

function replySnippet(reply) {
  if (!reply) return 'Сообщение';
  const text = String(reply.content || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  if (reply.sticker) {
    const name = typeof reply.sticker === 'object' ? reply.sticker.name : reply.sticker;
    return `🎨 ${name || 'Стикер'}`;
  }
  if (reply.attachments > 1) return `📎 ${reply.attachments} вложения`;
  if (reply.attachments) return '📎 Вложение';
  return 'Сообщение';
}

let flashEl = null;

// Подсветка держится, пока пользователь не кликнет или не нажмёт клавишу.
function clearFlash() {
  if (flashEl) flashEl.classList.remove('flash');
  flashEl = null;
}

function flashMessage(el) {
  clearFlash();
  el.classList.add('flash');
  flashEl = el;
}

document.addEventListener('pointerdown', clearFlash, true);
document.addEventListener('keydown', clearFlash, true);

function jumpToMessage(reply) {
  if (!reply || !reply.id) {
    toast('Исходное сообщение не сохранилось в истории', true);
    return;
  }

  const id = String(reply.id);
  const channel = reply.channelId ? String(reply.channelId) : '';
  let target = null;
  for (const node of feed.querySelectorAll('.msg')) {
    if (node.dataset.id !== id) continue;
    if (channel && node.dataset.channel && node.dataset.channel !== channel) continue;
    target = node;
    break;
  }

  if (!target) {
    toast('Исходное сообщение не сохранилось в истории', true);
    return;
  }

  // Прокручиваем только ленту. scrollIntoView двигает и контейнер .app,
  // из-за чего снизу «выезжали» настройки.
  const offset =
    target.getBoundingClientRect().top -
    feed.getBoundingClientRect().top +
    feed.scrollTop -
    Math.max(0, (feed.clientHeight - target.offsetHeight) / 2);
  feed.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });

  flashMessage(target);
}

function buildMessage(msg, ctx, instant) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.id = msg.id;
  el.dataset.channel = msg.channelId || '';
  el.dataset.source = msg.source || state.active;
  if (msg.own) el.classList.add('own');
  if (instant) el.style.animation = 'none';

  const key = dayKey(msg.timestamp);
  const sameAuthor = ctx.lastAuthor === msg.author.id && ctx.lastOwn === msg.own && ctx.lastDay === key;
  const close =
    sameAuthor &&
    ctx.lastTime &&
    new Date(msg.timestamp).getTime() - new Date(ctx.lastTime).getTime() < 5 * 60 * 1000;

  if (close) el.classList.add('grouped');

  el.appendChild(makeAvatar(msg.author, msg));

  const body = document.createElement('div');
  body.className = 'body';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name' + (msg.author.bot ? ' bot' : '');
  name.textContent = msg.author.globalName || msg.author.username;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(msg.timestamp);
  meta.append(name, time);
  if (msg.edited) {
    const ed = document.createElement('span');
    ed.className = 'edited';
    ed.textContent = 'изм.';
    meta.appendChild(ed);
  }
  body.appendChild(meta);

  if (msg.replyTo) {
    const q = document.createElement('button');
    q.type = 'button';
    q.className = 'reply-quote';
    q.title = 'Перейти к сообщению';

    const author = document.createElement('span');
    author.className = 'reply-author';
    author.textContent = msg.replyTo.author || 'Сообщение';

    const text = document.createElement('span');
    text.className = 'reply-text';
    text.textContent = replySnippet(msg.replyTo);

    q.append(author, text);
    q.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToMessage(msg.replyTo);
    });
    body.appendChild(q);
  }

  if (msg.forwarded) {
    const fwd = document.createElement('div');
    fwd.className = 'fwd-label';
    fwd.textContent = msg.forwardedFrom
      ? `↪ Переслано от ${msg.forwardedFrom}`
      : '↪ Переслано';
    if (!msg.forwardedFrom && msg.forwardedFromId) {
      fwd.dataset.fwdId = msg.forwardedFromId;
      fwd.dataset.fwdKind = msg.forwardedFromKind || 'user';
      resolveForwardedFrom(fwd, msg);
    }
    body.appendChild(fwd);
  }

  // Медиа показываем выше подписи: фото/видео, а под ним — текст.
  if (msg.sticker) {
    const st = typeof msg.sticker === 'string' ? { name: msg.sticker } : msg.sticker;
    if (st && st.url) {
      const img = document.createElement('img');
      img.className = 'att-sticker';
      img.src = st.url;
      img.alt = st.name || 'Стикер';
      img.loading = 'lazy';
      img.title = st.name || 'Стикер';
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        openLightbox(st.url, 'image', st.name);
      });
      body.appendChild(img);
    } else {
      const t = document.createElement('div');
      t.className = 'text';
      t.textContent = `🎨 ${st?.name || 'Стикер'}`;
      body.appendChild(t);
    }
  }

  if (msg.attachments && msg.attachments.length) {
    const wrap = document.createElement('div');
    wrap.className = 'attachments';
    for (const raw of msg.attachments) {
      const a = { ...raw, chatId: msg.channelId, msgId: msg.id };
      wrap.appendChild(makeAttachment(a));
    }
    body.appendChild(wrap);
  }

  if (msg.content) {
    const text = document.createElement('div');
    text.className = 'text';
    if (msg.attachments && msg.attachments.length) text.classList.add('caption');
    text.innerHTML = renderContent(msg.content);
    body.appendChild(text);
  }

  if (!msg.content && !msg.sticker && (!msg.attachments || !msg.attachments.length)) {
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = '—';
    body.appendChild(text);
  }

  el.appendChild(body);

  const actions = document.createElement('button');
  actions.type = 'button';
  actions.className = 'msg-actions';
  actions.title = 'Действия с сообщением';
  actions.textContent = '⋯';
  actions.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = actions.getBoundingClientRect();
    openMsgMenu(msg, el, rect.left, rect.bottom + 4);
  });
  el.appendChild(actions);

  if (isSelectable(msg)) {
    el.classList.add('selectable');
    el.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      setReply(msg, el);
    });
  }

  ctx.lastAuthor = msg.author.id;
  ctx.lastOwn = msg.own;
  ctx.lastDay = key;
  ctx.lastTime = msg.timestamp;

  return el;
}

function addDayDivider(iso) {
  const d = document.createElement('div');
  d.className = 'day';
  d.textContent = dayLabel(iso);
  feed.appendChild(d);
}

/* -------------------------------------------------------------- прокрутка */

function isAtBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
}

function scrollToBottom(smooth = false) {
  feed.style.scrollBehavior = smooth ? 'smooth' : 'auto';
  feed.scrollTop = feed.scrollHeight;
  state.atBottom = true;
  clearActiveUnread();
  updateScrollBtn();
  updateTabs();
  setTimeout(() => {
    feed.style.scrollBehavior = '';
  }, smooth ? 350 : 30);
}

function updateScrollBtn() {
  const btn = $('scrollBtn');
  const src = state.active;
  const n =
    state.view[src] === 'chat' && state.chat[src]
      ? state.chatUnread[src][state.chat[src]] || 0
      : 0;
  if (n > 0 && !state.atBottom) {
    btn.hidden = false;
    btn.textContent = n > 1 ? `↓ ${n} новых` : '↓ новое сообщение';
  } else {
    btn.hidden = true;
  }
}

/* ---------------------------------------------------------------- сообщения */

function appendToDom(msg, ctx, instant, wasBottom) {
  if (ctx.lastDay !== dayKey(msg.timestamp)) {
    addDayDivider(msg.timestamp);
    ctx.lastAuthor = null;
    ctx.lastOwn = null;
    ctx.lastTime = null;
    ctx.lastDay = dayKey(msg.timestamp);
  }

  const el = buildMessage(msg, ctx, instant);
  feed.appendChild(el);
  empty.hidden = true;

  if (wasBottom) requestAnimationFrame(() => scrollToBottom(false));
}

function appendMessage(msg) {
  if (!msg || !msg.id) return;
  const src = msg.source === 'telegram' ? 'telegram' : 'discord';
  msg.source = src;
  if (state.ids[src].has(msg.id)) return;
  state.ids[src].add(msg.id);

  state.messages[src].push(msg);
  if (state.messages[src].length > 300) {
    const dropped = state.messages[src].shift();
    if (dropped?.id) state.ids[src].delete(dropped.id);
  }

  const chatId = String(msg.channelId || '');
  const isActive = src === state.active;
  const viewingChat =
    isActive && state.view[src] === 'chat' && chatId === String(state.chat[src] || '');
  const viewingList = isActive && state.view[src] === 'list';

  if (viewingChat) {
    const wasBottom = state.atBottom || isAtBottom();
    appendToDom(msg, state.ctx[src], false, wasBottom);
    updateEmptyState();
    if (!wasBottom && !msg.own) {
      state.chatUnread[src][chatId] = (state.chatUnread[src][chatId] || 0) + 1;
    }
  } else if (!msg.own && chatId) {
    state.chatUnread[src][chatId] = (state.chatUnread[src][chatId] || 0) + 1;
  }

  recountUnread(src);

  if (viewingList) renderChatList({ preserveScroll: true });

  updateTabs();
  updateScrollBtn();
  if (!msg.own) playPing();
}

function renderChatList({ preserveScroll = false } = {}) {
  const src = state.active;
  const chats = getChats(src);
  const prevScroll = feed.scrollTop;

  clearFlash();
  clearReply();
  feed.querySelectorAll('.msg, .day').forEach((n) => n.remove());

  const box = $('chats');
  box.replaceChildren();

  for (const chat of chats) {
    const unread = state.chatUnread[src][chat.id] || 0;

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chat-item' + (unread ? ' has-unread' : '');
    item.dataset.chat = chat.id;

    item.appendChild(makeChatAvatar(chat.title, chat.avatar, src, chat.id));

    const main = document.createElement('div');
    main.className = 'chat-main';

    const row1 = document.createElement('div');
    row1.className = 'chat-row';
    const name = document.createElement('span');
    name.className = 'chat-name';
    name.textContent = chat.title;
    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = chatTime(chat.last?.timestamp);
    row1.append(name, time);

    const row2 = document.createElement('div');
    row2.className = 'chat-row';
    const preview = document.createElement('span');
    preview.className = 'chat-preview';
    preview.textContent = chat.last ? chatPreview(chat.last) : 'Нет сообщений';
    row2.appendChild(preview);
    if (unread) {
      const badge = document.createElement('span');
      badge.className = 'chat-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      row2.appendChild(badge);
    }

    main.append(row1, row2);
    item.appendChild(main);
    item.addEventListener('click', () => openChat(chat.id));
    box.appendChild(item);
  }

  box.hidden = chats.length === 0;

  if (src === 'telegram') ensureStatuses(chats.map((c) => c.id));

  state.view[src] = 'list';
  state.chat[src] = null;
  state.atBottom = false;
  $('chatHead').hidden = true;
  $('composer').hidden = true;
  $('scrollBtn').hidden = true;

  updateChatHead();
  updateEmptyState();
  updateTabs();

  feed.scrollTop = preserveScroll ? prevScroll : 0;
}

function openChat(id) {
  const src = state.active;
  saveScroll();
  state.chat[src] = String(id);
  state.view[src] = 'chat';
  const hadUnread = (state.chatUnread[src][state.chat[src]] || 0) > 0;
  // Если в чате есть непрочитанные — открываем на последнем сообщении.
  if (hadUnread) delete state.scroll[src][state.chat[src]];
  state.chatUnread[src][state.chat[src]] = 0;
  recountUnread(src);
  clearReply();
  clearEdit(true);
  togglePicker(false);
  clearFlash();
  renderFeed();
}

function openChatList() {
  const src = state.active;
  saveScroll();
  state.view[src] = 'list';
  state.chat[src] = null;
  clearReply();
  clearEdit(true);
  togglePicker(false);
  clearFlash();
  renderChatList();
}

/* -------------------------------------------------------- новый чат (ЛС) */

function openNewChat() {
  const src = state.active;
  if (src !== 'discord' && src !== 'telegram') return;
  state.newChatSource = src;

  const modal = $('newChat');
  modal.hidden = false;
  $('newChatResults').replaceChildren();
  $('newChatQuery').value = '';
  $('newChatId').value = '';
  setNewChatStatus('');

  if (src === 'telegram') {
    $('newChatTitle').textContent = 'Новое сообщение в Telegram';
    $('newChatSearchLabel').textContent = 'Найти в Telegram';
    $('newChatQuery').placeholder = '@ник или имя';
    $('newChatSearchHint').textContent =
      'Ищет по контактам и известным пользователям Telegram.';
    $('newChatIdLabel').textContent = 'Или вставь @ник / ID';
    $('newChatId').placeholder = '@username';
    $('newChatIdHint').textContent =
      'Можно написать любому: укажи @username, номер телефона или ID пользователя.';
  } else {
    $('newChatTitle').textContent = 'Новое сообщение в Discord';
    $('newChatSearchLabel').textContent = 'Найти среди друзей';
    $('newChatQuery').placeholder = 'Имя или @ник';
    $('newChatSearchHint').textContent =
      'Ищет по списку друзей Discord и по тем, с кем уже есть переписка.';
    $('newChatIdLabel').textContent = 'Или вставь ID пользователя';
    $('newChatId').placeholder = '000000000000000000';
    $('newChatIdHint').textContent =
      'Подходит для любого человека, даже не из друзей. Discord → Настройки → Дополнительно → Режим разработчика, затем ПКМ по человеку → «Копировать ID».';
  }

  updateNewChatBtn();
  setTimeout(() => $('newChatQuery').focus(), 60);
}

function closeNewChat() {
  $('newChat').hidden = true;
  updateNewChatBtn();
}

function setNewChatStatus(text, isError = false) {
  const el = $('newChatStatus');
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('error');
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

async function searchNewChat() {
  const src = state.newChatSource;
  const q = $('newChatQuery').value.trim();
  if (q.length < 2) {
    setNewChatStatus('Введи хотя бы 2 символа.', true);
    return;
  }
  setNewChatStatus(src === 'telegram' ? 'Ищу в Telegram…' : 'Ищу среди друзей…');
  $('newChatResults').replaceChildren();
  $('newChatSearch').disabled = true;

  const res =
    src === 'telegram'
      ? await window.api.telegramSearchUsers(q)
      : await window.api.discordSearchUsers(q);

  $('newChatSearch').disabled = false;
  if (!res.ok) {
    setNewChatStatus(`Поиск не удался: ${res.error}`, true);
    return;
  }
  if (!res.users.length) {
    setNewChatStatus(
      src === 'telegram'
        ? 'Никого не нашёл. Вставь @ник или ID вручную ниже — так можно написать любому.'
        : 'Никого не нашёл. Вставь ID пользователя вручную ниже — так можно написать любому.',
      true
    );
    return;
  }
  setNewChatStatus(`Найдено: ${res.users.length}. Выбери человека.`);
  renderNewChatResults(res.users);
}

function renderNewChatResults(users) {
  const box = $('newChatResults');
  const src = state.newChatSource;
  box.replaceChildren();
  for (const u of users) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'new-chat-item';
    item.appendChild(makeChatAvatar(u.globalName, u.avatar, src, u.id));

    const main = document.createElement('div');
    main.className = 'new-chat-item-main';
    const name = document.createElement('span');
    name.className = 'new-chat-item-name';
    name.textContent = u.globalName || u.username || 'Пользователь';
    const sub = document.createElement('span');
    sub.className = 'new-chat-item-sub';
    sub.textContent = [u.username ? `@${u.username}` : '', u.guild].filter(Boolean).join(' · ');
    main.append(name, sub);

    item.appendChild(main);
    item.addEventListener('click', () => startNewChat(u.id));
    box.appendChild(item);
  }
}

async function startNewChat(userId) {
  const src = state.newChatSource;
  setNewChatStatus('Открываю чат…');
  const res =
    src === 'telegram'
      ? await window.api.telegramOpenDm(userId)
      : await window.api.discordOpenDm(userId);
  if (!res.ok) {
    setNewChatStatus(`Не удалось открыть чат: ${res.error}`, true);
    return;
  }
  finishNewChat(src, res.chat);
}

async function openNewChatById() {
  const src = state.newChatSource;
  const raw = $('newChatId').value.trim();
  if (src === 'discord') {
    if (!/^\d{15,25}$/.test(raw)) {
      setNewChatStatus('ID должен состоять из 15–25 цифр.', true);
      return;
    }
  } else if (raw.length < 3) {
    setNewChatStatus('Укажи @ник или ID пользователя.', true);
    return;
  }

  setNewChatStatus('Открываю чат…');
  $('newChatOpenId').disabled = true;
  const res =
    src === 'telegram'
      ? await window.api.telegramOpenDm(raw)
      : await window.api.discordOpenDm(raw);
  $('newChatOpenId').disabled = false;
  if (!res.ok) {
    setNewChatStatus(`Не удалось открыть чат: ${res.error}`, true);
    return;
  }
  finishNewChat(src, res.chat);
}

function finishNewChat(src, chat) {
  const title = chat.user?.globalName || chat.user?.username || 'Новый чат';
  state.extraChats[src][chat.channelId] = {
    id: String(chat.channelId),
    title,
    avatar: chat.user?.avatar || null,
    channelType: chat.channelType,
    createdAt: Date.now(),
  };
  closeNewChat();
  if (state.screen !== 'messenger') setScreen('messenger');
  if (state.active !== src) switchSource(src);
  openChat(chat.channelId);
  toast(`Чат с ${title} открыт — напиши сообщение`);
}

function updateChatHead() {
  const src = state.active;
  const chat = state.view[src] === 'chat' ? getChat(src, state.chat[src]) : null;
  if (!chat) {
    $('chatHead').hidden = true;
    return;
  }
  $('chatHead').hidden = false;
  $('chatHeadName').textContent = chat.title;

  const isGroup = chat.last?.channelType === 3 || chat.group;
  const me = String(state.accounts?.telegram?.id || '');
  let sub;
  if (src === 'telegram' && !isGroup && String(chat.id) !== me) {
    ensureStatuses([chat.id]);
    const st = state.tgStatus[String(chat.id)];
    const txt = statusText(st);
    sub = txt ? `Telegram · ${txt}` : 'Telegram · личные сообщения';
  } else {
    sub = `${LABELS[src]} · ${isGroup ? 'групповой чат' : 'личные сообщения'}`;
  }
  $('chatHeadSub').textContent = sub;
  $('chatHeadAvatar').replaceChildren(makeChatAvatar(chat.title, chat.avatar, src, chat.id));
}

function renderFeed() {
  const src = state.active;
  const chatId = state.chat[src];

  if (!chatId) {
    renderChatList();
    return;
  }

  clearFlash();
  feed.querySelectorAll('.msg, .day').forEach((n) => n.remove());

  const box = $('chats');
  box.replaceChildren();
  box.hidden = true;

  state.ctx[src] = newCtx();

  feed.style.scrollBehavior = 'auto';
  for (const msg of state.messages[src]) {
    if (String(msg.channelId) !== String(chatId)) continue;
    if (state.ctx[src].lastDay !== dayKey(msg.timestamp)) {
      addDayDivider(msg.timestamp);
      state.ctx[src].lastAuthor = null;
      state.ctx[src].lastOwn = null;
      state.ctx[src].lastTime = null;
      state.ctx[src].lastDay = dayKey(msg.timestamp);
    }
    feed.appendChild(buildMessage(msg, state.ctx[src], true));
  }

  state.view[src] = 'chat';
  $('composer').hidden = false;
  updateChatHead();
  updateEmptyState();

  const saved = state.scroll[src][chatId];
  feed.scrollTop = saved != null && saved < feed.scrollHeight ? saved : feed.scrollHeight;
  feed.style.scrollBehavior = '';

  state.atBottom = isAtBottom();
  if (state.atBottom) {
    state.chatUnread[src][chatId] = 0;
    recountUnread(src);
  }
  updateScrollBtn();
  updateTabs();
}

/* -------------------------------------------------------------------- звук */

let audioCtx = null;

function playPing() {
  if (!state.config || !state.config.sound) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;

    [
      [880, 0],
      [1318.5, 0.085],
    ].forEach(([freq, delay]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.15, t + delay + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.2);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.24);
    });
  } catch {
    /* звук не критичен */
  }
}

/* ------------------------------------------------------------------- статус */

function setStatus(payload) {
  if (!payload || !SOURCES.includes(payload.source)) return;
  const src = payload.source;
  state.statuses[src] = { state: payload.state, text: payload.text };

  if (src === state.active) updateHeaderStatus();
  updateTabs();
  updateEmptyState();

  if (src === 'telegram' && payload.state === 'online') {
    state.tgPromptNeed = null;
    $('tgPrompt').hidden = true;
    hideTgQr();
    $('tgApiHash').value = '';
  } else if (src === 'telegram' && payload.state === 'error') {
    hideTgQr();
  }
}

function updateHeaderStatus() {
  if (state.screen === 'music') {
    const m = state.music;
    const text = m.current
      ? `♪ ${m.current.title}`
      : '♪ Музыка — YouTube';
    $('statusText').textContent = text;
    $('statusDot').className =
      'dot ' + (m.ready ? 'online' : m.error ? 'error' : 'connecting');
    return;
  }

  const st = state.statuses[state.active];
  $('statusText').textContent = st.text || '';
  $('statusDot').className = 'dot ' + (st.state || '');
}

function updateTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    const src = tab.dataset.source;
    const dot = tab.querySelector('.dot');

    if (src === 'music') {
      tab.classList.toggle('active', state.screen === 'music');
      if (dot) {
        dot.className =
          'dot ' +
          (state.music.ready ? 'online' : state.music.error ? 'error' : 'connecting');
      }
      return;
    }

    tab.classList.toggle('active', state.screen === 'messenger' && src === state.active);
    dot.className = 'dot ' + (state.statuses[src]?.state || '');

    const badge = tab.querySelector('.badge');
    const n = state.unread[src] || 0;
    badge.hidden = n <= 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  });

  updateNewChatBtn();
}

// Кнопка «＋ Новое» — в списке чатов, когда активный источник подключён.
function updateNewChatBtn() {
  const btn = $('newChatBtn');
  if (!btn) return;
  const src = state.active;
  const show =
    state.screen === 'messenger' &&
    (src === 'discord' || src === 'telegram') &&
    state.statuses[src]?.state === 'online' &&
    state.view[src] === 'list' &&
    !state.settingsOpen &&
    $('newChat').hidden;
  btn.hidden = !show;
}

function updateEmptyState() {
  const src = state.active;
  const st = state.statuses[src];
  const inChat = state.view[src] === 'chat' && !!state.chat[src];

  const has = inChat
    ? state.messages[src].some((m) => String(m.channelId) === String(state.chat[src]))
    : getChats(src).length > 0;

  empty.hidden = has;
  if (has) return;

  $('emptyEmoji').textContent = inChat ? '💬' : EMOJI[src];
  const title = $('emptyTitle');
  const hint = $('emptyHint');
  const btn = $('emptySettings');
  const label = LABELS[src];

  if (st.state === 'online') {
    title.textContent = inChat ? 'Пока тихо' : 'Пока нет чатов';
    hint.textContent = inChat
      ? `Слушаю личные сообщения в ${label}. Окно можно скрыть в трей — уведомления продолжат приходить.`
      : `Как только придёт личное сообщение в ${label}, здесь появится чат с собеседником.`;
    btn.hidden = true;
  } else if (st.state === 'connecting') {
    title.textContent = `Подключаюсь к ${label}…`;
    hint.textContent = 'Как только соединение установится, чаты появятся здесь.';
    btn.hidden = true;
  } else {
    title.textContent = 'Здесь появятся чаты';
    hint.textContent =
      st.state === 'error' && st.text
        ? st.text
        : `Подключи ${label} в настройках (⚙), чтобы получать сообщения.`;
    btn.hidden = false;
  }
}

/* -------------------------------------------------------------------- toast */

let toastTimer = null;
function toast(text, isError = false) {
  toastEl.textContent = text;
  toastEl.className = 'toast' + (isError ? ' error' : '');
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3800);
}

/* ------------------------------------------------------------------ вкладки */

function switchSource(src, { persist = true } = {}) {
  if (!SOURCES.includes(src)) return;
  if (src === state.active) {
    if (state.view[src] === 'chat') openChatList();
    return;
  }

  saveScroll();
  state.active = src;
  state.atBottom = true;
  clearReply();
  clearEdit(true);
  togglePicker(false);
  clearFlash();

  updateTabs();
  updateHeaderStatus();
  updateComposer();

  if (state.view[src] === 'chat' && state.chat[src]) renderFeed();
  else renderChatList();

  if (persist) window.api.setConfig({ activeSource: src });
}

/* ------------------------------------------------------------------ ответы */

function isSelectable(msg) {
  // Отвечать можно и на своё сообщение (в т.ч. чтобы поправить себя).
  return !!msg && !!msg.channelId && msg.channelId !== 'demo';
}

function setReply(msg, el) {
  document.querySelectorAll('.msg.selected').forEach((n) => n.classList.remove('selected'));
  if (el) el.classList.add('selected');

  if (state.editing) clearEdit(true);

  const src = msg.source || state.active;
  state.reply = {
    source: src,
    chatId: msg.channelId,
    msgId: msg.id,
    name: msg.author?.globalName || msg.author?.username || 'Вы',
    content: msg.content || '',
    attachments: (msg.attachments || []).length,
    sticker: msg.sticker || null,
  };

  $('replyHint').hidden = false;
  $('replyName').textContent = state.reply.name;
  $('replyPreview').textContent = replySnippet(state.reply);

  const allow = !!state.config?.[src]?.allowSend;
  if (!allow) {
    toast(`Сообщение выбрано. Включи «Разрешить ответы» для ${LABELS[src]} в настройках.`);
  } else {
    input.focus();
  }
}

function clearReply() {
  state.reply = null;
  document.querySelectorAll('.msg.selected').forEach((n) => n.classList.remove('selected'));
  $('replyHint').hidden = true;
  $('replyPreview').textContent = '';
}

function updateComposer() {
  const src = state.active;
  const allow = !!state.config?.[src]?.allowSend;
  input.disabled = !allow;
  sendBtn.disabled = !allow;
  input.placeholder = allow
    ? 'Написать сообщение…'
    : `Ответы в ${LABELS[src]} выключены в настройках`;
}

/* --------------------------------------------------- действия с сообщениями */

let msgMenu = null;

function closeMsgMenu() {
  if (msgMenu) {
    msgMenu.remove();
    msgMenu = null;
  }
}

function findMessage(el) {
  const src = el.dataset.source || state.active;
  const id = String(el.dataset.id || '');
  const ch = String(el.dataset.channel || '');
  return (
    state.messages[src].find((m) => String(m.id) === id && String(m.channelId) === ch) || null
  );
}

function openMsgMenu(msg, el, x, y) {
  closeMsgMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';

  const add = (label, fn, danger) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (danger) b.classList.add('danger');
    b.addEventListener('click', () => {
      closeMsgMenu();
      fn();
    });
    menu.appendChild(b);
  };

  if (isSelectable(msg)) add('↩ Ответить', () => setReply(msg, el));
  if (msg.own && msg.content) add('✏️ Изменить', () => startEdit(msg));
  if (msg.own) {
    const src = msg.source || state.active;
    if (src === 'telegram') {
      add('🗑 Удалить у себя', () => deleteOwnMessage(msg, 'self'), true);
      add('🗑 Удалить у всех', () => deleteOwnMessage(msg, 'all'), true);
    } else {
      add('🗑 Удалить сообщение', () => deleteOwnMessage(msg, 'all'), true);
    }
    add('🙈 Убрать из оверлея', () => deleteOwnMessage(msg, 'local'));
  }
  add('➡️ Переслать', () => openForward(msg));
  if (msg.content) add('📋 Копировать текст', () => copyText(msg.content));

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const px = Math.max(4, Math.min(x, window.innerWidth - rect.width - 6));
  const py = Math.max(4, Math.min(y, window.innerHeight - rect.height - 6));
  menu.style.left = `${px}px`;
  menu.style.top = `${py}px`;
  msgMenu = menu;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Текст скопирован');
  } catch {
    toast('Не удалось скопировать', true);
  }
}

/* ------------------------------------------------------- удаление сообщений */

// mode: 'all' — удалить у всех, 'self' — только у себя (Telegram),
// 'local' — убрать только из оверлея.
async function deleteOwnMessage(msg, mode) {
  const src = msg.source || state.active;
  const labels = { all: 'Удаляю сообщение…', self: 'Удаляю у себя…', local: 'Убираю из оверлея…' };
  toast(labels[mode] || 'Удаляю…');
  const res = await window.api.deleteMessage({
    source: src,
    chatId: msg.channelId,
    msgId: msg.id,
    mode,
  });
  if (!res.ok) {
    toast(`Не удалось удалить: ${res.error}`, true);
    return;
  }
  removeMessageLocally(src, msg.channelId, msg.id);
  if (mode === 'local') toast('Сообщение убрано из оверлея');
  else if (mode === 'self') toast('Сообщение удалено у тебя в Telegram');
  else toast('Сообщение удалено');
}

function removeMessageLocally(src, chatId, msgId) {
  const ch = String(chatId);
  const id = String(msgId);
  state.messages[src] = state.messages[src].filter(
    (m) => !(String(m.channelId) === ch && String(m.id) === id)
  );
  state.ids[src].delete(id);

  // Если открыт тот же чат — просто убираем сообщение из DOM.
  const inChat =
    state.active === src && state.view[src] === 'chat' && String(state.chat[src]) === ch;
  if (inChat) {
    const node = feed.querySelector(`.msg[data-id="${id}"][data-channel="${ch}"]`);
    if (node) node.remove();
    updateEmptyState();
  } else if (state.active === src && state.view[src] === 'list') {
    renderChatList({ preserveScroll: true });
  }
}

/* ------------------------------------------------------------- удаление чата */

let chatMenu = null;

function closeChatMenu() {
  if (chatMenu) {
    chatMenu.remove();
    chatMenu = null;
  }
}

function openChatMenu(chat, x, y) {
  closeChatMenu();
  const src = state.active;
  const menu = document.createElement('div');
  menu.className = 'msg-menu';

  const add = (label, danger, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (danger) b.classList.add('danger');
    b.addEventListener('click', () => {
      closeChatMenu();
      fn();
    });
    menu.appendChild(b);
  };

  add('🗑 Удалить чат', false, () => deleteChat(src, chat));
  add('🚫 Удалить чат и игнорировать', true, () => ignoreChat(src, chat));

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const px = Math.max(4, Math.min(x, window.innerWidth - rect.width - 6));
  const py = Math.max(4, Math.min(y, window.innerHeight - rect.height - 6));
  menu.style.left = `${px}px`;
  menu.style.top = `${py}px`;
  chatMenu = menu;
}

async function deleteChat(src, chat) {
  const res = await window.api.chatDelete({ source: src, chatId: chat.id });
  if (!res.ok) {
    toast(`Не удалось удалить чат: ${res.error}`, true);
    return;
  }
  forgetChatLocally(src, chat.id);
  toast(`Чат «${chat.title || 'без имени'}» удалён из оверлея`);
}

async function ignoreChat(src, chat) {
  const res = await window.api.chatIgnore({
    source: src,
    chatId: chat.id,
    title: chat.title || '',
  });
  if (!res.ok) {
    toast(`Не удалось игнорировать чат: ${res.error}`, true);
    return;
  }
  forgetChatLocally(src, chat.id);
  toast(`Чат «${chat.title || 'без имени'}» удалён и добавлен в игнорируемые`);
}

// Убирает чат из состояния оверлея (в Discord/Telegram ничего не удаляем).
function forgetChatLocally(src, chatId) {
  const ch = String(chatId);
  state.messages[src] = state.messages[src].filter((m) => String(m.channelId) !== ch);
  state.ids[src] = new Set(state.messages[src].map((m) => String(m.id)));
  delete state.chatUnread[src][ch];
  delete state.scroll[src][ch];
  delete state.extraChats[src][ch];
  recountUnread(src);

  if (state.active === src && state.view[src] === 'chat' && String(state.chat[src]) === ch) {
    openChatList();
    return;
  }
  if (state.active === src && state.view[src] === 'list') {
    renderChatList({ preserveScroll: true });
  }
  updateTabs();
}

/* ------------------------------------------------------- редактирование */

function startEdit(msg) {
  const src = msg.source || state.active;
  if (!state.config?.[src]?.allowSend) {
    toast(`Редактирование в ${LABELS[src]} выключено в настройках`, true);
    return;
  }
  clearReply();
  state.editing = {
    source: src,
    chatId: msg.channelId,
    msgId: msg.id,
    original: msg.content || '',
  };
  input.value = msg.content || '';
  $('editHint').hidden = false;
  $('editPreview').textContent = replySnippet({ content: msg.content });
  input.focus();
}

function clearEdit(clearInput = false) {
  if (!state.editing) return;
  state.editing = null;
  $('editHint').hidden = true;
  $('editPreview').textContent = '';
  if (clearInput) input.value = '';
}

function applyEditedLocally(src, chatId, msgId, content) {
  const msg = state.messages[src].find(
    (m) => String(m.id) === String(msgId) && String(m.channelId) === String(chatId)
  );
  if (!msg) return;
  msg.content = content;
  msg.edited = true;

  const node = feed.querySelector(`.msg[data-id="${msgId}"][data-channel="${chatId}"]`);
  if (!node) return;
  const body = node.querySelector('.body');
  if (!body) return;
  let text = body.querySelector('.text');
  if (!text) {
    text = document.createElement('div');
    text.className = 'text';
    const meta = body.querySelector('.meta');
    if (meta && meta.nextSibling) body.insertBefore(text, meta.nextSibling);
    else body.appendChild(text);
  }
  text.innerHTML = renderContent(content);
  const meta = body.querySelector('.meta');
  if (meta && !meta.querySelector('.edited')) {
    const ed = document.createElement('span');
    ed.className = 'edited';
    ed.textContent = 'изм.';
    meta.appendChild(ed);
  }
}

/* ------------------------------------------------------------ пересылка */

function openForward(msg) {
  state.forward = {
    source: msg.source || state.active,
    chatId: msg.channelId,
    msgId: msg.id,
  };

  const preview = $('forwardPreview');
  preview.replaceChildren();
  const author = document.createElement('div');
  author.className = 'forward-preview-author';
  author.textContent = msg.author?.globalName || msg.author?.username || 'Сообщение';
  const text = document.createElement('div');
  text.className = 'forward-preview-text';
  text.textContent = chatPreview({ ...msg, own: false });
  preview.append(author, text);

  $('forwardQuery').value = '';
  // По умолчанию открываем вкладку того же мессенджера, откуда пересылаем.
  state.forwardTab = state.forward.source === 'telegram' ? 'telegram' : 'discord';
  renderForwardList('');
  $('forwardModal').hidden = false;
  setTimeout(() => $('forwardQuery').focus(), 60);
}

function closeForward() {
  $('forwardModal').hidden = true;
  state.forward = null;
}

// Переключение вкладки Discord/Telegram в окне пересылки.
function setForwardTab(src) {
  if (!SOURCES.includes(src)) return;
  state.forwardTab = src;
  renderForwardList($('forwardQuery').value);
}

function renderForwardList(query) {
  const box = $('forwardList');
  const q = String(query || '').trim().toLowerCase();
  const src = SOURCES.includes(state.forwardTab) ? state.forwardTab : 'discord';

  // Счётчики чатов на вкладках + подсветка активной.
  const counts = {};
  for (const s of SOURCES) counts[s] = getChats(s).length;
  for (const btn of document.querySelectorAll('#forwardTabs .forward-tab')) {
    const s = btn.dataset.src;
    btn.classList.toggle('active', s === src);
    btn.textContent = `${LABELS[s]} (${counts[s] || 0})`;
  }

  box.replaceChildren();
  let total = 0;

  for (const chat of getChats(src)) {
    if (q && !String(chat.title || '').toLowerCase().includes(q)) continue;
    total++;

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'forward-item';
    item.appendChild(makeChatAvatar(chat.title, chat.avatar, src, chat.id));

    const main = document.createElement('div');
    main.className = 'forward-item-main';
    const name = document.createElement('span');
    name.className = 'forward-item-name';
    name.textContent = chat.title || 'Чат';
    const sub = document.createElement('span');
    sub.className = 'forward-item-sub';
    sub.textContent = LABELS[src];
    main.append(name, sub);
    item.appendChild(main);

    item.addEventListener('click', () => doForward(src, chat.id));
    box.appendChild(item);
  }

  if (!total) {
    const hint = document.createElement('div');
    hint.className = 'forward-empty';
    hint.textContent = q
      ? 'Ничего не найдено.'
      : `Пока нет чатов ${LABELS[src]} — переписка появится после первых сообщений.`;
    box.appendChild(hint);
  }
}

async function doForward(toSource, toChatId) {
  if (!state.forward) return;
  if (!state.config?.[toSource]?.allowSend) {
    toast(`Отправка в ${LABELS[toSource]} выключена в настройках`, true);
    return;
  }
  const from = { ...state.forward };
  const res = await window.api.forward({
    from,
    to: { source: toSource, chatId: toChatId },
    comment: '',
  });
  if (!res.ok) {
    toast(`Не удалось переслать: ${res.error}`, true);
    return;
  }
  closeForward();
  if (toSource === 'telegram' && res.message) appendMessage(res.message);
  toast('Сообщение переслано');
}

/* ---------------------------------------------------- эмодзи и стикеры */

const EMOJI_SETS = [
  {
    name: 'Смайлы',
    list: [
      '😀 улыбка радость смех', '😃 улыбка радость', '😄 смех радость',
      '😁 ухмылка улыбка', '😆 смех хаха', '😅 нервный смех пот',
      '😂 слёзы смех лол', '🤣 катаюсь смех лол', '😊 улыбка смущение',
      '😇 ангел нимб', '🙂 улыбка', '🙃 перевёрнутый',
      '😉 подмигивание', '😌 спокойствие облегчение', '😍 влюблён сердечки',
      '🥰 влюблён сердечки', '😘 поцелуй', '😗 поцелуй',
      '😙 поцелуй', '😚 поцелуй', '😋 вкусно',
      '😛 язык', '😝 язык', '😜 подмигивание язык',
      '🤪 сумасшедший', '🤨 бровь скепсис', '🧐 монокль',
      '🤓 зануда очки', '😎 крутой очки', '🤩 звёзды восторг',
      '🥳 вечеринка праздник', '😏 ухмылка', '😒 недовольство',
      '😞 грусть', '😔 грусть печаль', '😟 беспокойство',
      '😕 смущение', '🙁 грусть', '☹️ грусть',
      '😣 терпение', '😖 мучение', '😫 усталость',
      '😩 усталость', '🥺 умоляющие глаза', '😢 слёзы грусть',
      '😭 плач слёзы', '😤 гордость пар', '😠 злость',
      '😡 злость ярость', '🤬 ругань мат', '🤯 взрыв мозга',
      '😳 шок смущение', '🥵 жарко', '🥶 холодно',
      '😱 крик страх', '😨 страх', '😰 тревога пот',
      '😥 грусть пот', '😓 пот', '🤗 объятия',
      '🤔 размышление думать', '🤭 хихиканье', '🤫 тихо секрет',
      '🤥 врун', '😶 молчание', '😐 нейтрально',
      '😑 нейтрально', '😬 гримаса', '🙄 закатил глаза',
      '😯 удивление', '😦 удивление', '😧 удивление',
      '😮 удивление', '😲 шок', '🥱 зевота скучно',
      '😴 сон', '🤤 слюни', '😪 сон',
      '😵 голова кругом', '🤐 молния рот', '🥴 пьяный',
      '🤢 тошнит', '🤮 рвота', '🤧 чихание',
      '😷 маска', '🤒 градусник болезнь', '🤕 бинт травма',
      '🤑 деньги рот', '🤠 ковбой', '😈 чёрт рога',
      '👿 чёрт злость', '👻 призрак', '💀 череп смерть',
      '☠️ череп кости', '👽 пришелец', '🤖 робот',
      '🎃 тыква хэллоуин', '😺 кот', '😸 кот',
      '😹 кот смех', '😻 кот влюблён', '😼 кот',
      '😽 кот поцелуй', '🙀 кот шок', '😿 кот слёзы',
      '😾 кот злость',
    ],
  },
  {
    name: 'Жесты',
    list: [
      '👋 привет пока машу', '🤚 рука', '🖐 рука пальцы',
      '✋ ладонь стоп', '🖖 вулкан', '👌 окей',
      '🤌 щепотка', '🤏 немного', '✌️ победа мир',
      '🤞 удача', '🤟 люблю', '🤘 рок',
      '🤙 позвони', '👈 влево', '👉 вправо',
      '👆 вверх', '👇 вниз', '☝️ указательный',
      '👍 лайк хорошо', '👎 дизлайк плохо', '✊ кулак',
      '👊 кулак удар', '🤛 кулак', '🤜 кулак',
      '👏 аплодисменты хлопки', '🙌 руки вверх ура', '👐 открытые руки',
      '🤲 ладони', '🤝 рукопожатие', '🙏 спасибо молиться',
      '✍️ пишу', '💅 маникюр', '🤳 селфи',
      '💪 мышцы сила', '🦾 протез', '🦿 нога',
      '🦵 нога', '🦶 ступня', '👂 ухо',
      '🦻 слуховой аппарат', '👃 нос', '🧠 мозг',
      '🫀 сердце', '🫁 лёгкие', '🦷 зуб',
      '🦴 кость', '👀 глаза смотреть', '👁 глаз',
      '👅 язык', '👄 губы',
    ],
  },
  {
    name: 'Люди',
    list: [
      '👶 ребёнок', '🧒 ребёнок', '👦 мальчик',
      '👧 девочка', '🧑 человек', '👨 мужчина',
      '👩 женщина', '🧓 пожилой', '👴 дед',
      '👵 бабушка', '🙍 грустный', '🙎 надулся',
      '🙅 нет нельзя', '🙆 окей', '💁 инфо',
      '🙋 поднял руку', '🧏 глухой', '🙇 кланяюсь',
      '🤦 фейспалм', '🤷 пожимаю плечами', '👮 полицейский',
      '🕵️ детектив', '💂 гвардеец', '🥷 ниндзя',
      '👷 строитель', '🤴 принц', '👸 принцесса',
      '👳 тюрбан', '👲 кепка', '🧕 платок',
      '🤵 смокинг', '👰 невеста', '🤰 беременная',
      '🤱 кормление', '👼 ангел', '🎅 дед мороз',
      '🤶 снегурочка', '🦸 супергерой', '🦹 злодей',
      '🧙 маг', '🧚 фея', '🧛 вампир',
      '🧜 русалка', '🧝 эльф', '🧞 джинн',
      '🧟 зомби', '💆 массаж', '💇 стрижка',
      '🚶 иду', '🧍 стою', '🧎 на коленях',
      '🏃 бегу', '💃 танцую', '🕺 танцую',
    ],
  },
  {
    name: 'Животные и природа',
    list: [
      '🐶 собака', '🐱 кошка', '🐭 мышь',
      '🐹 хомяк', '🐰 кролик', '🦊 лиса',
      '🐻 медведь', '🐼 панда', '🐨 коала',
      '🐯 тигр', '🦁 лев', '🐮 корова',
      '🐷 свинья', '🐸 жаба', '🐵 обезьяна',
      '🐔 курица', '🐧 пингвин', '🐦 птица',
      '🐤 цыплёнок', '🦆 утка', '🦅 орёл',
      '🦉 сова', '🦇 летучая мышь', '🐺 волк',
      '🐗 кабан', '🐴 лошадь', '🦄 единорог',
      '🐝 пчела', '🐛 гусеница', '🦋 бабочка',
      '🐌 улитка', '🐞 божья коровка', '🐜 муравей',
      '🕷 паук', '🦂 скорпион', '🐢 черепаха',
      '🐍 змея', '🦎 ящерица', '🐙 осьминог',
      '🦑 кальмар', '🦐 креветка', '🦀 краб',
      '🐡 рыба', '🐠 рыба', '🐟 рыба',
      '🐬 дельфин', '🐳 кит', '🦈 акула',
      '🐊 крокодил', '🐘 слон', '🦒 жираф',
      '🌵 кактус', '🌲 ёлка дерево', '🌳 дерево',
      '🌴 пальма', '🌱 росток', '🌿 трава',
      '☘️ клевер', '🍀 удача клевер', '🍁 лист',
      '🍂 листья', '🍃 листья', '🌷 тюльпан',
      '🌹 роза', '🌺 цветок', '🌸 сакура',
      '🌼 цветок', '🌻 подсолнух', '🌈 радуга',
      '⭐ звезда', '🌟 звезда', '✨ искры',
      '⚡ молния', '🔥 огонь', '❄️ снежинка',
      '☀️ солнце', '🌤 солнце', '⛅ облако',
      '☁️ облако', '🌧 дождь', '⛈ гроза',
      '🌩 гроза', '🌨 снег', '🌪 смерч',
      '🌊 волна', '💧 капля', '🌙 луна',
    ],
  },
  {
    name: 'Еда',
    list: [
      '🍏 яблоко', '🍎 яблоко', '🍐 груша',
      '🍊 апельсин', '🍋 лимон', '🍌 банан',
      '🍉 арбуз', '🍇 виноград', '🍓 клубника',
      '🫐 голубика', '🍈 дыня', '🍒 вишня',
      '🍑 персик', '🥭 манго', '🍍 ананас',
      '🥥 кокос', '🥝 киви', '🍅 помидор',
      '🥑 авокадо', '🍆 баклажан', '🥔 картошка',
      '🥕 морковь', '🌽 кукуруза', '🌶 перец',
      '🥒 огурец', '🥬 салат', '🥦 брокколи',
      '🧄 чеснок', '🧅 лук', '🍄 гриб',
      '🥜 орех', '🍞 хлеб', '🥐 круассан',
      '🥖 багет', '🥨 крендель', '🧀 сыр',
      '🥚 яйцо', '🍳 яичница', '🧇 вафля',
      '🥞 блины', '🥓 бекон', '🍔 бургер',
      '🍟 картошка фри', '🍕 пицца', '🌭 хот-дог',
      '🥪 сэндвич', '🌮 тако', '🌯 шаурма',
      '🥗 салат', '🍝 паста', '🍜 лапша',
      '🍲 суп', '🍛 рис', '🍣 суши',
      '🍱 бенто', '🥟 пельмени', '🍤 креветка',
      '🍙 онигири', '🍚 рис', '🍥 рыба',
      '🥠 печенье', '🍢 шашлык', '🍡 данго',
      '🍧 лёд', '🍨 мороженое', '🍦 мороженое',
      '🥧 пирог', '🎂 торт', '🍰 торт',
      '🧁 капкейк', '🍫 шоколад', '🍬 конфета',
      '🍭 леденец', '🍮 пудинг', '🍯 мёд',
      '🍼 бутылочка', '🥛 молоко', '☕ кофе',
      '🍵 чай', '🧋 бабл ти', '🥤 напиток',
      '🍺 пиво', '🍻 пиво', '🥂 шампанское',
      '🍷 вино', '🥃 виски', '🍸 коктейль',
    ],
  },
  {
    name: 'Активности',
    list: [
      '⚽ футбол', '🏀 баскетбол', '🏈 американский футбол',
      '⚾ бейсбол', '🎾 теннис', '🏐 волейбол',
      '🏉 регби', '🎱 бильярд', '🏓 пинг-понг',
      '🏸 бадминтон', '🥊 бокс', '🥋 карате',
      '⛳ гольф', '🏹 лук стрельба', '🎣 рыбалка',
      '🤿 дайвинг', '🎿 лыжи', '🛷 сани',
      '⛸ коньки', '🥌 кёрлинг', '🏂 сноуборд',
      '🏋️ тяжёлая атлетика', '🤸 гимнастика', '🤺 фехтование',
      '🤾 гандбол', '🏌️ гольф', '🏇 конный спорт',
      '🧘 йога медитация', '🏄 сёрфинг', '🏊 плавание',
      '🚴 велосипед', '🚵 велосипед', '🎮 геймпад игры',
      '🕹 джойстик', '🎲 кубик', '♟ шахматы',
      '🧩 пазл', '🎯 дартс цель', '🎳 боулинг',
      '🎨 рисование', '🎭 театр', '🎬 кино',
      '🎤 микрофон караоке', '🎧 наушники музыка', '🎼 ноты',
      '🎹 пианино', '🥁 барабан', '🎷 саксофон',
      '🎺 труба', '🎸 гитара', '🎻 скрипка',
      '🎪 цирк', '🎟 билет', '🎫 билет',
      '🏆 кубок победа', '🥇 золото первое', '🥈 серебро',
      '🥉 бронза', '🏅 медаль', '🎖 медаль',
      '🎗 лента', '🎯 цель',
    ],
  },
  {
    name: 'Предметы',
    list: [
      '⌚ часы', '📱 телефон', '💻 ноутбук',
      '⌨️ клавиатура', '🖥 компьютер', '🖨 принтер',
      '🖱 мышь', '🖲 трекбол', '💽 диск',
      '💾 дискета', '💿 диск', '📀 диск',
      '📷 камера фото', '📸 камера', '📹 видео',
      '🎥 камера', '📼 кассета', '🔍 лупа',
      '🔎 лупа', '🕯 свеча', '💡 лампочка идея',
      '🔦 фонарик', '🏮 фонарь', '🪔 лампа',
      '📔 книга', '📕 книга', '📖 книга',
      '📗 книга', '📘 книга', '📙 книга',
      '📚 книги', '📓 тетрадь', '📒 тетрадь',
      '📝 заметка', '📄 документ', '📃 документ',
      '📑 закладки', '📊 график', '📈 график вверх',
      '📉 график вниз', '🗒 блокнот', '🗓 календарь',
      '📆 календарь', '📅 календарь', '📇 картотека',
      '🗃 ящик', '🗳 урна', '🗄 шкаф',
      '📋 планшет', '📁 папка', '📂 папка',
      '🗂 папки', '🗞 газета', '📰 газета',
      '📦 коробка посылка', '📫 почта', '📪 почта',
      '✉️ письмо', '📧 email', '📨 письмо',
      '📩 письмо', '📤 отправить', '📥 получить',
      '🔑 ключ', '🗝 ключ', '🔒 замок закрыто',
      '🔓 замок открыто', '🔐 замок', '💰 деньги мешок',
      '💵 деньги', '💴 деньги', '💶 деньги',
      '💷 деньги', '💳 карта', '🧾 чек',
      '💎 алмаз', '⚖️ весы', '🔧 гаечный ключ',
      '🔨 молоток', '⚒ инструменты', '🛠 инструменты',
      '⛏ кирка', '🔩 болт', '⚙️ шестерёнка',
      '🧱 кирпич', '⛓ цепь', '🧲 магнит',
      '🔫 пистолет', '💣 бомба', '🧨 динамит',
      '🔪 нож', '🗡 меч', '⚔️ мечи',
      '🛡 щит', '🚬 сигарета', '⚰️ гроб',
      '🪦 надгробие', '🏺 амфора',
    ],
  },
  {
    name: 'Символы',
    list: [
      '❤️ сердце красное', '🧡 сердце оранжевое', '💛 сердце жёлтое',
      '💚 сердце зелёное', '💙 сердце синее', '💜 сердце фиолетовое',
      '🖤 сердце чёрное', '🤍 сердце белое', '🤎 сердце коричневое',
      '💔 разбитое сердце', '❣️ сердце', '💕 два сердца',
      '💞 сердца', '💓 сердце', '💗 сердце',
      '💖 сердце', '💘 сердце стрела', '💝 сердце',
      '💟 сердце', '☮️ мир', '✝️ крест',
      '☪️ ислам', '🕉 ом', '☸️ колесо',
      '✡️ звезда давида', '🔯 звезда', '🕎 менора',
      '☯️ инь ян', '☦️ крест', '🛐 религия',
      '⛎ змееносец', '♈ овен', '♉ телец',
      '♊ близнецы', '♋ рак', '♌ лев',
      '♍ дева', '♎ весы', '♏ скорпион',
      '♐ стрелец', '♑ козерог', '♒ водолей',
      '♓ рыбы', '🆔 id', '⚛️ атом',
      '☢️ радиация', '☣️ биологическая', '📴 выкл',
      '📳 вибрация', '📵 без телефона', '🔞 18+',
      '🔃 обновить', '🔄 обновить', '🔙 назад',
      '🔚 конец', '🔛 вкл', '🔜 скоро',
      '🔝 вверх', '✅ галочка да', '☑️ галочка',
      '✔️ галочка', '❌ крестик нет', '❎ крестик',
      '➕ плюс', '➖ минус', '➗ делить',
      '✖️ умножить', '♾ бесконечность', '💲 доллар',
      '💱 обмен', '™️ товарный знак', '©️ копирайт',
      '®️ зарегистрировано', '〰️ волна', '➰ петля',
      '➿ двойная петля', 'Ⓜ️ метро', '🅰️ а',
      '🆎 ab', '🅱️ б', '🆑 cl',
      '🆒 круто', '🆓 бесплатно', '🆕 новое',
      '🆖 ng', '🅾️ o', '🆗 окей',
      '🅿️ парковка', '🆘 sos помощь', '🆙 вверх',
      '🆚 против', '🔴 красный', '🟠 оранжевый',
      '🟡 жёлтый', '🟢 зелёный', '🔵 синий',
      '🟣 фиолетовый', '⚫ чёрный', '⚪ белый',
      '🟤 коричневый', '🔶 ромб', '🔷 ромб',
      '🔸 ромб', '🔹 ромб', '🔺 треугольник',
      '🔻 треугольник', '💠 ромб', '🔘 кнопка',
      '🔳 квадрат', '🔲 квадрат', '▪️ квадрат',
      '▫️ квадрат', '◾ квадрат', '◽ квадрат',
      '◼️ квадрат', '◻️ квадрат', '🟥 красный',
      '🟧 оранжевый', '🟨 жёлтый', '🟩 зелёный',
      '🟦 синий', '🟪 фиолетовый', '⬛ чёрный',
      '⬜ белый', '🟫 коричневый', '🔈 звук',
      '🔇 без звука', '🔊 громко', '🔉 тише',
      '🔔 звонок', '🔕 без звонка', '📢 громкоговоритель',
      '📣 рупор', '💬 сообщение', '💭 мысль',
      '🗯 реплика', '♠️ пики', '♣️ трефы',
      '♥️ черви', '♦️ бубны', '🃏 джокер',
      '🎴 карты', '🀄 маджонг', '🕐 час',
      '⏰ будильник', '⏳ песочные часы', '⌛ песочные часы',
      '⏱ секундомер', '⏲ таймер', '🕰 часы',
      '🌐 глобус', '🗺 карта', '🧭 компас',
    ],
  },
];

function composeSource() {
  return state.reply ? state.reply.source : state.active;
}

function togglePicker(force) {
  const el = $('picker');
  const show = force != null ? force : el.hidden;
  const wasBottom = state.atBottom || isAtBottom();
  el.hidden = !show;
  if (show) renderPicker();
  // Панель занимает место в разметке, поэтому лента сужается или растёт.
  // Держим её прижатой к низу, чтобы последние сообщения не скрывались
  // (как в Telegram), а после закрытия не оставался зазор.
  if (wasBottom) requestAnimationFrame(() => scrollToBottom(false));
}

function renderPicker() {
  const seg = state.picker.seg;
  document.querySelectorAll('#pickerSeg .picker-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.picker === seg);
  });
  const placeholders = {
    emoji: 'Поиск эмодзи…',
    sticker: 'Поиск стикеров…',
    gif: 'Поиск гифок (Enter)…',
  };
  $('pickerSearch').placeholder = placeholders[seg] || 'Поиск…';
  const body = $('pickerBody');
  body.replaceChildren();
  if (seg === 'emoji') renderEmojiGrid(body, $('pickerSearch').value);
  else if (seg === 'sticker') renderStickerGrid(body, $('pickerSearch').value);
  else renderGifPanel(body);
}

function pickerHint(text) {
  const d = document.createElement('div');
  d.className = 'picker-hint';
  d.textContent = text;
  return d;
}

function emojiOf(entry) {
  return String(entry).split(' ')[0];
}

function emojiButton(e) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'emoji-btn';
  b.textContent = e;
  b.addEventListener('click', () => insertEmoji(e));
  return b;
}

function renderEmojiGrid(box, query) {
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    const found = [];
    for (const cat of EMOJI_SETS) {
      for (const entry of cat.list) {
        if (String(entry).toLowerCase().includes(q)) found.push(emojiOf(entry));
      }
    }
    if (!found.length) {
      box.appendChild(pickerHint('Ничего не найдено'));
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';
    for (const e of found) grid.appendChild(emojiButton(e));
    box.appendChild(grid);
    return;
  }
  for (const cat of EMOJI_SETS) {
    const title = document.createElement('div');
    title.className = 'picker-cat';
    title.textContent = cat.name;
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';
    for (const entry of cat.list) grid.appendChild(emojiButton(emojiOf(entry)));
    box.append(title, grid);
  }
}

function insertEmoji(e) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + e + input.value.slice(end);
  const pos = start + e.length;
  try {
    input.setSelectionRange(pos, pos);
  } catch {}
  input.focus();
}

async function loadStickers(src) {
  if (Array.isArray(state.stickers[src])) return state.stickers[src];
  if (state.stickersLoading[src]) return state.stickersLoading[src];
  const p = window.api
    .stickersList(src)
    .then((res) => {
      state.stickersLoading[src] = null;
      const packs = res && res.ok ? res.packs : null;
      if (Array.isArray(packs)) {
        state.stickers[src] = packs;
        return state.stickers[src];
      }
      // Ошибку не кэшируем — панель сможет перезагрузиться при следующем открытии.
      return [];
    })
    .catch(() => {
      state.stickersLoading[src] = null;
      return [];
    });
  state.stickersLoading[src] = p;
  return p;
}

const stickerThumbCache = new Map();

// Превью стикеров грузим небольшими порциями: сразу 200 картинок — тяжело.
const stickerThumbQueue = [];
let stickerThumbActive = 0;
const STICKER_THUMB_LIMIT = 6;

function queueStickerThumb(id, cb) {
  stickerThumbQueue.push({ id, cb });
  pumpStickerThumbs();
}

function pumpStickerThumbs() {
  while (stickerThumbActive < STICKER_THUMB_LIMIT && stickerThumbQueue.length) {
    const job = stickerThumbQueue.shift();
    stickerThumbActive++;
    stickerThumbUrl(job.id)
      .then((res) => job.cb(res ? res.url : null, res ? res.mime : ''))
      .catch(() => job.cb(null, ''))
      .finally(() => {
        stickerThumbActive--;
        pumpStickerThumbs();
      });
  }
}

async function stickerThumbUrl(id) {
  const key = String(id);
  if (stickerThumbCache.has(key)) return stickerThumbCache.get(key);
  const res = await window.api.stickerThumb(key);
  const out = res && res.ok ? { url: bytesToBlobUrl(res.data, res.mime), mime: res.mime } : null;
  stickerThumbCache.set(key, out);
  return out;
}

async function renderStickerGrid(box, query) {
  const src = composeSource();
  box.appendChild(pickerHint('Загружаю стикеры…'));
  const packs = await loadStickers(src);
  if (!box.isConnected) return;
  box.replaceChildren();
  // Старые задачи больше не нужны — их плитки уже отключены от DOM.
  stickerThumbQueue.length = 0;

  if (!packs.length) {
    box.appendChild(
      pickerHint(
        src === 'telegram'
          ? 'Стикеры не найдены. Убедись, что Telegram подключён и есть добавленные наборы.'
          : 'Стикеры не найдены. Нужен доступ к серверам Discord.'
      )
    );
    return;
  }

  const q = String(query || '').trim().toLowerCase();

  // Поиск идёт по всем пакам сразу и показывается плоской сеткой.
  if (q) {
    const found = [];
    for (const p of packs) {
      for (const s of p.stickers || []) {
        if (`${s.name || ''} ${p.title || ''} ${s.emoji || ''}`.toLowerCase().includes(q)) {
          found.push(s);
        }
      }
    }
    if (!found.length) {
      box.appendChild(pickerHint('Ничего не найдено'));
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'sticker-grid';
    for (const s of found) grid.appendChild(stickerTile(src, s));
    box.appendChild(grid);
    return;
  }

  // Панель пака: полоска наборов сверху + сетка стикеров активного набора.
  const panel = document.createElement('div');
  panel.className = 'sticker-panel';

  const strip = document.createElement('div');
  strip.className = 'sticker-packs';

  // Колёсиком мыши прокручиваем полоску наборов по горизонтали.
  strip.addEventListener(
    'wheel',
    (e) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      e.preventDefault();
      strip.scrollLeft += delta;
    },
    { passive: false }
  );

  const grid = document.createElement('div');
  grid.className = 'sticker-grid';

  const select = (idx) => {
    const active = packs[idx];
    grid.replaceChildren();
    for (const s of active.stickers || []) grid.appendChild(stickerTile(src, s));
    strip
      .querySelectorAll('.sticker-pack')
      .forEach((el, i) => el.classList.toggle('active', i === idx));
  };

  packs.forEach((p, i) =>
    strip.appendChild(
      stickerPackTab(src, p, i, () => {
        if ((state.stickerPack[src] || 0) === i) return;
        state.stickerPack[src] = i;
        select(i);
      })
    )
  );

  const activeIdx = Math.min(state.stickerPack[src] || 0, packs.length - 1);
  state.stickerPack[src] = activeIdx;
  select(activeIdx);

  panel.append(strip, grid);
  box.appendChild(panel);
}

function stickerPackTab(src, pack, idx, onSelect) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sticker-pack';
  b.title = `${pack.title || 'Набор'}${pack.count ? ` · ${pack.count}` : ''}`;
  b.classList.toggle('active', (state.stickerPack[src] || 0) === idx);
  b.textContent = pack.emoji || '🎨';

  // Обложка пака — превью первого стикера набора.
  const cover = (pack.stickers || [])[0];
  if (cover) {
    queueStickerThumb(cover.id, (url, mime) => {
      if (!url || !b.isConnected) return;
      let node;
      if ((mime || '').startsWith('video/')) {
        node = document.createElement('video');
        node.src = url;
        node.muted = true;
        node.autoplay = true;
        node.loop = true;
        node.playsInline = true;
      } else {
        node = document.createElement('img');
        node.src = url;
        node.alt = '';
        node.decoding = 'async';
      }
      b.replaceChildren(node);
    });
  }

  b.addEventListener('click', onSelect);
  return b;
}

function stickerTile(src, s) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sticker-tile';
  b.title = s.name || s.setName || 'Стикер';
  // Пока превью не загрузилось, показываем эмодзи-заглушку.
  b.textContent = s.emoji || '🎨';

  const showImage = (url, mime) => {
    if (!url || !b.isConnected) return;
    let node;
    if ((mime || '').startsWith('video/')) {
      node = document.createElement('video');
      node.src = url;
      node.muted = true;
      node.autoplay = true;
      node.loop = true;
      node.playsInline = true;
    } else {
      node = document.createElement('img');
      node.src = url;
      node.alt = '';
      node.decoding = 'async';
    }
    b.replaceChildren(node);
  };

  if (s.url) {
    const img = document.createElement('img');
    img.src = s.url;
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', () => {
      if (b.isConnected) b.replaceChildren(img);
    });
    img.addEventListener('error', () => {});
  } else {
    queueStickerThumb(s.id, showImage);
  }

  b.addEventListener('click', () => sendSticker(src, s));
  return b;
}

async function sendSticker(src, sticker) {
  const chatId = state.reply && state.reply.source === src ? state.reply.chatId : state.chat[src];
  if (!chatId) {
    toast('Открой чат, чтобы отправить стикер', true);
    return;
  }
  if (!state.config?.[src]?.allowSend) {
    toast(`Отправка в ${LABELS[src]} выключена в настройках`, true);
    return;
  }
  const res = await window.api.stickerSend({ source: src, chatId, sticker });
  if (!res.ok) {
    toast(`Не удалось отправить стикер: ${res.error}`, true);
    return;
  }
  if (src === 'telegram' && res.message) appendMessage(res.message);
  toast('Стикер отправлен');
  togglePicker(false);
}

/* -------------------------------------------------------------------- гифки */

// Куда отправляем: чат открытого диалога или чат, выбранный для ответа.
function pickerTarget(src) {
  const chatId = state.reply && state.reply.source === src ? state.reply.chatId : state.chat[src];
  if (!chatId) {
    toast('Открой чат, чтобы отправить гифку', true);
    return null;
  }
  if (!state.config?.[src]?.allowSend) {
    toast(`Отправка в ${LABELS[src]} выключена в настройках`, true);
    return null;
  }
  return chatId;
}

function renderGifPanel(box) {
  const wrap = document.createElement('div');
  wrap.className = 'gif-panel';

  const actions = document.createElement('div');
  actions.className = 'gif-actions';

  const fileBtn = document.createElement('button');
  fileBtn.type = 'button';
  fileBtn.className = 'btn ghost gif-file';
  fileBtn.textContent = '📁 С ПК';
  fileBtn.title = 'Отправить гифку с компьютера';
  fileBtn.addEventListener('click', gifPickFile);

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'gif-url';
  urlInput.placeholder = 'Ссылка на гифку…';
  urlInput.autocomplete = 'off';
  urlInput.spellcheck = false;
  urlInput.value = state.picker.gifQuery || '';

  const urlBtn = document.createElement('button');
  urlBtn.type = 'button';
  urlBtn.className = 'btn gif-url-go';
  urlBtn.textContent = '→';
  urlBtn.title = 'Скачать и отправить по ссылке';
  urlBtn.addEventListener('click', () => gifSendUrl(urlInput.value));

  actions.append(fileBtn, urlInput, urlBtn);

  const results = document.createElement('div');
  results.className = 'gif-results';

  if (state.picker.gifResults === null) {
    results.appendChild(
      pickerHint('Введи запрос и нажми Enter. Можно вставить ссылку на гифку или выбрать файл с ПК.')
    );
  } else if (!state.picker.gifResults.length) {
    results.appendChild(pickerHint('Ничего не найдено. Попробуй другой запрос.'));
  } else {
    const grid = document.createElement('div');
    grid.className = 'gif-grid';
    for (const g of state.picker.gifResults) grid.appendChild(gifTile(g));
    results.appendChild(grid);
  }

  const attrib = document.createElement('div');
  attrib.className = 'gif-attrib';
  attrib.textContent = 'Поиск гифок: Openverse';

  wrap.append(actions, results, attrib);
  box.appendChild(wrap);
}

function gifTile(g) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'gif-tile';
  b.title = g.title || 'GIF';
  const img = document.createElement('img');
  img.src = g.preview || g.url;
  img.alt = g.title || '';
  img.loading = 'lazy';
  // Превью-прокси Openverse иногда не отвечает (Cloudflare) — тогда грузим саму гифку.
  img.addEventListener('error', () => {
    if (g.url && img.src !== g.url) img.src = g.url;
  });
  b.appendChild(img);
  b.addEventListener('click', () => gifSendUrl(g.url, g.title));
  return b;
}

async function gifSearch() {
  const q = $('pickerSearch').value.trim();
  state.picker.gifQuery = q;
  $('pickerBody').replaceChildren(pickerHint('Ищу гифки…'));
  const res = await window.api.gifSearch({ query: q, limit: 20 });
  if (!res.ok) {
    toast(`Поиск гифок: ${res.error}`, true);
    state.picker.gifResults = [];
  } else {
    state.picker.gifResults = res.results || [];
  }
  if (state.picker.seg === 'gif') renderPicker();
}

async function gifSendUrl(url, title) {
  const src = composeSource();
  const chatId = pickerTarget(src);
  if (!chatId) return;
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) {
    toast('Нужна ссылка http(s)', true);
    return;
  }
  state.picker.gifQuery = clean;
  toast('Скачиваю гифку…');
  const res = await window.api.mediaSendUrl({
    source: src,
    chatId,
    url: clean,
    comment: '',
  });
  if (!res.ok) {
    toast(`Не удалось отправить: ${res.error}`, true);
    return;
  }
  if (src === 'telegram' && res.message) appendMessage(res.message);
  toast('Гифка отправлена');
  togglePicker(false);
}

async function gifPickFile() {
  const src = composeSource();
  const chatId = pickerTarget(src);
  if (!chatId) return;
  const picked = await window.api.mediaPickFile();
  if (!picked || !picked.ok || !picked.path) return;
  toast('Отправляю файл…');
  const res = await window.api.mediaSendFile({ source: src, chatId, path: picked.path, comment: '' });
  if (!res.ok) {
    toast(`Не удалось отправить: ${res.error}`, true);
    return;
  }
  if (src === 'telegram' && res.message) appendMessage(res.message);
  toast('Гифка отправлена');
  togglePicker(false);
}

/* ------------------------------------------------------------- вложения */

// Кнопка «скрепка»: фото, документ, mp3, mp4 — как в обычных мессенджерах.
async function attachFile() {
  const src = composeSource();
  const chatId = pickerTarget(src);
  if (!chatId) return;

  const picked = await window.api.mediaPickFile({ any: true });
  if (!picked || !picked.ok || !picked.path) return;

  // Текст, набранный в поле, уходит подписью к файлу.
  const caption = input.value.trim();
  const replyId = state.reply && state.reply.source === src ? state.reply.msgId : null;

  toast('Отправляю файл…');
  const res = await window.api.mediaSendFile({
    source: src,
    chatId,
    path: picked.path,
    comment: caption,
    mode: 'file',
    msgId: replyId,
  });
  if (!res.ok) {
    toast(`Не удалось отправить: ${res.error}`, true);
    return;
  }
  if (caption) input.value = '';
  if (src === 'telegram' && res.message) appendMessage(res.message);
  clearReply();
  toast('Файл отправлен');
}

// Вставка изображения из буфера обмена (например, скриншот Win+Shift+S).
async function pasteImage(file) {
  const src = composeSource();
  const chatId = pickerTarget(src);
  if (!chatId) return;

  const caption = input.value.trim();
  const replyId = state.reply && state.reply.source === src ? state.reply.msgId : null;
  const filename = file.name || `Скриншот_${Date.now()}.png`;

  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    toast('Не удалось прочитать изображение из буфера', true);
    return;
  }

  toast('Отправляю изображение…');
  const res = await window.api.mediaSendBuffer({
    source: src,
    chatId,
    buffer: bytes,
    filename,
    comment: caption,
    msgId: replyId,
  });
  if (!res.ok) {
    toast(`Не удалось отправить: ${res.error}`, true);
    return;
  }
  if (caption) input.value = '';
  if (src === 'telegram' && res.message) appendMessage(res.message);
  clearReply();
  toast('Изображение отправлено');
}

/* --------------------------------------------------------------- настройки */

function setVal(el, value) {
  if (!el) return;
  if (document.activeElement === el) return;
  el.value = value;
}

// Список игнорируемых чатов в настройках (с возможностью вернуть чат).
function renderIgnored(src) {
  const box = $(src === 'telegram' ? 'ignoreListTelegram' : 'ignoreListDiscord');
  if (!box) return;
  const list = state.config?.[src]?.ignored || [];
  box.replaceChildren();

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'ignore-empty';
    empty.textContent = 'Пусто. ПКМ по чату → «Удалить чат и игнорировать».';
    box.appendChild(empty);
    return;
  }

  for (const entry of list) {
    const row = document.createElement('div');
    row.className = 'ignore-item';

    const name = document.createElement('span');
    name.className = 'ignore-name';
    name.textContent = entry.title || entry.id;
    name.title = entry.id;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ignore-undo';
    btn.textContent = 'Вернуть';
    btn.addEventListener('click', () => unignoreChat(src, entry));

    row.append(name, btn);
    box.appendChild(row);
  }
}

async function unignoreChat(src, entry) {
  const res = await window.api.chatUnignore({ source: src, chatId: entry.id });
  if (!res.ok) {
    toast(`Не удалось: ${res.error}`, true);
    return;
  }
  toast(`Чат «${entry.title || entry.id}» больше не игнорируется`);
}

function applyConfig(cfg) {
  state.config = cfg;

  // Discord
  setVal($('discordToken'), '');
  $('discordToken').placeholder = cfg.discord.token
    ? 'токен сохранён — введи новый, чтобы заменить'
    : 'Вставь токен';
  setVal($('watchDiscord'), (cfg.discord.watchUsers || []).join(', '));
  $('optDiscordShowOwn').checked = !!cfg.discord.showOwn;
  $('optDiscordSend').checked = !!cfg.discord.allowSend;

  // Telegram
  setVal($('tgApiId'), cfg.telegram.apiId || '');
  $('tgApiHash').placeholder = cfg.telegram.apiHash
    ? 'api_hash сохранён — введи новый, чтобы заменить'
    : '0123456789abcdef0123456789abcdef';
  setVal($('tgPhone'), cfg.telegram.phone || '');
  setVal($('tgProxy'), cfg.telegram.proxy || '');
  const builtinTg = cfg.telegram.useBuiltinApi !== false;
  $('optTgBuiltinApi').checked = builtinTg;
  $('tgApiId').disabled = builtinTg;
  $('tgApiHash').disabled = builtinTg;
  setVal($('watchTelegram'), (cfg.telegram.watchUsers || []).join(', '));
  $('optTelegramShowOwn').checked = !!cfg.telegram.showOwn;
  $('optTelegramSend').checked = !!cfg.telegram.allowSend;

  // общее
  $('optNotify').checked = !!cfg.notify;
  $('optSound').checked = !!cfg.sound;
  $('optTop').checked = !!cfg.alwaysOnTop;
  $('btnPin').classList.toggle('active', !!cfg.alwaysOnTop);
  $('btnSound').classList.toggle('active', !!cfg.sound);

  const opacity = Math.round((cfg.opacity ?? 1) * 100);
  $('opacityRange').value = opacity;
  $('opacityVal').textContent = `${opacity}%`;
  $('opacityRange').style.setProperty('--pct', `${((opacity - 35) / 65) * 100}%`);

  const font = cfg.fontSize || 14;
  $('fontRange').value = font;
  $('fontVal').textContent = `${font}px`;
  $('fontRange').style.setProperty('--pct', `${((font - 11) / 9) * 100}%`);
  document.documentElement.style.setProperty('--msg-font', `${font}px`);

  // Музыка
  if (cfg.music) {
    if (Array.isArray(cfg.music.items)) state.music.lib = cfg.music.items;
    if (typeof cfg.music.volume === 'number') {
      state.music.volume = Math.min(1, Math.max(0, cfg.music.volume));
      const audio = $('audio');
      if (audio) audio.volume = state.music.volume;
    }
    if (state.screen === 'music') renderMusic();
    repairBrokenTitles();
  }

  // Игнорируемые чаты
  renderIgnored('discord');
  renderIgnored('telegram');

  updateComposer();
}

async function patch(p) {
  const cfg = await window.api.setConfig(p);
  if (cfg) applyConfig(cfg);
}

function openSettings(open, source) {
  state.settingsOpen = open;
  settings.classList.toggle('open', open);
  settings.setAttribute('aria-hidden', String(!open));

  if (open) {
    setSettingsSource(source || state.active);
    $('settingsClose').focus();
  }
  updateNewChatBtn();
}

function setSettingsSource(src) {
  state.settingsSource = src;
  document.querySelectorAll('#settingsSeg .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.settingsSource === src);
  });
  $('blockDiscord').hidden = src !== 'discord';
  $('blockTelegram').hidden = src !== 'telegram';
}

function showTgPrompt(need) {
  state.tgPromptNeed = need;
  const box = $('tgPrompt');
  box.hidden = false;
  $('tgPromptTitle').textContent =
    need === 'password' ? 'Пароль двухфакторной аутентификации' : 'Код из Telegram';
  $('tgPromptHint').textContent =
    need === 'password'
      ? 'Пароль, который ты задал для двухфакторной защиты Telegram.'
      : 'Со встроенными данными Telegram шлёт код только в приложение Telegram — проверь телефон и другие устройства. Если код не приходит, войди по QR-коду.';
  const inp = $('tgPromptInput');
  inp.value = '';
  inp.type = need === 'password' ? 'password' : 'text';
  inp.placeholder = need === 'password' ? 'Пароль' : '12345';
  openSettings(true, 'telegram');
  setTimeout(() => inp.focus(), 250);
}

async function submitTgPrompt() {
  const inp = $('tgPromptInput');
  const value = inp.value.trim();
  if (!value) return;
  inp.value = '';
  $('tgPromptSubmit').disabled = true;
  await window.api.telegramSubmit(value);
  $('tgPromptSubmit').disabled = false;
}

// QR-код для входа в Telegram (альтернатива коду из приложения).
function showTgQr(url) {
  const box = $('tgQr');
  const img = $('tgQrImg');
  box.classList.remove('waiting');
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    img.src = qr.createDataURL(6, 8);
    img.hidden = false;
  } catch (e) {
    img.hidden = true;
    toast(`Не удалось построить QR-код: ${e.message}`, true);
  }
  box.hidden = false;
  $('tgPrompt').hidden = true;
  openSettings(true, 'telegram');
}

function hideTgQr() {
  const box = $('tgQr');
  if (!box) return;
  box.hidden = true;
  box.classList.remove('waiting');
  $('tgQrImg').hidden = true;
  $('tgQrImg').removeAttribute('src');
}

/* ------------------------------------------------------------------ музыка */

function musicFmt(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

function musicIsUrl(text) {
  return /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(String(text || ''));
}

function musicItems() {
  if (state.music.view === 'search') return state.music.results;
  if (state.music.view === 'reco') return state.music.reco.songs;
  return state.music.lib;
}

function musicInLib(id) {
  return state.music.lib.some((it) => it.id === id);
}

function musicThumb(id) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
}

function saveMusic() {
  return window.api
    .setConfig({ music: { volume: state.music.volume, items: state.music.lib } })
    .then((cfg) => {
      if (cfg) state.config = cfg;
    })
    .catch(() => {});
}

// Починка старых названий, сохранённых до исправления кодировки (в них «?»).
let titlesRepairStarted = false;
async function repairBrokenTitles() {
  if (titlesRepairStarted) return;
  const broken = state.music.lib.filter((it) => /\uFFFD/.test(String(it.title || '')));
  if (!broken.length) return;
  titlesRepairStarted = true;
  try {
    const res = await window.api.musicRepair(broken.map((it) => it.id));
    if (!res || !res.ok || !Array.isArray(res.items) || !res.items.length) {
      titlesRepairStarted = false;
      return;
    }
    const byId = new Map(res.items.map((it) => [it.id, it]));
    let changed = false;
    for (const item of state.music.lib) {
      const fix = byId.get(item.id);
      if (fix && fix.title && !/\uFFFD/.test(fix.title)) {
        item.title = fix.title;
        if (fix.uploader) item.uploader = fix.uploader;
        if (fix.duration) item.duration = fix.duration;
        changed = true;
      }
    }
    if (changed) {
      await saveMusic();
      if (state.screen === 'music') renderMusic();
    }
  } catch {
    titlesRepairStarted = false;
  }
}

function musicHint(html) {
  const div = document.createElement('div');
  div.className = 'music-hint';
  div.innerHTML = html;
  return div;
}

function renderMusicList() {
  const box = $('musicList');
  box.replaceChildren();

  if (state.music.view === 'reco') {
    renderReco(box);
    return;
  }

  const items = musicItems();
  if (!items.length) {
    if (state.music.view === 'search') {
      box.appendChild(
        musicHint(
          'Введи название в строке сверху и нажми <b>Найти</b>.<br>Или вставь ссылку на видео, плейлист или длинный микс.'
        )
      );
    } else {
      box.appendChild(
        musicHint(
          'Тут пусто.<br>Вставь ссылку YouTube или найди трек — и нажми <b>＋</b>, чтобы сохранить.'
        )
      );
    }
    return;
  }

  for (const item of items) {
    box.appendChild(musicRow(item, items));
  }
}

function renderReco(box) {
  const reco = state.music.reco;
  if (reco.loading && !reco.songs.length && !reco.playlists.length) {
    box.appendChild(musicHint('Подбираю рекомендации…'));
    return;
  }
  if (reco.error && !reco.songs.length) {
    box.appendChild(musicHint(`Не удалось загрузить рекомендации: ${escapeHtml(reco.error)}`));
    return;
  }
  if (!reco.songs.length && !reco.playlists.length) {
    box.appendChild(musicHint('Рекомендации появятся, когда будет интернет.'));
    return;
  }

  if (reco.playlists.length) {
    box.appendChild(sectionTitle('Плейлисты'));
    const wrap = document.createElement('div');
    wrap.className = 'music-pl-grid';
    for (const pl of reco.playlists) wrap.appendChild(playlistCard(pl));
    box.appendChild(wrap);
  }

  if (reco.songs.length) {
    box.appendChild(sectionTitle('Популярные песни'));
    for (const item of reco.songs) box.appendChild(musicRow(item, reco.songs));
  }
}

function sectionTitle(text) {
  const el = document.createElement('div');
  el.className = 'music-section';
  el.textContent = text;
  return el;
}

function playlistCard(pl) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'music-pl';
  card.title = pl.title;

  const cover = document.createElement('div');
  cover.className = 'music-pl-cover';
  cover.textContent = '≣';

  const name = document.createElement('div');
  name.className = 'music-pl-title';
  name.textContent = pl.title;

  card.append(cover, name);
  card.addEventListener('click', () => openPlaylist(pl));
  return card;
}

async function openPlaylist(pl) {
  if (state.music.busy) return;
  state.music.busy = true;
  renderMusicBar();
  const res = await window.api.musicResolve(`https://www.youtube.com/playlist?list=${pl.id}`);
  state.music.busy = false;
  renderMusicBar();
  if (!res.ok || !(res.items || []).length) {
    toast(`Не удалось открыть плейлист: ${res.error || 'пусто'}`, true);
    return;
  }
  const items = res.items;
  let added = 0;
  for (const it of items) {
    if (!musicInLib(it.id)) {
      state.music.lib.push({ ...it, addedAt: Date.now() });
      added += 1;
    }
  }
  saveMusic();
  state.music.view = 'lib';
  renderMusic();
  playItem(items[0], items);
  toast(`Плейлист «${pl.title}»: добавлено ${added} из ${items.length}`);
}

async function loadReco(force = false) {
  const reco = state.music.reco;
  if (reco.loading) return;
  if (reco.loaded && !force) return;
  reco.loading = true;
  reco.error = '';
  if (state.music.view === 'reco') renderMusicList();
  try {
    const seed = state.music.current?.id || '';
    const res = await window.api.musicRecommend(seed);
    if (res && res.ok) {
      reco.songs = res.songs || [];
      reco.playlists = res.playlists || [];
      reco.loaded = true;
    } else {
      reco.error = (res && res.error) || 'неизвестная ошибка';
    }
  } catch (e) {
    reco.error = e.message;
  }
  reco.loading = false;
  if (state.music.view === 'reco') renderMusicList();
}

function musicRow(item, list) {
  const row = document.createElement('div');
  row.className = 'music-item';
  if (state.music.current && state.music.current.id === item.id) {
    row.classList.add('current');
  }
  row.dataset.id = item.id;

  const img = document.createElement('img');
  img.className = 'music-thumb';
  img.alt = '';
  img.loading = 'lazy';
  img.src = musicThumb(item.id);
  img.addEventListener('error', () => {
    img.remove();
  });

  const main = document.createElement('div');
  main.className = 'music-item-main';
  const title = document.createElement('div');
  title.className = 'music-item-title';
  title.textContent = item.title;
  const sub = document.createElement('div');
  sub.className = 'music-item-sub';
  const bits = [];
  if (item.uploader) bits.push(item.uploader);
  bits.push(item.live ? '🔴 прямой эфир' : musicFmt(item.duration));
  sub.textContent = bits.join(' · ');
  main.append(title, sub);

  const act = document.createElement('button');
  act.type = 'button';
  act.className = 'music-item-act' + (musicInLib(item.id) ? ' on' : '');
  act.textContent = musicInLib(item.id) ? '★' : '＋';
  act.title = musicInLib(item.id) ? 'Убрать из «Моей музыки»' : 'Сохранить в «Мою музыку»';
  act.addEventListener('click', (e) => {
    e.stopPropagation();
    if (musicInLib(item.id)) removeFromLib(item.id);
    else addToLib(item);
  });

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'music-item-act';
  play.textContent = '▶';
  play.title = 'Играть';
  play.addEventListener('click', (e) => {
    e.stopPropagation();
    playItem(item, list);
  });

  row.append(img, main, act, play);
  row.addEventListener('click', () => playItem(item, list));
  return row;
}

function addToLib(item) {
  if (musicInLib(item.id)) return;
  state.music.lib.push({
    id: item.id,
    title: item.title,
    uploader: item.uploader || '',
    duration: item.duration || 0,
    live: !!item.live,
    addedAt: Date.now(),
  });
  saveMusic();
  renderMusicList();
  toast('Сохранено в «Мою музыку»');
}

function removeFromLib(id) {
  state.music.lib = state.music.lib.filter((it) => it.id !== id);
  saveMusic();
  renderMusicList();
}

function renderMusicBar() {
  const bar = $('musicBar');
  const cur = state.music.current;
  if (!cur) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const cover = $('musicCover');
  if (cover) {
    cover.hidden = false;
    cover.src = musicThumb(cur.id);
    cover.onerror = () => {
      cover.hidden = true;
    };
  }

  $('musicTitle').textContent = cur.title;
  $('musicSub').textContent = [cur.uploader, cur.live ? 'прямой эфир' : musicFmt(cur.duration)]
    .filter(Boolean)
    .join(' · ');

  const audio = $('audio');
  const playing = state.music.mode === 'audio' ? !audio.paused : false;
  const icon = $('musicPlayIcon');
  if (icon) {
    icon.firstElementChild.setAttribute(
      'd',
      playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z'
    );
  }

  $('musicMode').textContent =
    state.music.busy
      ? 'Загружаю…'
      : state.music.mode === 'player'
        ? 'Плеер YouTube'
        : 'Без рекламы';

  $('musicVol').value = Math.round(state.music.volume * 100);
  $('musicVol').style.setProperty('--vol', `${Math.round(state.music.volume * 100)}%`);

  updateMusicSeek();
}

function updateMusicSeek() {
  const seek = $('musicSeek');
  const time = $('musicTime');
  const audio = $('audio');

  if (state.music.mode === 'player') {
    seek.value = 0;
    seek.style.setProperty('--seek', '0%');
    time.textContent = 'YouTube';
    return;
  }

  const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
  const pos = audio.currentTime || 0;
  seek.value = dur ? Math.round((pos / dur) * 1000) : 0;
  seek.style.setProperty('--seek', dur ? `${(pos / dur) * 100}%` : '0%');
  time.textContent = dur ? `${musicFmt(pos)} / ${musicFmt(dur)}` : musicFmt(pos);
}

async function startAudio(item) {
  const audio = $('audio');
  state.music.mode = 'audio';
  hideStage();

  if (item.live) {
    startStage(item);
    return;
  }

  state.music.busy = true;
  renderMusicBar();

  const res = await window.api.musicStream(item.id);
  state.music.busy = false;

  if (!state.music.current || state.music.current.id !== item.id) return;

  if (!res.ok || !res.url || /\.m3u8|manifest\/hls/i.test(res.url)) {
    startStage(item);
    return;
  }

  audio.src = res.url;
  audio.volume = state.music.volume;
  try {
    await audio.play();
  } catch {
    startStage(item);
    return;
  }
  renderMusicBar();
}

function startStage(item) {
  const audio = $('audio');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  state.music.mode = 'player';
  const stage = $('musicStage');
  stage.hidden = false;
  $('musicFrame').src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(
    item.id
  )}?autoplay=1&rel=0`;
  renderMusicBar();
  renderMusicList();
}

function hideStage() {
  const stage = $('musicStage');
  if (!stage.hidden) {
    stage.hidden = true;
    $('musicFrame').src = 'about:blank';
  }
}

function playItem(item, list) {
  if (!item) return;
  const queue = (list && list.length ? list : musicItems()).map((it) => ({ ...it }));
  state.music.queue = queue;
  state.music.index = queue.findIndex((it) => it.id === item.id);
  state.music.current = queue[state.music.index] || item;
  startAudio(state.music.current);
  renderMusicList();
  renderMusicBar();
}

function musicStep(delta) {
  const q = state.music.queue;
  if (!q.length) return;
  let i = state.music.index + delta;
  if (i < 0) i = 0;
  if (i >= q.length) {
    i = q.length - 1;
    if (delta > 0) {
      // конец очереди — останавливаемся
      const audio = $('audio');
      if (state.music.mode === 'audio') audio.pause();
      renderMusicBar();
      return;
    }
  }
  state.music.index = i;
  state.music.current = q[i];
  startAudio(state.music.current);
  renderMusicList();
  renderMusicBar();
}

function musicToggle() {
  const audio = $('audio');
  if (state.music.mode === 'player') {
    toast('В режиме плеера YouTube управление — на самом видео');
    return;
  }
  if (!state.music.current) {
    const items = musicItems();
    if (items.length) playItem(items[0], items);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

async function musicSubmit() {
  const q = $('musicQuery').value.trim();
  if (!q) return;
  if (state.music.busy) return;

  if (musicIsUrl(q)) {
    state.music.busy = true;
    renderMusicBar();
    const res = await window.api.musicResolve(q);
    state.music.busy = false;
    if (!res.ok) {
      toast(`Не удалось: ${res.error}`, true);
      renderMusicBar();
      return;
    }
    const items = res.items || [];
    let added = 0;
    for (const it of items) {
      if (!musicInLib(it.id)) {
        state.music.lib.push({ ...it, addedAt: Date.now() });
        added += 1;
      }
    }
    saveMusic();
    state.music.view = 'lib';
    $('musicQuery').value = '';
    renderMusic();
    if (items.length) playItem(items[0], items);
    toast(
      items.length > 1
        ? `Плейлист: добавлено ${added} из ${items.length}`
        : added
          ? 'Добавлено в «Мою музыку»'
          : 'Уже в «Моей музыке»'
    );
    return;
  }

  state.music.busy = true;
  renderMusicBar();
  const res = await window.api.musicSearch(q);
  state.music.busy = false;
  if (!res.ok) {
    toast(`Поиск не удался: ${res.error}`, true);
    renderMusicBar();
    return;
  }
  state.music.results = res.items || [];
  state.music.view = 'search';
  renderMusic();
  if (!state.music.results.length) toast('Ничего не нашлось', true);
}

function renderMusic() {
  document.querySelectorAll('#musicSeg .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.musicView === state.music.view);
  });

  if (!state.music.ready && state.music.error) {
    $('musicList').replaceChildren(
      musicHint(`yt-dlp недоступен: ${escapeHtml(state.music.error)}<br>Проверь интернет и нажми «Обновить yt-dlp» в настройках.`)
    );
  } else {
    renderMusicList();
    if (state.music.view === 'reco') loadReco();
  }
  renderMusicBar();
}

function setScreen(screen) {
  if (screen === state.screen) {
    if (screen === 'music') renderMusic();
    return;
  }
  state.screen = screen;

  if (screen === 'music') {
    saveScroll();
    clearReply();
    clearEdit(true);
    togglePicker(false);
    closeLightbox();
    closeForward();
    closeMsgMenu();
    closeChatMenu();
    clearFlash();
    feed.hidden = true;
    $('music').hidden = false;
    $('chats').hidden = true;
    $('composer').hidden = true;
    $('chatHead').hidden = true;
    empty.hidden = true;
    $('scrollBtn').hidden = true;
    renderMusic();
  } else {
    $('music').hidden = true;
    hideStage();
    feed.hidden = false;
    if (state.view[state.active] === 'chat' && state.chat[state.active]) renderFeed();
    else renderChatList();
  }

  updateTabs();
  updateHeaderStatus();
}

/* ------------------------------------------------------------------ события */

function wireUi() {
  $('btnPin').addEventListener('click', () => patch({ alwaysOnTop: !state.config.alwaysOnTop }));
  $('btnSound').addEventListener('click', () => patch({ sound: !state.config.sound }));
  $('btnSettings').addEventListener('click', () => openSettings(true));
  $('settingsClose').addEventListener('click', () => openSettings(false));
  $('emptySettings').addEventListener('click', () => openSettings(true));
  $('btnMin').addEventListener('click', () => window.api.minimize());
  $('btnClose').addEventListener('click', () => window.api.close());

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const src = tab.dataset.source;
      if (src === 'music') {
        setScreen('music');
        return;
      }
      if (state.screen === 'music') {
        setScreen('messenger');
        if (src === state.active) return;
      }
      switchSource(src);
    });
  });

  $('chatBack').addEventListener('click', openChatList);

  // новый чат Discord
  $('newChatBtn').addEventListener('click', openNewChat);
  $('newChatClose').addEventListener('click', closeNewChat);
  $('newChatSearch').addEventListener('click', searchNewChat);
  $('newChatQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchNewChat();
    }
  });
  $('newChatOpenId').addEventListener('click', openNewChatById);
  $('newChatId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      openNewChatById();
    }
  });
  $('newChat').addEventListener('click', (e) => {
    if (e.target === $('newChat')) closeNewChat();
  });

  document.querySelectorAll('#settingsSeg .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setSettingsSource(btn.dataset.settingsSource));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('lightbox').hidden) closeLightbox();
      else if (chatMenu) closeChatMenu();
      else if (!$('forwardModal').hidden) closeForward();
      else if (!$('picker').hidden) togglePicker(false);
      else if (!$('newChat').hidden) closeNewChat();
      else if (state.editing) {
        clearEdit(true);
        toast('Редактирование отменено');
      } else if (state.settingsOpen) openSettings(false);
      else if (state.reply) clearReply();
      else if (state.screen === 'music') {
        if (!$('musicStage').hidden) hideStage();
        else setScreen('messenger');
      } else if (state.view[state.active] === 'chat') openChatList();
    }
  });

  feed.addEventListener('scroll', () => {
    if (state.view[state.active] !== 'chat') return;
    state.atBottom = isAtBottom();
    if (state.atBottom) {
      clearActiveUnread();
      updateScrollBtn();
      updateTabs();
    }
  });

  $('scrollBtn').addEventListener('click', () => scrollToBottom(true));

  // общее
  $('optNotify').addEventListener('change', (e) => patch({ notify: e.target.checked }));
  $('optSound').addEventListener('change', (e) => patch({ sound: e.target.checked }));
  $('optTop').addEventListener('change', (e) => patch({ alwaysOnTop: e.target.checked }));

  $('opacityRange').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('opacityVal').textContent = `${v}%`;
    e.target.style.setProperty('--pct', `${((v - 35) / 65) * 100}%`);
    window.api.setOpacity(v / 100);
  });
  $('opacityRange').addEventListener('change', (e) => patch({ opacity: Number(e.target.value) / 100 }));

  $('fontRange').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('fontVal').textContent = `${v}px`;
    e.target.style.setProperty('--pct', `${((v - 11) / 9) * 100}%`);
    document.documentElement.style.setProperty('--msg-font', `${v}px`);
  });
  $('fontRange').addEventListener('change', (e) => patch({ fontSize: Number(e.target.value) }));

  // Discord
  $('optDiscordShowOwn').addEventListener('change', (e) =>
    patch({ discord: { showOwn: e.target.checked } })
  );
  $('optDiscordSend').addEventListener('change', (e) =>
    patch({ discord: { allowSend: e.target.checked } })
  );

  let watchTimer = null;
  const bindWatch = (el, source) => {
    el.addEventListener('input', (e) => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        const list = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        patch({ [source]: { watchUsers: list } });
      }, 600);
    });
  };
  bindWatch($('watchDiscord'), 'discord');
  bindWatch($('watchTelegram'), 'telegram');

  $('tgProxy').addEventListener('change', (e) =>
    patch({ telegram: { proxy: e.target.value.trim() } })
  );

  $('btnDiscordConnect').addEventListener('click', async () => {
    const value = $('discordToken').value.trim();
    $('discordToken').value = '';
    await window.api.discordLogin(value);
    toast(value ? 'Подключаюсь к Discord…' : 'Переподключаюсь к Discord…');
  });

  $('btnDiscordLogout').addEventListener('click', async () => {
    await window.api.discordLogout();
    setStatus({ source: 'discord', state: 'disconnected', text: 'Не подключено' });
    toast('Вышел из Discord, токен удалён');
  });

  // Telegram
  $('optTelegramShowOwn').addEventListener('change', (e) =>
    patch({ telegram: { showOwn: e.target.checked } })
  );
  $('optTelegramSend').addEventListener('change', (e) =>
    patch({ telegram: { allowSend: e.target.checked } })
  );
  $('optTgBuiltinApi').addEventListener('change', (e) =>
    patch({ telegram: { useBuiltinApi: e.target.checked } })
  );

  const startTelegramLogin = async (mode) => {
    const builtin = $('optTgBuiltinApi').checked;
    const payload = {
      phone: $('tgPhone').value.trim(),
      proxy: $('tgProxy').value.trim(),
      mode,
    };
    if (!builtin) {
      payload.apiId = $('tgApiId').value.trim();
      payload.apiHash = $('tgApiHash').value.trim();
      if (!payload.apiId || !payload.apiHash) {
        toast('Заполни api_id и api_hash или включи встроенные данные', true);
        return;
      }
      if (payload.apiHash) $('tgApiHash').value = '';
    }
    if (mode === 'qr') {
      hideTgQr();
      $('tgQr').hidden = false;
      $('tgQrImg').hidden = true;
      $('tgQr').classList.add('waiting');
    }
    await window.api.telegramLogin(payload);
    toast(mode === 'qr' ? 'Готовлю QR-код…' : 'Подключаюсь к Telegram…');
  };

  $('btnTelegramLogin').addEventListener('click', () => startTelegramLogin('code'));
  $('btnTelegramQr').addEventListener('click', () => startTelegramLogin('qr'));

  $('tgQrCancel').addEventListener('click', async () => {
    hideTgQr();
    await window.api.telegramQrCancel();
    toast('Вход по QR-коду отменён');
  });

  $('btnTelegramLogout').addEventListener('click', async () => {
    await window.api.telegramLogout();
    setStatus({ source: 'telegram', state: 'disconnected', text: 'Telegram не подключён' });
    toast('Вышел из Telegram, сессия удалена');
  });

  $('tgPromptSubmit').addEventListener('click', submitTgPrompt);
  $('tgPromptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitTgPrompt();
    }
  });

  // тест / очистка / папка / переподключение
  $('btnTest').addEventListener('click', () => window.api.testMessage(state.active));

  $('btnClear').addEventListener('click', async () => {
    const src = state.active;
    if (!confirm(`Очистить историю ${LABELS[src]}?`)) return;
    await window.api.clearHistory(src);
    state.messages[src] = [];
    state.ids[src] = new Set();
    state.ctx[src] = newCtx();
    state.chatUnread[src] = {};
    state.extraChats[src] = {};
    state.unread[src] = 0;
    state.view[src] = 'list';
    state.chat[src] = null;
    state.scroll[src] = {};
    clearReply();
    renderChatList();
    updateTabs();
    toast('История очищена');
  });

  $('btnFolder').addEventListener('click', () => window.api.openDataFolder());

  $('btnYtdlp').addEventListener('click', async () => {
    toast('Обновляю yt-dlp…');
    const res = await window.api.musicUpdate();
    if (res.ok) {
      state.music.ready = true;
      state.music.error = '';
      updateTabs();
      toast('yt-dlp обновлён');
    } else {
      toast(`Обновление не удалось: ${res.error || 'неизвестная ошибка'}`, true);
    }
  });

  $('btnReload').addEventListener('click', async () => {
    if (state.settingsSource === 'telegram') {
      const builtin = $('optTgBuiltinApi').checked;
      const payload = {
        phone: $('tgPhone').value.trim() || undefined,
        proxy: $('tgProxy').value.trim(),
      };
      if (!builtin) {
        payload.apiId = $('tgApiId').value.trim() || undefined;
        payload.apiHash = $('tgApiHash').value.trim() || undefined;
      }
      await window.api.telegramLogin(payload);
      toast('Переподключаюсь к Telegram…');
    } else {
      await window.api.discordLogin('');
      toast('Переподключаюсь к Discord…');
    }
  });

  // отправка
  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content) return;

    // Режим редактирования своего сообщения.
    if (state.editing) {
      const ed = { ...state.editing };
      if (!state.config?.[ed.source]?.allowSend) {
        toast(`Редактирование в ${LABELS[ed.source]} выключено в настройках`, true);
        return;
      }
      if (content === ed.original) {
        input.value = '';
        clearEdit();
        return;
      }
      input.value = '';
      const res = await window.api.edit({
        source: ed.source,
        chatId: ed.chatId,
        msgId: ed.msgId,
        content,
      });
      if (!res.ok) {
        input.value = content;
        toast(`Не изменено: ${res.error}`, true);
        return;
      }
      applyEditedLocally(ed.source, ed.chatId, ed.msgId, res.message?.content ?? content);
      clearEdit();
      toast('Сообщение изменено');
      return;
    }

    // Либо ответ на выбранное сообщение, либо обычное сообщение в открытый чат.
    const src = state.reply ? state.reply.source : state.active;
    const chatId = state.reply ? state.reply.chatId : state.chat[src];
    if (!chatId) {
      toast('Открой чат или выбери сообщение для ответа', true);
      return;
    }
    if (!state.config?.[src]?.allowSend) {
      toast(`Отправка в ${LABELS[src]} выключена в настройках`, true);
      return;
    }

    input.value = '';
    const res = await window.api.send({
      source: src,
      chatId,
      msgId: state.reply ? state.reply.msgId : null,
      content,
    });
    if (!res.ok) {
      input.value = content;
      toast(`Не отправлено: ${res.error}`, true);
      return;
    }
    // Telegram не всегда дублирует собственное сообщение обратно в вебхук,
    // поэтому показываем отправленное сразу (appendMessage отсекает дубли по id).
    if (src === 'telegram' && res.message) appendMessage(res.message);
    clearReply();
  });

  $('replyCancel').addEventListener('click', clearReply);
  $('editCancel').addEventListener('click', () => {
    clearEdit(true);
    toast('Редактирование отменено');
  });

  // Вставка изображения из буфера обмена (скриншот Win+Shift+S) — вложением.
  $('composer').addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let file = null;
    for (const item of items) {
      if (item.kind === 'file' && (item.type || '').startsWith('image/')) {
        file = item.getAsFile();
        if (file) break;
      }
    }
    if (!file) return; // обычный текст вставляется как есть
    e.preventDefault();
    pasteImage(file);
  });

  // эмодзи и стикеры
  $('attachBtn').addEventListener('click', (e) => {
    e.preventDefault();
    attachFile();
  });
  $('emojiBtn').addEventListener('click', (e) => {
    e.preventDefault();
    togglePicker();
  });
  $('pickerClose').addEventListener('click', () => togglePicker(false));
  $('pickerSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.picker-seg-btn');
    if (!btn) return;
    const seg = btn.dataset.picker;
    state.picker.seg = seg === 'sticker' ? 'sticker' : seg === 'gif' ? 'gif' : 'emoji';
    renderPicker();
  });
  let pickerTimer = null;
  $('pickerSearch').addEventListener('input', () => {
    if (state.picker.seg === 'gif') return; // для гифок ищем по Enter
    clearTimeout(pickerTimer);
    pickerTimer = setTimeout(() => renderPicker(), 180);
  });
  $('pickerSearch').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (state.picker.seg === 'gif') gifSearch();
  });

  // пересылка
  $('forwardClose').addEventListener('click', closeForward);
  $('forwardQuery').addEventListener('input', () => renderForwardList($('forwardQuery').value));
  $('forwardTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.forward-tab');
    if (btn) setForwardTab(btn.dataset.src);
  });
  $('forwardModal').addEventListener('click', (e) => {
    if (e.target === $('forwardModal')) closeForward();
  });

  // просмотрщик медиа
  $('lightboxClose').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => {
    if (e.target === $('lightbox')) closeLightbox();
  });

  // контекстное меню сообщения и чата
  feed.addEventListener('contextmenu', (e) => {
    const chatEl = e.target.closest('.chat-item');
    if (chatEl) {
      const chat = getChat(state.active, chatEl.dataset.chat);
      if (!chat) return;
      e.preventDefault();
      openChatMenu(chat, e.clientX, e.clientY);
      return;
    }
    const el = e.target.closest('.msg');
    if (!el) return;
    const msg = findMessage(el);
    if (!msg) return;
    e.preventDefault();
    openMsgMenu(msg, el, e.clientX, e.clientY);
  });
  $('chatHead').addEventListener('contextmenu', (e) => {
    const src = state.active;
    const chat = getChat(src, state.chat[src]);
    if (!chat) return;
    e.preventDefault();
    openChatMenu(chat, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', (e) => {
    if (msgMenu && !msgMenu.contains(e.target)) closeMsgMenu();
    if (chatMenu && !chatMenu.contains(e.target)) closeChatMenu();
  });
  feed.addEventListener(
    'scroll',
    () => {
      closeMsgMenu();
      closeChatMenu();
    },
    { passive: true }
  );

  // музыка
  $('musicGo').addEventListener('click', musicSubmit);
  $('musicQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      musicSubmit();
    }
  });

  document.querySelectorAll('#musicSeg .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.music.view = btn.dataset.musicView;
      renderMusic();
    });
  });

  $('musicStageClose').addEventListener('click', () => {
    hideStage();
    state.music.mode = 'audio';
    renderMusicBar();
  });

  $('musicPrev').addEventListener('click', () => musicStep(-1));
  $('musicNext').addEventListener('click', () => musicStep(1));
  $('musicPlay').addEventListener('click', musicToggle);

  const audio = $('audio');
  audio.volume = state.music.volume;
  audio.addEventListener('play', renderMusicBar);
  audio.addEventListener('pause', renderMusicBar);
  audio.addEventListener('loadedmetadata', updateMusicSeek);
  audio.addEventListener('timeupdate', updateMusicSeek);
  audio.addEventListener('ended', () => musicStep(1));
  audio.addEventListener('error', () => {
    if (state.music.mode === 'audio' && state.music.current) startStage(state.music.current);
  });

  $('musicSeek').addEventListener('input', (e) => {
    if (state.music.mode === 'player') return;
    const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (!dur) return;
    audio.currentTime = (Number(e.target.value) / 1000) * dur;
    e.target.style.setProperty('--seek', `${(Number(e.target.value) / 10).toFixed(1)}%`);
  });

  $('musicVol').addEventListener('input', (e) => {
    state.music.volume = Number(e.target.value) / 100;
    audio.volume = state.music.volume;
    e.target.style.setProperty('--vol', `${e.target.value}%`);
  });
  $('musicVol').addEventListener('change', saveMusic);

  // события из main
  window.api.onStatus(setStatus);
  window.api.onMe(({ source, me }) => {
    state.accounts[source] = me;
  });
  window.api.onError(({ text }) => toast(text, true));
  window.api.onMessage(appendMessage);
  window.api.onConfig((cfg) => applyConfig(cfg));
  window.api.onTgAuth(({ need }) => showTgPrompt(need));
  window.api.onTgQr(({ url }) => showTgQr(url));
  window.api.onTgUserStatus(({ userId, status }) => {
    if (!userId) return;
    state.tgStatus[String(userId)] = status || null;
    applyStatuses([String(userId)]);
  });
  window.api.onMusicStatus((st) => {
    if (!st) return;
    state.music.ready = !!st.ready;
    state.music.error = st.error || '';
    updateTabs();
    if (state.screen === 'music') {
      updateHeaderStatus();
      renderMusic();
    }
  });
}

/* -------------------------------------------------------------------- старт */

async function init() {
  wireUi();

  const data = await window.api.getState();

  state.statuses = data.statuses || state.statuses;
  state.accounts = data.accounts || state.accounts;

  for (const src of SOURCES) {
    const list = Array.isArray(data.history?.[src]) ? data.history[src] : [];
    state.messages[src] = list;
    state.ids[src] = new Set();
    for (const msg of list) {
      if (!msg || !msg.id) continue;
      msg.source = msg.source || src;
      state.ids[src].add(msg.id);
    }
  }

  applyConfig(data.config);
  state.active = SOURCES.includes(data.config.activeSource)
    ? data.config.activeSource
    : 'discord';

  if (data.music) {
    state.music.ready = !!data.music.ready;
    state.music.error = data.music.error || '';
  }

  $('meta').textContent = `Версия ${data.version} · данные: ${data.configPath}`;

  updateTabs();
  updateHeaderStatus();
  updateComposer();
  renderChatList();
}

init();
