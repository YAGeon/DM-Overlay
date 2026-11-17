'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  Notification,
  globalShortcut,
  shell,
  screen,
  powerMonitor,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { DiscordClient } = require('./discord-client');
const { TgClient } = require('./telegram-client');
const music = require('./music');

// Имя приложения фиксируем явно: от него зависит папка данных
// (%APPDATA%\discord-dm-overlay). Оно должно совпадать у portable-сборки и у
// версии из установщика, иначе настройки и сессии потеряются.
app.setName('discord-dm-overlay');

const HISTORY_LIMIT = 300;
const SOURCES = ['discord', 'telegram'];

// Встроенные учётные данные официального клиента Telegram (Telegram Desktop).
// Позволяют войти без регистрации собственного приложения на my.telegram.org.
// Использование чужого api_id — нарушение правил Telegram (риск блокировки).
const BUILTIN_TG_API_ID = 2040;
const BUILTIN_TG_API_HASH = 'b18441a1ff607e10a989891a5462e627';

function telegramCreds(tg = config.telegram) {
  const builtin = tg.useBuiltinApi !== false;
  return {
    builtin,
    apiId: builtin ? BUILTIN_TG_API_ID : String(tg.apiId || '').trim(),
    apiHash: builtin ? BUILTIN_TG_API_HASH : String(tg.apiHash || '').trim(),
  };
}

const DEFAULT_CONFIG = {
  version: 2,
  activeSource: 'discord',
  alwaysOnTop: true,
  sound: true,
  notify: true,
  opacity: 1,
  fontSize: 14,
  window: { width: 390, height: 600, x: null, y: null },
  discord: { token: '', watchUsers: [], ignored: [], showOwn: true, allowSend: false },
  telegram: { apiId: '', apiHash: '', phone: '', session: '', proxy: '', useBuiltinApi: true, watchUsers: [], ignored: [], showOwn: true, allowSend: false },
  music: { volume: 0.8, items: [] },
};

let config = clone(DEFAULT_CONFIG);
let history = { discord: [], telegram: [] };
let win = null;
let tray = null;
let quitting = false;
let saveTimer = null;
let boundsTimer = null;

const statuses = {
  discord: { state: 'disconnected', text: 'Discord не подключён' },
  telegram: { state: 'disconnected', text: 'Telegram не подключён' },
};
const accounts = { discord: null, telegram: null };

const dataDir = app.getPath('userData');
const configPath = path.join(dataDir, 'config.json');
const historyPath = path.join(dataDir, 'history.json');
const mediaDir = path.join(app.getPath('temp'), 'dm-overlay');

const discord = new DiscordClient();
const telegram = new TgClient();

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// ------------------------------------------------------------------ storage

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Не удалось сохранить', file, e);
  }
}

function migrateConfig(saved) {
  const cfg = clone(DEFAULT_CONFIG);
  if (!saved || typeof saved !== 'object') return cfg;

  for (const key of ['activeSource', 'alwaysOnTop', 'sound', 'notify', 'opacity', 'fontSize']) {
    if (saved[key] !== undefined) cfg[key] = saved[key];
  }
  cfg.window = { ...cfg.window, ...(saved.window || {}) };

  if (saved.discord && typeof saved.discord === 'object') {
    cfg.discord = { ...cfg.discord, ...saved.discord };
  } else {
    // миграция старого формата: токен лежал в корне
    cfg.discord.token = saved.token || '';
    cfg.discord.watchUsers = Array.isArray(saved.watchUsers) ? saved.watchUsers : [];
    if (typeof saved.showOwn === 'boolean') cfg.discord.showOwn = saved.showOwn;
    if (typeof saved.allowSend === 'boolean') cfg.discord.allowSend = saved.allowSend;
  }
  cfg.discord.ignored = sanitizeIgnored(cfg.discord.ignored);

  if (saved.telegram && typeof saved.telegram === 'object') {
    cfg.telegram = { ...cfg.telegram, ...saved.telegram };
    if (typeof saved.telegram.useBuiltinApi !== 'boolean') cfg.telegram.useBuiltinApi = true;
  }
  cfg.telegram.ignored = sanitizeIgnored(cfg.telegram.ignored);

  if (saved.music && typeof saved.music === 'object') {
    cfg.music = {
      volume: typeof saved.music.volume === 'number' ? saved.music.volume : cfg.music.volume,
      items: sanitizeMusicItems(saved.music.items),
    };
  }

  if (!SOURCES.includes(cfg.activeSource)) cfg.activeSource = 'discord';
  return cfg;
}

function sanitizeMusicItems(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    if (!/^[\w-]{6,20}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const duration = Number(raw.duration);
    out.push({
      id,
      title: String(raw.title || 'Без названия').slice(0, 300),
      uploader: String(raw.uploader || '').slice(0, 160),
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
      live: !!raw.live,
      addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : Date.now(),
    });
    if (out.length >= 300) break;
  }
  return out;
}

function loadConfig() {
  config = migrateConfig(readJson(configPath, null));
}

// Игнорируемые чаты: [{ id, title }]. Они не появляются в оверлее.
function sanitizeIgnored(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const id = String(raw && typeof raw === 'object' ? raw.id : raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = String((raw && typeof raw === 'object' && raw.title) || '').slice(0, 120);
    out.push({ id, title });
    if (out.length >= 300) break;
  }
  return out;
}

function ignoredList(source) {
  return Array.isArray(config[source]?.ignored) ? config[source].ignored : [];
}

function isIgnored(source, chatId) {
  const id = String(chatId || '');
  if (!id) return false;
  return ignoredList(source).some((e) => String(e.id) === id);
}

// Убирает из истории все сообщения чата (только в оверлее).
function removeHistoryChannel(source, chatId) {
  const id = String(chatId || '');
  if (!id) return;
  history[source] = (history[source] || []).filter((m) => String(m.channelId) !== id);
  saveHistorySoon();
}

function removeHistoryMessage(source, chatId, msgId) {
  const ch = String(chatId || '');
  const mid = String(msgId || '');
  history[source] = (history[source] || []).filter(
    (m) => !(String(m.channelId) === ch && String(m.id) === mid)
  );
  saveHistorySoon();
}

function saveConfig() {
  writeJson(configPath, config);
}

function loadHistory() {
  const saved = readJson(historyPath, null);
  if (Array.isArray(saved)) {
    history = { discord: saved, telegram: [] };
  } else if (saved && typeof saved === 'object') {
    history = {
      discord: Array.isArray(saved.discord) ? saved.discord : [],
      telegram: Array.isArray(saved.telegram) ? saved.telegram : [],
    };
  } else {
    history = { discord: [], telegram: [] };
  }
  // Сообщения из игнорируемых чатов не показываем даже после перезапуска.
  for (const src of SOURCES) {
    history[src] = (history[src] || []).filter((m) => !isIgnored(src, m?.channelId));
  }
}

function saveHistorySoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(historyPath, history), 800);
}

// ------------------------------------------------------------------- window

function createWindow() {
  const w = clampBounds(config.window);

  win = new BrowserWindow({
    width: w.width,
    height: w.height,
    x: w.x,
    y: w.y,
    minWidth: 340,
    minHeight: 280,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: false,
    title: 'ЛС — Discord / Telegram',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    applyWindowOptions();
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('move', scheduleBoundsSave);
  win.on('resize', scheduleBoundsSave);
  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  setTimeout(() => {
    if (win && !win.isVisible()) win.show();
  }, 2500);
}

function clampBounds(b) {
  const bounds = {
    width: Math.max(340, Number(b.width) || 390),
    height: Math.max(280, Number(b.height) || 600),
    x: Number.isInteger(b.x) ? b.x : null,
    y: Number.isInteger(b.y) ? b.y : null,
  };
  if (bounds.x != null && bounds.y != null) {
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => {
      const a = d.workArea;
      return (
        bounds.x + bounds.width > a.x &&
        bounds.x < a.x + a.width &&
        bounds.y + bounds.height > a.y &&
        bounds.y < a.y + a.height
      );
    });
    if (!visible) {
      bounds.x = null;
      bounds.y = null;
    }
  }
  if (bounds.x == null || bounds.y == null) {
    const a = screen.getPrimaryDisplay().workArea;
    bounds.x = a.x + a.width - bounds.width - 24;
    bounds.y = a.y + 24;
  }
  return bounds;
}

function scheduleBoundsSave() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    config.window = { width: b.width, height: b.height, x: b.x, y: b.y };
    saveConfig();
  }, 500);
}

function applyWindowOptions() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(!!config.alwaysOnTop, 'screen-saver');
  win.setOpacity(config.opacity);
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

// --------------------------------------------------------------------- tray

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) image = image.resize({ width: 16, height: 16, quality: 'best' });
  else image = nativeImage.createEmpty();

  tray = new Tray(image);
  tray.setToolTip('ЛС — Discord / Telegram');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Показать / скрыть окно', click: toggleWindow },
      {
        label: 'Discord',
        submenu: [{ label: 'Переподключиться', click: () => loginDiscord() }],
      },
      {
        label: 'Telegram',
        submenu: [{ label: 'Переподключиться', click: () => loginTelegram({}, true) }],
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', toggleWindow);
}

// ------------------------------------------------------------------ дискорд

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setupDiscord() {
  discord.setWatch(config.discord.watchUsers, config.discord.showOwn);
  discord.allowSend = config.discord.allowSend;

  discord.on('status', (s) => {
    statuses.discord = s;
    sendToRenderer('status', { source: 'discord', ...s });
  });

  discord.on('me', (me) => {
    accounts.discord = me;
    config.discord.token = discord.token || config.discord.token;
    saveConfig();
    sendToRenderer('me', { source: 'discord', me });
  });

  discord.on('error', (text) => {
    sendToRenderer('error', { source: 'discord', text });
  });

  discord.on('message', (msg) => {
    handleMessage('discord', { ...msg, source: 'discord' });
  });
}

// ----------------------------------------------------------------- телеграм

function setupTelegram() {
  telegram.setWatch(config.telegram.watchUsers, config.telegram.showOwn);
  telegram.allowSend = config.telegram.allowSend;

  telegram.on('status', (s) => {
    statuses.telegram = s;
    sendToRenderer('status', { source: 'telegram', ...s });
  });

  telegram.on('me', (me) => {
    accounts.telegram = me;
    sendToRenderer('me', { source: 'telegram', me });
  });

  telegram.on('auth', (info) => {
    sendToRenderer('tg:auth', info);
  });

  telegram.on('qr', (info) => {
    sendToRenderer('tg:qr', info);
  });

  telegram.on('session', (session) => {
    config.telegram.session = session;
    saveConfig();
  });

  telegram.on('error', (text) => {
    sendToRenderer('error', { source: 'telegram', text });
  });

  telegram.on('message', (msg) => {
    handleMessage('telegram', msg);
  });

  // Онлайн-статусы собеседников (в сети / недавно / был(а) …).
  telegram.on('status:user', (info) => {
    sendToRenderer('tg:userStatus', info);
  });
}

// ------------------------------------------------------------------ сообщения

function handleMessage(source, msg) {
  if (!msg) return;
  // Игнорируемые чаты не попадают в оверлей вовсе.
  if (isIgnored(source, msg.channelId)) return;
  history[source].push(msg);
  if (history[source].length > HISTORY_LIMIT) {
    history[source] = history[source].slice(-HISTORY_LIMIT);
  }
  saveHistorySoon();
  sendToRenderer('message', msg);

  const hidden = !win || !win.isVisible() || !win.isFocused();
  const otherTab = config.activeSource !== source;
  if (config.notify && !msg.own && (hidden || otherTab)) {
    showSystemNotification(source, msg);
  }
}

// Записывает своё отправленное сообщение в историю (для пересылки/ответов),
// даже если платформа не прислала его обратно.
function recordSent(source, msg) {
  if (!msg || !msg.id) return;
  if (history[source].some((m) => String(m.id) === String(msg.id))) return;
  handleMessage(source, msg);
}

function sourceLabel(source) {
  return source === 'telegram' ? 'Telegram' : 'Discord';
}

function showSystemNotification(source, msg) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: `${sourceLabel(source)} · ${msg.author.globalName || msg.author.username}`,
    body: (msg.content || attachmentLabel(msg)).slice(0, 220),
    silent: true,
  });
  n.on('click', showWindow);
  n.show();
}

function attachmentLabel(msg) {
  if (!msg.attachments || !msg.attachments.length) return '';
  const a = msg.attachments[0];
  if (a.label) return `${a.kind === 'photo' ? '📷' : '📎'} ${a.label}`;
  if ((a.contentType || '').startsWith('image/')) return '📷 Изображение';
  if ((a.contentType || '').startsWith('video/')) return '🎬 Видео';
  if ((a.contentType || '').startsWith('audio/')) return '🎧 Аудио';
  return `📎 ${a.filename}`;
}

// ------------------------------------------------------------------- логины

function loginDiscord(token) {
  const t = String(token || config.discord.token || '').trim();
  if (!t) {
    sendToRenderer('error', { source: 'discord', text: 'Вставь токен Discord в настройках' });
    return;
  }
  discord.login(t);
}

async function loginTelegram(payload = {}, auto = false) {
  const next = {
    ...config.telegram,
  };
  if (payload.apiId !== undefined) next.apiId = String(payload.apiId).trim();
  if (payload.apiHash !== undefined) next.apiHash = String(payload.apiHash).trim();
  if (payload.phone !== undefined) next.phone = String(payload.phone).trim();
  if (payload.proxy !== undefined) next.proxy = String(payload.proxy).trim();

  config.telegram = { ...config.telegram, ...next };
  saveConfig();

  const creds = telegramCreds(config.telegram);
  if (!creds.apiId || !creds.apiHash) {
    statuses.telegram = { state: 'error', text: 'Укажи api_id и api_hash' };
    sendToRenderer('status', { source: 'telegram', ...statuses.telegram });
    return;
  }

  await telegram.login(
    { ...config.telegram, apiId: creds.apiId, apiHash: creds.apiHash },
    { auto, qr: payload.mode === 'qr' }
  );
}

// ---------------------------------------------------------------------- ipc

function applyConfig() {
  discord.setWatch(config.discord.watchUsers, config.discord.showOwn);
  discord.allowSend = config.discord.allowSend;
  telegram.setWatch(config.telegram.watchUsers, config.telegram.showOwn);
  telegram.allowSend = config.telegram.allowSend;
  applyWindowOptions();
}

function sanitizeList(value) {
  return Array.isArray(value)
    ? value.map((s) => String(s).trim()).filter(Boolean).slice(0, 50)
    : undefined;
}

function mergeConfigPatch(patch) {
  if (!patch || typeof patch !== 'object') return;

  if (SOURCES.includes(patch.activeSource)) config.activeSource = patch.activeSource;
  for (const key of ['alwaysOnTop', 'sound', 'notify']) {
    if (typeof patch[key] === 'boolean') config[key] = patch[key];
  }
  if (typeof patch.opacity === 'number') config.opacity = Math.min(1, Math.max(0.35, patch.opacity));
  if (typeof patch.fontSize === 'number') config.fontSize = Math.min(20, Math.max(11, patch.fontSize));

  const discordPatch = patch.discord || {};
  if (typeof discordPatch.showOwn === 'boolean') config.discord.showOwn = discordPatch.showOwn;
  if (typeof discordPatch.allowSend === 'boolean') config.discord.allowSend = discordPatch.allowSend;
  if (sanitizeList(discordPatch.watchUsers)) config.discord.watchUsers = sanitizeList(discordPatch.watchUsers);
  if (Array.isArray(discordPatch.ignored)) config.discord.ignored = sanitizeIgnored(discordPatch.ignored);
  if (typeof discordPatch.token === 'string' && !discordPatch.token.startsWith('•')) {
    config.discord.token = discordPatch.token.trim();
  }

  const tgPatch = patch.telegram || {};
  if (typeof tgPatch.showOwn === 'boolean') config.telegram.showOwn = tgPatch.showOwn;
  if (typeof tgPatch.allowSend === 'boolean') config.telegram.allowSend = tgPatch.allowSend;
  if (typeof tgPatch.useBuiltinApi === 'boolean') config.telegram.useBuiltinApi = tgPatch.useBuiltinApi;
  if (sanitizeList(tgPatch.watchUsers)) config.telegram.watchUsers = sanitizeList(tgPatch.watchUsers);
  if (Array.isArray(tgPatch.ignored)) config.telegram.ignored = sanitizeIgnored(tgPatch.ignored);
  for (const key of ['apiId', 'apiHash', 'phone', 'proxy']) {
    if (typeof tgPatch[key] === 'string') config.telegram[key] = tgPatch[key].trim();
  }

  const musicPatch = patch.music || {};
  if (typeof musicPatch.volume === 'number') {
    config.music.volume = Math.min(1, Math.max(0, musicPatch.volume));
  }
  if (Array.isArray(musicPatch.items)) {
    config.music.items = sanitizeMusicItems(musicPatch.items);
  }

  saveConfig();
  applyConfig();
}

// ---------------------------------------------------- гифки, ссылки и файлы

const MIME_EXT = {
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

function extForMime(mime, fallback = '') {
  const clean = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[clean] || fallback;
}

function filenameFromUrl(rawUrl, mime) {
  let name = '';
  try {
    name = decodeURIComponent(new URL(rawUrl).pathname.split('/').pop() || '');
  } catch {
    name = '';
  }
  name = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  if (!path.extname(name)) name = `${name || 'gif'}${extForMime(mime, '.gif')}`;
  return name;
}

// Поиск гифок через Openverse (openverse.org) — бесплатный открытый API без ключа.
// Каталог англоязычный, поэтому частые русские запросы переводим сами.
const GIF_RU_EN = {
  привет: 'hello', пока: 'bye', спасибо: 'thank you', пожалуйста: 'please',
  да: 'yes', нет: 'no', ок: 'ok', хорошо: 'good', плохо: 'bad',
  любовь: 'love', сердце: 'heart', поцелуй: 'kiss', обнимаю: 'hug', обнять: 'hug',
  смех: 'laugh', смешно: 'funny', ржу: 'laughing', плачу: 'crying', слезы: 'crying',
  грусть: 'sad', грустно: 'sad', злой: 'angry', злость: 'angry', удивление: 'surprised',
  радость: 'happy', счастье: 'happy', скучно: 'bored', устал: 'tired', сон: 'sleep',
  кот: 'cat', кошка: 'cat', котенок: 'kitten', собака: 'dog', пес: 'dog', щенок: 'puppy',
  мило: 'cute', няшно: 'cute', танец: 'dance', танцую: 'dance', танцы: 'dance',
  праздник: 'party', вечеринка: 'party', поздравляю: 'congratulations', рождения: 'birthday',
  удача: 'luck', успех: 'success', победа: 'win', молодец: 'well done', класс: 'cool',
  думаю: 'thinking', жду: 'waiting', есть: 'eat', еда: 'food', пицца: 'pizza',
  кофе: 'coffee', пиво: 'beer', огонь: 'fire', круто: 'cool', вау: 'wow', шок: 'shock',
  деньги: 'money', музыка: 'music', игра: 'game', рука: 'hand', палец: 'finger',
  вверх: 'thumbs up', время: 'time', лицо: 'face', работа: 'work', дом: 'home',
};

function gifTranslate(query) {
  const q = String(query || '').trim();
  if (!q) return '';
  const lower = q.toLowerCase();
  if (GIF_RU_EN[lower]) return GIF_RU_EN[lower];
  return lower
    .split(/\s+/)
    .map((w) => GIF_RU_EN[w] || w)
    .join(' ');
}

const GIF_FEATURED = ['reaction', 'funny', 'love', 'happy', 'cat', 'dance', 'party', 'wow', 'hello', 'cool'];

async function openverseSearch(query, limit = 24) {
  const q = gifTranslate(query) || GIF_FEATURED[Math.floor(Math.random() * GIF_FEATURED.length)];
  const params = new URLSearchParams({
    q,
    extension: 'gif',
    // У анонимных запросов Openverse лимит страницы — 20.
    page_size: String(Math.min(20, Math.max(1, Number(limit) || 20))),
    mature: 'false',
  });
  const res = await fetch(`https://api.openverse.org/v1/images/?${params.toString()}`, {
    headers: { 'User-Agent': 'DMOverlay/1.10 (GIF search)' },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
  return (data?.results || [])
    .filter((r) => r && r.url && String(r.filetype || '').toLowerCase() === 'gif')
    .map((r) => ({
      id: String(r.id || ''),
      title: r.title || 'GIF',
      url: r.url,
      preview: r.thumbnail || r.url,
    }));
}

// Скачивает медиа по ссылке: { buffer, mime, filename }.
async function downloadUrl(rawUrl) {
  const res = await fetch(rawUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Не удалось скачать (HTTP ${res.status})`);
  const mime = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('Пустой файл');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('Файл больше 8 МБ');
  return { buffer, mime, filename: filenameFromUrl(rawUrl, mime) };
}

// Отправляет медиа (буфер и/или файл на диске) в выбранный чат.
// asAnimation — отправлять как гифку (только для настоящих .gif);
// иначе GramJS сам определит тип: фото, видео, аудио или документ.
async function sendMediaTo(source, chatId, { buffer, filePath, filename, caption, replyId, asAnimation = false }) {
  const text = String(caption || '').trim();
  const reply = replyId ? Number(replyId) : null;
  if (source === 'telegram') {
    let file = filePath || '';
    if (!file) {
      fs.mkdirSync(mediaDir, { recursive: true });
      const safe = String(filename || 'file').replace(/[\\/:*?"<>|]/g, '_');
      file = path.join(mediaDir, `${Date.now()}_${safe}`);
      fs.writeFileSync(file, buffer);
    }
    const message = asAnimation
      ? await telegram.sendAnimation(chatId, file, text, reply)
      : await telegram.sendFile(chatId, file, text, reply);
    recordSent('telegram', message);
    return { ok: true, message };
  }
  const data = buffer || fs.readFileSync(filePath);
  const message = await discord.sendFile(chatId, data, filename, text, reply);
  return { ok: true, message };
}

function registerIpc() {
  ipcMain.handle('state:get', () => ({
    config,
    statuses,
    accounts,
    history,
    configPath,
    version: app.getVersion(),
    music: music.status(),
  }));

  ipcMain.handle('config:set', (_e, patch) => {
    mergeConfigPatch(patch);
    sendToRenderer('config', config);
    return config;
  });

  ipcMain.handle('discord:login', (_e, token) => {
    loginDiscord(token);
    return true;
  });

  ipcMain.handle('discord:logout', () => {
    config.discord.token = '';
    saveConfig();
    discord.logout();
    accounts.discord = null;
    return true;
  });

  ipcMain.handle('discord:searchUsers', async (_e, query) => {
    try {
      const users = await discord.searchUsers(query);
      return { ok: true, users };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('discord:openDm', async (_e, userId) => {
    try {
      const chat = await discord.openDm(userId);
      return { ok: true, chat };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('discord:getUser', async (_e, userId) => {
    try {
      const user = await discord.getUser(userId);
      return { ok: true, user };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('telegram:login', (_e, payload) => {
    // Не ждём завершения: подключение может занять время, а окно не должно зависать.
    loginTelegram(payload || {}).catch((e) => {
      sendToRenderer('error', { source: 'telegram', text: e.message });
    });
    return { started: true };
  });

  ipcMain.handle('telegram:submit', (_e, value) => telegram.submit(value));

  ipcMain.handle('telegram:qrCancel', async () => {
    await telegram.cancelLogin();
    return true;
  });

  ipcMain.handle('telegram:logout', async () => {
    await telegram.logout();
    config.telegram.session = '';
    saveConfig();
    accounts.telegram = null;
    return true;
  });

  ipcMain.handle('message:send', async (_e, { source, chatId, msgId, content }) => {
    try {
      if (source === 'telegram') {
        const message = await telegram.sendMessage(chatId, content, msgId);
        recordSent('telegram', message);
        return { ok: true, message };
      }
      const message = await discord.sendMessage(chatId, content, msgId);
      return { ok: true, message };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('message:edit', async (_e, { source, chatId, msgId, content }) => {
    try {
      if (source === 'telegram') {
        const message = await telegram.editMessage(chatId, msgId, content);
        return { ok: true, message };
      }
      const message = await discord.editMessage(chatId, msgId, content);
      return { ok: true, message };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Удаление своего сообщения.
  // mode: 'all' — удалить у всех, 'self' — удалить только у себя (Telegram),
  // 'local' — убрать только из оверлея, ничего не трогая в Discord/Telegram.
  ipcMain.handle('message:delete', async (_e, { source, chatId, msgId, mode } = {}) => {
    try {
      const src = SOURCES.includes(source) ? source : null;
      if (!src || !chatId || !msgId) return { ok: false, error: 'Не хватает данных' };
      const m = ['all', 'self', 'local'].includes(mode) ? mode : 'all';

      if (m !== 'local') {
        if (src === 'telegram') {
          // В личных чатах Telegram умеет удалять и «у себя», и «у всех».
          await telegram.deleteMessages(chatId, [msgId], m === 'all');
        } else {
          await discord.deleteMessage(chatId, msgId);
        }
      }
      removeHistoryMessage(src, chatId, msgId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Удаление чата только в оверлее.
  ipcMain.handle('chat:delete', (_e, { source, chatId } = {}) => {
    const src = SOURCES.includes(source) ? source : null;
    if (!src || !chatId) return { ok: false, error: 'Не хватает данных' };
    removeHistoryChannel(src, chatId);
    return { ok: true };
  });

  // Удаление чата и добавление в список игнорируемых (только в оверлее).
  ipcMain.handle('chat:ignore', (_e, { source, chatId, title } = {}) => {
    const src = SOURCES.includes(source) ? source : null;
    if (!src || !chatId) return { ok: false, error: 'Не хватает данных' };
    const list = ignoredList(src).filter((e) => String(e.id) !== String(chatId));
    list.push({ id: String(chatId), title: String(title || '').slice(0, 120) });
    config[src].ignored = sanitizeIgnored(list);
    saveConfig();
    removeHistoryChannel(src, chatId);
    sendToRenderer('config', config);
    return { ok: true };
  });

  ipcMain.handle('chat:unignore', (_e, { source, chatId } = {}) => {
    const src = SOURCES.includes(source) ? source : null;
    if (!src || !chatId) return { ok: false, error: 'Не хватает данных' };
    config[src].ignored = ignoredList(src).filter((e) => String(e.id) !== String(chatId));
    saveConfig();
    sendToRenderer('config', config);
    return { ok: true };
  });

  // Пересылка сообщения, в том числе между Discord и Telegram.
  ipcMain.handle('message:forward', async (_e, { from, to, comment }) => {
    try {
      const src = SOURCES.includes(from?.source) ? from.source : null;
      const dst = SOURCES.includes(to?.source) ? to.source : null;
      if (!src || !dst) return { ok: false, error: 'Неизвестный источник' };
      if (!to?.chatId) return { ok: false, error: 'Не выбран получатель' };

      const msg = history[src].find(
        (m) => String(m.id) === String(from.msgId) && String(m.channelId) === String(from.chatId)
      );
      if (!msg) return { ok: false, error: 'Сообщение не найдено в истории' };

      const att = (msg.attachments || [])[0] || null;
      const text = `${comment ? comment.trim() + '\n' : ''}${msg.content || ''}`.trim();

      // Telegram → Telegram: настоящая пересылка (сохраняет пометку «Переслано»).
      if (src === 'telegram' && dst === 'telegram') {
        const message = await telegram.forwardMessages(to.chatId, from.chatId, [from.msgId]);
        recordSent('telegram', message);
        return { ok: true, message };
      }

      let buffer = null;
      let filename = att?.filename || 'file';
      if (att) {
        try {
          if (src === 'discord' && att.url) {
            const r = await fetch(att.url);
            if (r.ok) buffer = Buffer.from(await r.arrayBuffer());
          } else if (src === 'telegram') {
            const entry = await telegram.fetchMedia(from.chatId, from.msgId, att.download || 'auto');
            buffer = entry.data;
          }
        } catch {
          buffer = null;
        }
      }

      if (dst === 'telegram') {
        if (buffer) {
          fs.mkdirSync(mediaDir, { recursive: true });
          const safe = String(filename).replace(/[\\/:*?"<>|]/g, '_');
          const file = path.join(mediaDir, `${Date.now()}_${safe}`);
          fs.writeFileSync(file, buffer);
          const message = await telegram.sendFile(to.chatId, file, text);
          recordSent('telegram', message);
          return { ok: true, message };
        }
        const message = await telegram.sendMessage(
          to.chatId,
          text || att?.label || 'Сообщение',
          null
        );
        recordSent('telegram', message);
        return { ok: true, message };
      }

      if (buffer) {
        await discord.sendFile(to.chatId, buffer, filename, text);
      } else {
        await discord.sendMessage(to.chatId, text || att?.label || 'Сообщение', null);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Медиа Telegram: отдаём байты в интерфейс, чтобы показывать прямо в окне.
  ipcMain.handle('media:fetch', async (_e, { chatId, msgId, kind }) => {
    try {
      const entry = await telegram.fetchMedia(chatId, msgId, kind);
      return { ok: true, mime: entry.mime, data: entry.data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('telegram:avatar', async (_e, userId) => {
    try {
      const url = await telegram.getAvatar(userId);
      return { ok: true, url };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Имя автора пересылки (для пометки «Переслано от …»).
  ipcMain.handle('telegram:peerName', async (_e, { id, kind } = {}) => {
    try {
      const name = await telegram.getPeerName(id, kind || 'user');
      return { ok: true, name };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Статусы собеседников (в сети / недавно / был(а) …).
  ipcMain.handle('telegram:statuses', async (_e, ids) => {
    try {
      const statuses = await telegram.getStatuses(Array.isArray(ids) ? ids : []);
      return { ok: true, statuses };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('telegram:searchUsers', async (_e, query) => {
    try {
      const users = await telegram.searchUsers(query);
      return { ok: true, users };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('telegram:openDm', async (_e, userId) => {
    try {
      const chat = await telegram.openDm(userId);
      return { ok: true, chat };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('stickers:list', async (_e, source) => {
    try {
      const packs =
        source === 'telegram' ? await telegram.getStickers() : await discord.getStickers();
      return { ok: true, packs };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('sticker:send', async (_e, { source, chatId, sticker }) => {
    try {
      if (source === 'telegram') {
        const message = await telegram.sendSticker(chatId, sticker);
        recordSent('telegram', message);
        return { ok: true, message };
      }
      await discord.sendSticker(chatId, sticker.id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('telegram:stickerThumb', async (_e, id) => {
    try {
      const entry = await telegram.getStickerThumb(id);
      if (!entry) return { ok: false, error: 'нет превью' };
      return { ok: true, mime: entry.mime, data: entry.data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Поиск гифок (Openverse) для панели GIF.
  ipcMain.handle('gif:search', async (_e, { query, limit } = {}) => {
    try {
      const results = await openverseSearch(query, limit);
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Отправка гифки по ссылке (Openverse/Giphy/Klipy и т.п.).
  ipcMain.handle('media:sendUrl', async (_e, { source, chatId, url, comment } = {}) => {
    try {
      if (!SOURCES.includes(source)) return { ok: false, error: 'Неизвестный источник' };
      if (!chatId) return { ok: false, error: 'Не выбран чат' };
      if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'Нужна ссылка http(s)' };
      const dl = await downloadUrl(url);
      return await sendMediaTo(source, chatId, {
        buffer: dl.buffer,
        filename: dl.filename,
        caption: comment,
        asAnimation: true,
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Выбор файла с компьютера. any=true — любой файл (кнопка «скрепка»),
  // иначе упор на гифки и картинки (панель GIF).
  ipcMain.handle('media:pickFile', async (_e, { any } = {}) => {
    const options = any
      ? {
          title: 'Выбери файл',
          properties: ['openFile'],
          filters: [
            {
              name: 'Медиа',
              extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'mp3', 'ogg', 'm4a', 'wav', 'pdf'],
            },
            { name: 'Все файлы', extensions: ['*'] },
          ],
        }
      : {
          title: 'Выбери гифку или файл',
          properties: ['openFile'],
          filters: [
            {
              name: 'Гифки и картинки',
              extensions: ['gif', 'webp', 'apng', 'png', 'jpg', 'jpeg', 'mp4', 'webm'],
            },
            { name: 'Все файлы', extensions: ['*'] },
          ],
        };
    const res =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  // Отправка файла с диска: как гифку/анимацию (панель GIF) или как обычное
  // вложение — фото, документ, mp3, mp4 (кнопка «скрепка»).
  ipcMain.handle(
    'media:sendFile',
    async (_e, { source, chatId, path: filePath, comment, mode, msgId } = {}) => {
      try {
        if (!SOURCES.includes(source)) return { ok: false, error: 'Неизвестный источник' };
        if (!chatId) return { ok: false, error: 'Не выбран чат' };
        if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Файл не найден' };
        const stat = fs.statSync(filePath);
        if (!stat.size) return { ok: false, error: 'Пустой файл' };

        const asAnimation = mode !== 'file';
        // Гифки ограничены скромнее, обычные вложения — до 50 МБ.
        const limit = asAnimation ? 8 * 1024 * 1024 : 50 * 1024 * 1024;
        if (stat.size > limit) {
          return { ok: false, error: `Файл больше ${Math.round(limit / 1024 / 1024)} МБ` };
        }
        if (source === 'discord' && stat.size > 8 * 1024 * 1024) {
          return { ok: false, error: 'Discord принимает файлы до 8 МБ' };
        }

        return await sendMediaTo(source, chatId, {
          filePath,
          filename: path.basename(filePath),
          caption: comment,
          replyId: msgId,
          asAnimation,
        });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  );

  // Отправка файла из буфера обмена (например, скриншот Win+Shift+S).
  ipcMain.handle(
    'media:sendBuffer',
    async (_e, { source, chatId, buffer, filename, comment, msgId } = {}) => {
      try {
        if (!SOURCES.includes(source)) return { ok: false, error: 'Неизвестный источник' };
        if (!chatId) return { ok: false, error: 'Не выбран чат' };
        const buf = Buffer.isBuffer(buffer)
          ? buffer
          : Buffer.from(buffer?.data || buffer || []);
        if (!buf.length) return { ok: false, error: 'Пустой файл' };
        if (buf.length > 50 * 1024 * 1024) return { ok: false, error: 'Файл больше 50 МБ' };
        if (source === 'discord' && buf.length > 8 * 1024 * 1024) {
          return { ok: false, error: 'Discord принимает файлы до 8 МБ' };
        }

        const safe = String(filename || 'file').replace(/[\\/:*?"<>|]/g, '_');
        fs.mkdirSync(mediaDir, { recursive: true });
        const file = path.join(mediaDir, `${Date.now()}_${safe}`);
        fs.writeFileSync(file, buf);
        return await sendMediaTo(source, chatId, {
          filePath: file,
          filename: safe,
          caption: comment,
          replyId: msgId,
        });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  );

  // Открыть медиа Telegram во внешнем приложении.
  ipcMain.handle('media:open', async (_e, { chatId, msgId }) => {
    try {
      const file = await telegram.downloadMedia(chatId, msgId, mediaDir);
      const err = await shell.openPath(file);
      if (err) return { ok: false, error: err };
      return { ok: true, file };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('history:clear', (_e, source) => {
    const src = SOURCES.includes(source) ? source : 'discord';
    history[src] = [];
    saveHistorySoon();
    return true;
  });

  ipcMain.handle('win:minimize', () => {
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.handle('win:close', () => {
    if (win && !win.isDestroyed()) win.hide();
  });

  ipcMain.handle('win:setOpacity', (_e, value) => {
    if (win && !win.isDestroyed()) win.setOpacity(Math.min(1, Math.max(0.35, Number(value) || 1)));
  });

  ipcMain.handle('app:openDataFolder', () => shell.openPath(dataDir));

  ipcMain.handle('music:search', (_e, query) => music.search(query));
  ipcMain.handle('music:resolve', (_e, url) => music.resolve(url));
  ipcMain.handle('music:stream', (_e, id) => music.stream(id));
  ipcMain.handle('music:recommend', (_e, seedId) => music.recommend(seedId));
  ipcMain.handle('music:repair', (_e, ids) => music.repair(ids));
  ipcMain.handle('music:update', () => music.update());

  ipcMain.handle('app:openUrl', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('app:testMessage', (_e, source) => {
    const src = SOURCES.includes(source) ? source : config.activeSource;
    const demo = {
      id: `demo-${Date.now()}`,
      source: src,
      channelId: 'demo',
      content:
        src === 'telegram'
          ? 'Привет! Это тестовое сообщение из Telegram — так будет выглядеть новая личка 🙂'
          : 'Привет! Это тестовое сообщение — так будет выглядеть новая личка 😊',
      timestamp: new Date().toISOString(),
      edited: false,
      own: false,
      channelType: 1,
      author: {
        id: 'demo',
        username: 'test_user',
        globalName: 'Тестовый друг',
        avatar: null,
        bot: false,
      },
      channelTitle: 'Тестовый друг',
      recipients: [],
      attachments: [],
      sticker: null,
      replyTo: null,
    };
    sendToRenderer('message', demo);
    return true;
  });
}

// -------------------------------------------------------------------- жизнь

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    loadConfig();
    loadHistory();

    setupDiscord();
    setupTelegram();
    registerIpc();
    createWindow();
    createTray();

    globalShortcut.register('CommandOrControl+Shift+D', toggleWindow);

    if (config.discord.token) loginDiscord();
    else statuses.discord = { state: 'disconnected', text: 'Вставь токен Discord' };

    if (config.telegram.session && telegramCreds(config.telegram).apiId) loginTelegram({}, true);
    else statuses.telegram = { state: 'disconnected', text: 'Telegram не подключён' };

    music
      .ensureBinary()
      .then(() => sendToRenderer('music:status', music.status()))
      .catch(() => sendToRenderer('music:status', music.status()));
  });

  app.on('before-quit', () => {
    quitting = true;
    discord.logout();
    telegram.shutdown(true);
    clearTimeout(saveTimer);
    writeJson(historyPath, history);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('window-all-closed', () => {
    // окно живёт в трее, приложение не закрываем
  });

  app.on('activate', showWindow);

  powerMonitor.on('resume', () => {
    if (config.discord.token && !discord.ws) loginDiscord();
    if (config.telegram.session && !telegram.client) loginTelegram({}, true);
  });
}
