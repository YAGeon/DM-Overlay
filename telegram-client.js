'use strict';

/**
 * Клиент Telegram (MTProto) на GramJS.
 *
 * Читает личные сообщения обычного аккаунта. В отличие от Discord, вход
 * пользовательским клиентом в Telegram официально разрешён и не является
 * нарушением правил.
 */

const { EventEmitter } = require('events');

let TelegramClient = null;
let StringSession = null;
let NewMessage = null;
let Raw = null;
let Api = null;

try {
  ({ TelegramClient, Api } = require('telegram'));
  ({ StringSession } = require('telegram/sessions'));
  ({ NewMessage, Raw } = require('telegram/events'));
} catch (e) {
  console.error('GramJS не установлен:', e.message);
}

// Определяет MIME по «магическим» байтам — Telegram не всегда отдаёт тип.
function sniffMime(buffer) {
  if (!buffer || buffer.length < 4) return '';
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length > 12) {
    if (b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  }
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video/mp4';
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return '';
}

// Отбирает статичные превью документа (PhotoSize*), пропуская VideoSize.
// Для видео-стикеров VideoSize — это сам .webm, который <img> не покажет.
// Возвращает от самого крупного к самому мелкому.
function imageThumbsBySize(thumbs) {
  const weight = (t) => {
    if (typeof t.size === 'number') return t.size;
    if (Array.isArray(t.sizes) && t.sizes.length) return Math.max(...t.sizes);
    if (t.bytes) return t.bytes.length;
    return 0;
  };
  return (thumbs || [])
    .filter(
      (t) =>
        t instanceof Api.PhotoSize ||
        t instanceof Api.PhotoCachedSize ||
        t instanceof Api.PhotoSizeProgressive ||
        t instanceof Api.PhotoStrippedSize
    )
    .sort((a, b) => weight(a) - weight(b))
    .reverse();
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function displayName(entity) {
  if (!entity) return 'Неизвестный';
  const parts = [entity.firstName, entity.lastName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  if (entity.title) return entity.title;
  if (entity.username) return entity.username;
  return String(entity.id || 'Неизвестный');
}

// Из заголовка пересылки (MessageFwdHeader) достаёт id и тип автора.
// Нужно, чтобы показать «Переслано от …», когда Telegram не прислал имя.
function fwdPeerInfo(fwd) {
  if (!fwd || !fwd.fromId) return null;
  const id = fwd.fromId;
  if (id.userId != null) return { id: String(id.userId), kind: 'user' };
  if (id.channelId != null) return { id: String(id.channelId), kind: 'channel' };
  if (id.chatId != null) return { id: String(id.chatId), kind: 'chat' };
  return null;
}

// Статус пользователя Telegram → { state, wasOnline }.
// online — в сети; recently/lastweek/lastmonth — был(а) недавно;
// offline — не в сети (wasOnline — время последнего визита).
function userStatusInfo(entity) {
  const st = entity && entity.status;
  if (!st) return null;
  switch (st.className) {
    case 'UserStatusOnline':
      return { state: 'online', wasOnline: null };
    case 'UserStatusOffline':
      return {
        state: 'offline',
        wasOnline: st.wasOnline ? new Date(st.wasOnline * 1000).toISOString() : null,
      };
    case 'UserStatusRecently':
      return { state: 'recently', wasOnline: null };
    case 'UserStatusLastWeek':
      return { state: 'lastweek', wasOnline: null };
    case 'UserStatusLastMonth':
      return { state: 'lastmonth', wasOnline: null };
    default:
      return null;
  }
}

/**
 * Разбирает строку прокси: host:port, user:pass@host:port.
 * Возвращает { proxy } | { error } | null (если прокси не задан).
 */
function parseProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const m = s.match(/^(?:([^:@\s]+)(?::([^@\s]*))?@)?([^:@\s]+):(\d{2,5})$/);
  if (!m) return { error: 'Неверный формат прокси. Нужно host:port или user:pass@host:port' };

  const port = Number(m[4]);
  if (!port || port > 65535) return { error: 'Неверный порт прокси' };

  const proxy = { ip: m[3], port, socksType: 5 };
  if (m[1]) proxy.username = m[1];
  if (m[2]) proxy.password = m[2];
  return { proxy };
}

class TgClient extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.me = null;
    this.session = '';
    this.pending = null;
    this.raw = new Map();
    this.rawOrder = [];
    this.peers = new Map(); // chatId (userId) -> сущность собеседника
    this.avatarCache = new Map(); // userId -> data URL | null
    this.peerNameCache = new Map(); // "kind:id" -> имя автора пересылки
    this.mediaCache = new Map(); // chatId:msgId:kind -> { data, mime }
    this.mediaCacheBytes = 0;
    this.stickerDocs = new Map(); // stickerId -> Api.Document
    this.watch = new Set();
    this.watchNames = new Set();
    this.showOwn = true;
    this.allowSend = false;
    this.shuttingDown = false;
    this.loggingIn = false;
    this.cancelling = false;
    this.status = { state: 'disconnected', text: 'Telegram не подключён' };
  }

  setStatus(text, state) {
    this.status = { state, text };
    this.emit('status', { ...this.status });
  }

  setWatch(list, showOwn) {
    this.watch = new Set();
    this.watchNames = new Set();
    for (const raw of list || []) {
      const v = String(raw).trim().replace(/^@/, '');
      if (!v) continue;
      if (/^\d{5,25}$/.test(v)) this.watch.add(v);
      else this.watchNames.add(v.toLowerCase());
    }
    if (typeof showOwn === 'boolean') this.showOwn = showOwn;
  }

  matchesWatch(entity) {
    if (!this.watch.size && !this.watchNames.size) return true;
    if (this.watch.has(String(entity?.id))) return true;
    const candidates = [displayName(entity), entity?.username]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    return candidates.some((c) => this.watchNames.has(c));
  }

  // ------------------------------------------------------------- авторизация

  async login(cfg, { auto = false, qr = false } = {}) {
    if (!TelegramClient) {
      this.setStatus('Не установлен модуль telegram (npm install)', 'error');
      this.emit('error', 'Не установлен модуль telegram. Запусти «Запустить.bat» ещё раз.');
      return;
    }

    if (this.loggingIn) return;
    this.loggingIn = true;

    try {
      await this.loginInner(cfg, auto, qr);
    } finally {
      this.loggingIn = false;
    }
  }

  async loginInner(cfg, auto, qr = false) {
    await this.shutdown(true);
    this.shuttingDown = false;
    this.cancelling = false;

    const apiId = Number(String(cfg?.apiId || '').trim());
    const apiHash = String(cfg?.apiHash || '').trim();
    const phone = String(cfg?.phone || '').trim().replace(/[^\d+]/g, '');

    if (!apiId || !apiHash) {
      this.setStatus('Укажи api_id и api_hash', 'error');
      return;
    }

    const parsedProxy = parseProxy(cfg?.proxy);
    if (parsedProxy?.error) {
      this.setStatus(parsedProxy.error, 'error');
      this.emit('error', parsedProxy.error);
      return;
    }

    try {
      this.client = new TelegramClient(new StringSession(cfg?.session || ''), apiId, apiHash, {
        connectionRetries: 2,
        retryDelay: 1000,
        useWSS: false,
        autoReconnect: true,
        deviceModel: 'Overlay',
        systemVersion: 'Windows 11',
        appVersion: '1.0.0',
        langCode: 'ru',
        systemLangCode: 'ru',
        ...(parsedProxy?.proxy ? { proxy: parsedProxy.proxy } : {}),
      });

      this.setStatus('Подключаюсь к Telegram…', 'connecting');
      await withTimeout(this.client.connect(), 25000, 'TIMEOUT_CONNECT');

      const authorized = await withTimeout(
        this.client.checkAuthorization(),
        15000,
        'TIMEOUT_AUTH'
      );
      if (!authorized) {
        if (auto) {
          this.setStatus('Нужен вход в Telegram', 'disconnected');
          await this.shutdown(true);
          return;
        }

        if (qr) {
          await this.loginQr(apiId, apiHash);
        } else {
          if (!phone) {
            this.setStatus('Укажи номер телефона', 'error');
            return;
          }
          await this.loginCode(phone);
        }
      }

      this.session = this.client.session.save();
      this.emit('session', this.session);

      this.me = await withTimeout(this.client.getMe(), 15000, 'TIMEOUT_ME');
      if (this.me) {
        this.me.displayName = displayName(this.me);
      }

      this.attach();
      this.setStatus(`Подключено как ${displayName(this.me)}`, 'online');
      this.emit('me', this.publicMe());
    } catch (e) {
      if (this.cancelling) {
        this.cancelling = false;
        return;
      }
      const text = this.friendlyError(e?.errorMessage || e?.message || String(e));
      this.setStatus(text, 'error');
      this.emit('error', text);
      this.cancelPending();
      await this.shutdown(true);
    }
  }

  onAuthError(err) {
    const code = err?.errorMessage || err?.message || String(err);
    const text = this.friendlyError(code);
    this.emit('error', text);
    this.setStatus(text, 'error');
    return /PHONE_CODE_INVALID|PHONE_CODE_EXPIRED|PHONE_CODE_EMPTY|PHONE_CODE_UNSPECIFIED|PASSWORD_HASH_INVALID|SESSION_PASSWORD_NEEDED|PHONE_CODE|PASSWORD/i.test(
      code
    );
  }

  // Вход по коду из Telegram / SMS.
  async loginCode(phone) {
    await this.client.start({
      phoneNumber: async () => phone,
      password: () => this.ask('password'),
      phoneCode: () => this.ask('code'),
      onError: (err) => this.onAuthError(err),
    });
  }

  // Вход по QR-коду: пользователь сканирует его в приложении Telegram.
  async loginQr(apiId, apiHash) {
    this.setStatus('Показываю QR-код — отсканируй его в Telegram', 'connecting');
    await this.client.signInUserWithQrCode(
      { apiId, apiHash },
      {
        qrCode: async (code) => {
          const token = Buffer.from(code.token).toString('base64url');
          this.emit('qr', { url: `tg://login?token=${token}` });
        },
        password: () => this.ask('password'),
        onError: (err) => this.onAuthError(err),
      }
    );
  }

  publicMe() {
    if (!this.me) return null;
    return {
      id: String(this.me.id),
      username: this.me.username || '',
      name: displayName(this.me),
      phone: this.me.phone || '',
    };
  }

  ask(type) {
    return new Promise((resolve, reject) => {
      this.cancelPending();
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('Время ожидания истекло — попробуй войти заново'));
      }, 5 * 60 * 1000);

      this.pending = { type, resolve, reject, timer };
      this.emit('auth', { need: type });
      this.setStatus(
        type === 'code' ? 'Введи код из Telegram' : 'Введи пароль двухфакторной аутентификации',
        'connecting'
      );
    });
  }

  submit(value) {
    if (!this.pending) return false;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(String(value || '').trim());
    return true;
  }

  cancelPending() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(new Error('Вход отменён'));
  }

  friendlyError(raw) {
    const code = String(raw || '');
    if (/TIMEOUT_CONNECT|TIMEOUT_AUTH|TIMEOUT_ME|ETIMEDOUT/i.test(code))
      return 'Telegram не отвечает — проверь интернет или VPN и попробуй ещё раз';
    if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(code))
      return 'Неверные api_id / api_hash. Проверь их на my.telegram.org';
    if (/PHONE_NUMBER_INVALID/.test(code)) return 'Неверный номер телефона';
    if (/PHONE_CODE_INVALID/.test(code)) return 'Неверный код подтверждения';
    if (/PHONE_CODE_EXPIRED/.test(code)) return 'Код подтверждения истёк — запроси новый';
    if (/PASSWORD_HASH_INVALID/.test(code)) return 'Неверный пароль двухфакторной аутентификации';
    if (/FLOOD_WAIT_(\d+)/.test(code)) {
      const sec = code.match(/FLOOD_WAIT_(\d+)/)[1];
      return `Telegram просит подождать ${sec} секунд`;
    }
    if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED/.test(code)) return 'Сессия недействительна — войди заново';
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|network/i.test(code))
      return 'Нет связи с Telegram. Проверь интернет или прокси.';
    return code || 'Неизвестная ошибка Telegram';
  }

  // ------------------------------------------------------------- сообщения

  attach() {
    if (!this.client) return;
    this.handler = (event) => {
      this.onMessage(event.message).catch((e) => {
        this.emit('error', `Ошибка обработки сообщения: ${e.message}`);
      });
    };
    this.client.addEventHandler(this.handler, new NewMessage({}));

    // Онлайн-статусы собеседников обновляются «на лету».
    if (Raw) {
      this.statusHandler = (update) => {
        if (!update || update.className !== 'UpdateUserStatus') return;
        const userId = String(update.userId || '');
        if (!userId) return;
        const cached = this.peers.get(userId);
        if (cached) cached.status = update.status;
        this.emit('status:user', { userId, status: userStatusInfo({ status: update.status }) });
      };
      this.client.addEventHandler(this.statusHandler, new Raw({ types: [Api.UpdateUserStatus] }));
    }
  }

  // Имя автора пересылки по id и типу (для пометки «Переслано от …»).
  async getPeerName(id, kind = 'user') {
    const key = `${kind}:${id}`;
    if (this.peerNameCache.has(key)) return this.peerNameCache.get(key);
    if (!this.client || !id) return '';

    // Сначала пробуем взять из уже загруженных собеседников.
    if (kind === 'user') {
      const cached = this.peers.get(String(id));
      if (cached) {
        const name = displayName(cached);
        this.peerNameCache.set(key, name);
        return name;
      }
    }

    let entity = null;
    try {
      let ref;
      if (kind === 'channel') ref = new Api.PeerChannel({ channelId: BigInt(id) });
      else if (kind === 'chat') ref = new Api.PeerChat({ chatId: BigInt(id) });
      else ref = new Api.PeerUser({ userId: BigInt(id) });
      entity = await withTimeout(this.client.getEntity(ref), 8000, 'TIMEOUT_PEERNAME');
    } catch {
      entity = null;
    }
    const name = entity ? displayName(entity) : '';
    this.peerNameCache.set(key, name);
    return name;
  }

  // Статусы пользователей по id чатов: { chatId: { state, wasOnline } }.
  async getStatuses(ids) {
    const out = {};
    if (!this.client) return out;
    for (const id of ids || []) {
      const entity = await this.peerFor(id).catch(() => null);
      const st = userStatusInfo(entity);
      if (st) out[String(id)] = st;
    }
    return out;
  }

  async onMessage(msg) {
    if (!msg) return;
    if (!msg.isPrivate) return;
    if (msg.action) return;

    const own = !!msg.out;
    if (own && !this.showOwn) return;

    let sender = null;
    if (!own) {
      sender = msg.sender;
      if (!sender) {
        try {
          sender = await msg.getSender();
        } catch {
          sender = null;
        }
      }
      if (!this.matchesWatch(sender)) return;
    }

    const chatId = String(msg.chatId ?? msg.peerId?.userId ?? '');
    if (!chatId) return;

    // Собеседник (для аватарки и имени в списке чатов).
    let peerEntity = null;
    if (!own) {
      peerEntity = sender;
    } else {
      peerEntity = this.peers.get(chatId) || msg.chat || null;
      if (!peerEntity && msg.sender && String(msg.sender.id) !== String(this.me?.id)) {
        peerEntity = msg.sender;
      }
    }
    if (peerEntity && peerEntity.id != null && String(peerEntity.id) !== String(this.me?.id)) {
      this.peers.set(chatId, peerEntity);
    }

    const id = String(msg.id);
    const key = `${chatId}:${id}`;

    this.raw.set(key, msg);
    this.rawOrder.push(key);
    while (this.rawOrder.length > 400) {
      const old = this.rawOrder.shift();
      this.raw.delete(old);
    }

    const authorEntity = own ? this.me : sender;
    const media = this.describeMedia(msg);

    const replyId = msg.replyTo?.replyToMsgId;
    let replyTo = null;
    if (replyId) {
      let target = this.raw.get(`${chatId}:${replyId}`) || null;
      if (!target && typeof msg.getReplyMessage === 'function') {
        // Если цитируемое сообщение не попало в кэш (например, пришло до запуска),
        // подтягиваем его из Telegram, чтобы показать автора и текст.
        try {
          target = await withTimeout(msg.getReplyMessage(), 5000, 'TIMEOUT_REPLY');
        } catch {
          target = null;
        }
      }

      let author = 'Сообщение';
      if (target) {
        let entity = target.out ? this.me : target.sender;
        if (!entity && !target.out && typeof target.getSender === 'function') {
          try {
            entity = await target.getSender();
          } catch {
            entity = null;
          }
        }
        if (!entity && target.senderId) entity = { id: target.senderId };
        author = displayName(entity);
      }

      replyTo = {
        id: String(replyId),
        channelId: chatId,
        author,
        content: target ? target.text || target.message || '' : '',
        attachments: target && this.describeMedia(target) ? 1 : 0,
        sticker: null,
      };
    }

    this.emit('message', {
      id,
      source: 'telegram',
      channelId: chatId,
      content: msg.text || msg.message || '',
      timestamp: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      edited: !!msg.editDate,
      own,
      channelType: 1,
      author: {
        id: String(authorEntity?.id || (own ? 'me' : 'unknown')),
        username: authorEntity?.username || '',
        globalName: displayName(authorEntity),
        avatar: null,
        bot: !!authorEntity?.bot,
      },
      channelTitle: own
        ? displayName(peerEntity) || 'Личка'
        : displayName(sender),
      recipients: own
        ? [{ id: chatId, name: displayName(peerEntity) || '', avatar: null }]
        : [],
      attachments: media ? [media] : [],
      sticker: null,
      replyTo,
      forwarded: !!msg.fwdFrom,
      forwardedFrom: msg.fwdFrom?.fromName || '',
      forwardedFromId: fwdPeerInfo(msg.fwdFrom)?.id || '',
      forwardedFromKind: fwdPeerInfo(msg.fwdFrom)?.kind || '',
    });
  }

  describeMedia(msg) {
    const doc = msg.document || null;
    const attrs = doc?.attributes || [];
    const find = (name) => attrs.find((a) => a.className === name);
    const videoAttr = find('DocumentAttributeVideo');
    const audioAttr = find('DocumentAttributeAudio');
    const nameAttr = find('DocumentAttributeFilename');
    const isSticker = !!msg.sticker || !!find('DocumentAttributeSticker');
    const isRound = !!(videoAttr && videoAttr.roundMessage) || !!msg.videoNote;
    const isAnimated = !!msg.gif || !!find('DocumentAttributeAnimated');
    const isVideo = !!videoAttr || !!msg.video;
    const isVoice = !!(audioAttr && audioAttr.voice) || !!msg.voice;
    const isAudio = !!audioAttr || !!msg.audio;

    if (msg.photo && !doc) {
      const sizes = msg.photo.sizes || [];
      const big = sizes[sizes.length - 1] || {};
      return {
        kind: 'photo',
        filename: 'Фото.jpg',
        size: 0,
        contentType: 'image/jpeg',
        label: 'Фото',
        download: 'photo',
        width: big.w,
        height: big.h,
      };
    }

    const size = Number(doc?.size || 0);
    const mime = doc?.mimeType || '';

    if (isSticker) {
      return {
        kind: 'sticker',
        filename: 'Стикер.webp',
        size,
        contentType: mime || 'image/webp',
        label: 'Стикер',
        download: 'sticker',
        width: videoAttr?.w,
        height: videoAttr?.h,
      };
    }
    if (isRound) {
      return {
        kind: 'round',
        filename: 'Кружок.mp4',
        size,
        contentType: mime || 'video/mp4',
        label: 'Видеосообщение',
        download: 'video',
        width: videoAttr?.w,
        height: videoAttr?.h,
      };
    }
    if (isAnimated) {
      return {
        kind: 'gif',
        filename: nameAttr?.fileName || 'Анимация.mp4',
        size,
        contentType: mime || 'video/mp4',
        label: 'Гифка',
        download: 'video',
        width: videoAttr?.w,
        height: videoAttr?.h,
      };
    }
    if (isVideo) {
      return {
        kind: 'video',
        filename: nameAttr?.fileName || 'Видео.mp4',
        size,
        contentType: mime || 'video/mp4',
        label: nameAttr?.fileName || 'Видео',
        download: 'video',
        width: videoAttr?.w,
        height: videoAttr?.h,
      };
    }
    if (isVoice) {
      return {
        kind: 'voice',
        filename: 'Голосовое.ogg',
        size,
        contentType: mime || 'audio/ogg',
        label: 'Голосовое сообщение',
        download: 'audio',
      };
    }
    if (isAudio) {
      return {
        kind: 'audio',
        filename: nameAttr?.fileName || 'Аудио.mp3',
        size,
        contentType: mime || 'audio/mpeg',
        label: nameAttr?.fileName || 'Аудио',
        download: 'audio',
      };
    }
    if (doc) {
      return {
        kind: 'file',
        filename: nameAttr?.fileName || 'Файл',
        size,
        contentType: mime,
        label: nameAttr?.fileName || 'Файл',
        download: 'file',
      };
    }
    return null;
  }

  // ------------------------------------------------------ медиа и аватарки

  // Возвращает «сырое» сообщение Telegram: из кэша, а если его там нет
  // (например, оно пришло в прошлом запуске) — подтягивает по id из Telegram.
  async getRawMessage(chatId, msgId) {
    const key = `${chatId}:${msgId}`;
    const cached = this.raw.get(key);
    if (cached) return cached;
    if (!this.client) return null;
    try {
      const peer = await this.peerFor(chatId);
      if (!peer) return null;
      const list = await withTimeout(
        this.client.getMessages(peer, { ids: [Number(msgId)] }),
        15000,
        'TIMEOUT_GETMSG'
      );
      const msg = Array.isArray(list) ? list.find((m) => m && m.id != null) : null;
      if (!msg) return null;
      this.raw.set(key, msg);
      this.rawOrder.push(key);
      while (this.rawOrder.length > 400) {
        const old = this.rawOrder.shift();
        this.raw.delete(old);
      }
      return msg;
    } catch {
      return null;
    }
  }

  // Скачивает медиа сообщения и возвращает { data, mime }. Результат кэшируется.
  async fetchMedia(chatId, msgId, kind = 'auto') {
    if (!this.client) throw new Error('Telegram не подключён');
    const key = `${chatId}:${msgId}`;
    const msg = await this.getRawMessage(chatId, msgId);
    if (!msg) throw new Error('Сообщение не найдено в Telegram');

    const cacheKey = `${key}:${kind}`;
    const cached = this.mediaCache.get(cacheKey);
    if (cached) return cached;

    let buffer = null;
    if (kind === 'sticker' || kind === 'thumb') {
      buffer = await this.downloadStickerPreview(msg);
    } else {
      buffer = await withTimeout(this.client.downloadMedia(msg, {}), 120000, 'TIMEOUT_MEDIA');
    }
    if (!buffer || !buffer.length) throw new Error('Не удалось скачать медиа');

    const media = this.describeMedia(msg);
    const mime = sniffMime(buffer) || media?.contentType || 'application/octet-stream';
    const entry = { data: Buffer.from(buffer), mime };
    this.cacheMedia(cacheKey, entry);
    return entry;
  }

  async downloadStickerPreview(msg) {
    const doc = msg.document || null;
    for (const thumb of imageThumbsBySize(doc && doc.thumbs)) {
      try {
        const buf = await withTimeout(
          this.client.downloadMedia(msg, { thumb }),
          30000,
          'TIMEOUT_THUMB'
        );
        if (buf && buf.length) return buf;
      } catch {
        /* пробуем следующий вариант */
      }
    }
    return withTimeout(this.client.downloadMedia(msg, {}), 30000, 'TIMEOUT_MEDIA');
  }

  cacheMedia(key, entry) {
    this.mediaCache.set(key, entry);
    this.mediaCacheBytes += entry.data.length;
    // Ограничиваем кэш ~120 МБ, вытесняя самые старые записи.
    while (this.mediaCacheBytes > 120 * 1024 * 1024 && this.mediaCache.size > 1) {
      const first = this.mediaCache.keys().next().value;
      const old = this.mediaCache.get(first);
      this.mediaCache.delete(first);
      this.mediaCacheBytes -= old?.data?.length || 0;
    }
  }

  // Аватарка пользователя (data URL) с кэшированием.
  async getAvatar(userId) {
    const id = String(userId || '');
    if (!id || id === 'me' || id === 'unknown') return null;
    if (this.avatarCache.has(id)) return this.avatarCache.get(id);
    if (!this.client) return null;

    let entity = this.peers.get(id) || null;
    if (!entity) {
      try {
        entity = await this.client.getEntity(id);
      } catch {
        entity = null;
      }
    }
    if (entity && entity.id != null) this.peers.set(id, entity);

    if (!entity || !entity.photo) {
      this.avatarCache.set(id, null);
      return null;
    }
    try {
      const buf = await withTimeout(
        this.client.downloadProfilePhoto(entity, { isBig: false }),
        20000,
        'TIMEOUT_AVATAR'
      );
      if (!buf || !buf.length) {
        this.avatarCache.set(id, null);
        return null;
      }
      const mime = sniffMime(buf) || 'image/jpeg';
      const url = `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
      this.avatarCache.set(id, url);
      return url;
    } catch {
      this.avatarCache.set(id, null);
      return null;
    }
  }

  // --------------------------------------------- новый чат (кому ещё не писал)

  async searchUsers(query) {
    if (!this.client) throw new Error('Telegram не подключён');
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const res = await this.client.invoke(new Api.contacts.Search({ q, limit: 25 }));
    const out = [];
    for (const u of res.users || []) {
      if (!u || u.id == null) continue;
      if (String(u.id) === String(this.me?.id)) continue;
      if (u.bot) continue;
      this.peers.set(String(u.id), u);
      out.push({
        id: String(u.id),
        username: u.username || '',
        globalName: displayName(u),
        avatar: null,
        phone: u.phone || '',
      });
    }
    return out;
  }

  async openDm(userId) {
    if (!this.client) throw new Error('Telegram не подключён');
    const id = String(userId || '').trim().replace(/^@/, '');
    if (String(id) === String(this.me?.id)) throw new Error('Это твой собственный ID');
    const isId = /^\d{4,25}$/.test(id);
    const isPhone = /^\+\d{7,15}$/.test(id);
    const isUsername = /^[a-zA-Z][\w\d_]{3,}$/.test(id);
    if (!isId && !isPhone && !isUsername) {
      throw new Error('Укажи @ник, номер телефона или ID пользователя');
    }

    let entity = this.peers.get(id) || null;
    if (!entity) {
      try {
        entity = await this.client.getEntity(id);
      } catch {
        entity = null;
      }
    }
    if (!entity) throw new Error('Не нашёл такого пользователя в Telegram');
    const userId2 = String(entity.id);
    this.peers.set(userId2, entity);
    return {
      channelId: userId2,
      channelType: 1,
      user: {
        id: userId2,
        username: entity.username || '',
        globalName: displayName(entity),
        avatar: null,
      },
    };
  }

  // ------------------------------------------------------------- стикеры

  // Все стикерные наборы, добавленные пользователем в аккаунт. Возвращаем
  // их паками (как в Telegram): один набор — один пак со своими стикерами.
  async getStickers() {
    if (!this.client) throw new Error('Telegram не подключён');
    const res = await this.client.invoke(new Api.messages.GetAllStickers({ hash: 0 }));
    const sets = res.sets || [];
    if (!sets.length) return [];

    // Тянем наборы параллельно, но небольшими порциями, чтобы не улететь
    // в флуд-лимит. Порядок сохраняем по исходному списку Telegram.
    const results = new Array(sets.length).fill(null);
    const CONCURRENCY = 4;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= sets.length) return;
        results[i] = await this.fetchStickerPack(sets[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, sets.length) }, () => worker())
    );
    return results.filter(Boolean);
  }

  // Один набор -> пак со стикерами. Недоступные наборы пропускаем.
  async fetchStickerPack(set) {
    try {
      const full = await this.client.invoke(
        new Api.messages.GetStickerSet({
          stickerset: new Api.InputStickerSetID({ id: set.id, accessHash: set.accessHash }),
          hash: 0,
        })
      );
      const stickers = [];
      for (const doc of full.documents || []) {
        if (doc.className !== 'Document' || doc.id == null) continue;
        this.stickerDocs.set(String(doc.id), doc);
        const attr = (doc.attributes || []).find(
          (a) => a.className === 'DocumentAttributeSticker'
        );
        stickers.push({
          id: String(doc.id),
          accessHash: String(doc.accessHash),
          fileReference: Buffer.from(doc.fileReference || []).toString('base64'),
          emoji: attr?.alt || '🙂',
          name: set.title || '',
          setName: set.title || '',
          animated: (doc.attributes || []).some(
            (a) => a.className === 'DocumentAttributeAnimated'
          ),
        });
      }
      if (!stickers.length) return null;
      const cover = stickers[0];
      return {
        id: String(set.id),
        title: set.title || 'Набор стикеров',
        shortName: set.shortName || '',
        count: stickers.length,
        cover: cover.id,
        emoji: cover.emoji || '🙂',
        stickers,
      };
    } catch {
      /* набор мог стать недоступен */
      return null;
    }
  }

  // Превью стикера (первый кадр) для панели выбора.
  async getStickerThumb(id) {
    const doc = this.stickerDocs.get(String(id));
    if (!doc || !this.client) return null;
    const cacheKey = `sticker:${id}`;
    const cached = this.mediaCache.get(cacheKey);
    if (cached) return cached;
    const media = new Api.MessageMediaDocument({ document: doc });
    for (const thumb of imageThumbsBySize(doc.thumbs)) {
      try {
        const buf = await withTimeout(
          this.client.downloadMedia(media, { thumb }),
          20000,
          'TIMEOUT_STICKER'
        );
        if (buf && buf.length) {
          const entry = { data: Buffer.from(buf), mime: sniffMime(buf) || 'image/webp' };
          this.cacheMedia(cacheKey, entry);
          return entry;
        }
      } catch {
        /* пробуем следующий размер */
      }
    }
    return null;
  }

  async sendSticker(chatId, sticker) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    if (!this.client) throw new Error('Telegram не подключён');
    await this.peerFor(chatId);
    // invoke() не умеет сам разрешать собеседника, поэтому получаем InputPeer явно.
    const peer = await this.client.getInputEntity(chatId);
    const doc = new Api.InputDocument({
      id: BigInt(sticker.id),
      accessHash: BigInt(sticker.accessHash),
      fileReference: Buffer.from(sticker.fileReference || '', 'base64'),
    });
    const sent = await this.client.invoke(
      new Api.messages.SendMedia({
        peer,
        media: new Api.InputMediaDocument({ id: doc }),
        message: '',
        randomId: BigInt(`-${Date.now()}${Math.floor(Math.random() * 1000)}`),
      })
    );
    const msg = Array.isArray(sent.updates)
      ? sent.updates.find((u) => u.className === 'UpdateNewMessage')?.message
      : null;
    // Локально показываем стикер сразу, не дожидаясь обновления от Telegram.
    const docInfo = this.stickerDocs.get(String(sticker.id)) || null;
    const media = docInfo ? this.describeMedia({ document: docInfo }) : null;
    return this.normalizeSent(chatId, msg, '', null, media ? [media] : []);
  }


  // -------------------------------------------------------------- действия

  async downloadMedia(chatId, msgId, tempDir) {
    const msg = await this.getRawMessage(chatId, msgId);
    if (!msg) throw new Error('Сообщение не найдено в Telegram');
    const fs = require('fs');
    const path = require('path');

    const media = this.describeMedia(msg);
    const buffer = await this.client.downloadMedia(msg, {});
    if (!buffer || !buffer.length) throw new Error('Не удалось скачать файл');

    let name = (media?.filename || 'file').replace(/[\\/:*?"<>|]/g, '_');
    if (!path.extname(name)) {
      const extByMime = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'video/mp4': '.mp4',
        'audio/ogg': '.ogg',
        'audio/mpeg': '.mp3',
      };
      name += extByMime[media?.contentType] || '';
    }

    fs.mkdirSync(tempDir, { recursive: true });
    const file = path.join(tempDir, `${Date.now()}_${name}`);
    fs.writeFileSync(file, buffer);
    return file;
  }

  // Возвращает сущность собеседника по id чата (из кэша или из Telegram).
  async peerFor(chatId) {
    const id = String(chatId);
    let entity = this.peers.get(id) || null;
    if (!entity) {
      try {
        entity = await this.client.getEntity(chatId);
      } catch {
        entity = null;
      }
    }
    if (entity && entity.id != null) this.peers.set(String(entity.id), entity);
    return entity;
  }

  // Собирает «нормализованное» своё сообщение для интерфейса.
  normalizeSent(chatId, sent, text, replyTo, attachments = [], forwarded = false) {
    const entity = this.peers.get(String(chatId)) || null;
    const peerName = entity ? displayName(entity) : '';
    return {
      id: String(sent?.id || Date.now()),
      source: 'telegram',
      channelId: String(chatId),
      content: text || '',
      timestamp: new Date(
        (sent?.date || Math.floor(Date.now() / 1000)) * 1000
      ).toISOString(),
      edited: false,
      own: true,
      channelType: 1,
      author: {
        id: String(this.me?.id || 'me'),
        username: this.me?.username || '',
        globalName: displayName(this.me),
        avatar: null,
        bot: false,
      },
      channelTitle: peerName,
      recipients: [{ id: String(chatId), name: peerName, avatar: null }],
      attachments: (attachments || []).filter(Boolean),
      sticker: null,
      replyTo: replyTo || null,
      forwarded: !!forwarded,
      forwardedFrom: (forwarded && sent?.fwdFrom?.fromName) || '',
      forwardedFromId: (forwarded && fwdPeerInfo(sent?.fwdFrom)?.id) || '',
      forwardedFromKind: (forwarded && fwdPeerInfo(sent?.fwdFrom)?.kind) || '',
    };
  }

  // Цитата для отправляемого сообщения (если отвечаем).
  buildReplyInfo(chatId, msgId) {
    if (!msgId) return null;
    const target = this.raw.get(`${chatId}:${msgId}`) || null;
    let author = 'Сообщение';
    if (target) {
      const targetEntity = target.out ? this.me : target.sender;
      author = displayName(targetEntity || this.me);
    }
    return {
      id: String(msgId),
      channelId: String(chatId),
      author,
      content: target ? target.text || target.message || '' : '',
      attachments: target && this.describeMedia(target) ? 1 : 0,
      sticker: null,
    };
  }

  async sendMessage(chatId, content, msgId) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    if (!this.client) throw new Error('Telegram не подключён');
    if (!content || !content.trim()) return null;

    await this.peerFor(chatId);
    const raw = msgId ? this.raw.get(`${chatId}:${msgId}`) : null;
    const peer = raw?.inputChat || this.peers.get(String(chatId)) || (await this.client.getEntity(chatId));

    const text = content.slice(0, 4096);
    const sent = await this.client.sendMessage(peer, {
      message: text,
      replyTo: msgId ? Number(msgId) : undefined,
    });

    // Telegram не всегда присылает обновление о собственном отправленном
    // сообщении, поэтому интерфейс показывает его сразу.
    return this.normalizeSent(chatId, sent, text, this.buildReplyInfo(chatId, msgId));
  }

  // Редактирование своего сообщения.
  async editMessage(chatId, msgId, content) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    if (!this.client) throw new Error('Telegram не подключён');
    if (!content || !content.trim()) throw new Error('Пустое сообщение');

    await this.peerFor(chatId);
    const raw = this.raw.get(`${chatId}:${msgId}`) || null;
    const peer = raw?.inputChat || this.peers.get(String(chatId)) || (await this.client.getEntity(chatId));
    const text = content.slice(0, 4096);

    await this.client.editMessage(peer, { message: Number(msgId), text });
    if (raw) {
      // У Api.Message поле text доступно только для чтения — правим message.
      try {
        raw.message = text;
      } catch {
        /* поле может быть защищено от записи */
      }
    }
    return { id: String(msgId), content: text, edited: true };
  }

  // Удаление сообщений. revoke=true — «удалить у всех», false — «только у себя».
  async deleteMessages(chatId, msgIds, revoke = true) {
    if (!this.client) throw new Error('Telegram не подключён');
    const ids = (msgIds || [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n));
    if (!ids.length) return { ok: true };

    const entity = await this.peerFor(chatId);
    if (!entity) throw new Error('Чат не найден в Telegram');
    const peer = await this.client.getInputEntity(entity);
    await withTimeout(
      this.client.invoke(new Api.messages.DeleteMessages({ peer, id: ids, revoke: !!revoke })),
      30000,
      'TIMEOUT_DELETE'
    );

    for (const id of ids) {
      this.raw.delete(`${chatId}:${id}`);
      for (const key of [...this.mediaCache.keys()]) {
        if (key.startsWith(`${chatId}:${id}:`)) {
          const old = this.mediaCache.get(key);
          this.mediaCacheBytes -= old?.data?.length || 0;
          this.mediaCache.delete(key);
        }
      }
    }
    return { ok: true };
  }

  // Настоящая пересылка сообщений Telegram → Telegram.
  // В отличие от повторной отправки, Telegram сам помечает сообщение как
  // пересланное («Переслано от …») — так же, как это делает сам Telegram.
  async forwardMessages(toChatId, fromChatId, msgIds) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    if (!this.client) throw new Error('Telegram не подключён');
    const ids = (msgIds || [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n));
    if (!ids.length) throw new Error('Нечего пересылать');

    const fromEntity = await this.peerFor(fromChatId);
    const toEntity = await this.peerFor(toChatId);
    if (!fromEntity || !toEntity) throw new Error('Не удалось определить чат');

    const fromPeer = await this.client.getInputEntity(fromEntity);
    const toPeer = await this.client.getInputEntity(toEntity);
    const sent = await withTimeout(
      this.client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer,
          id: ids,
          toPeer,
          randomId: ids.map(() => BigInt(`-${Date.now()}${Math.floor(Math.random() * 100000)}`)),
        })
      ),
      60000,
      'TIMEOUT_FORWARD'
    );

    const raw = Array.isArray(sent.updates)
      ? sent.updates.find(
          (u) => u.className === 'UpdateNewMessage' || u.className === 'UpdateNewChannelMessage'
        )?.message
      : null;
    let media = null;
    try {
      media = raw ? this.describeMedia(raw) : null;
    } catch {
      media = null;
    }
    const text = raw?.text || raw?.message || '';
    return this.normalizeSent(toChatId, raw, text, null, media ? [media] : [], true);
  }

  // Отправка файла (для пересылки медиа между источниками и вложений).
  // GramJS сам определяет тип: фото, видео, аудио или документ.
  async sendFile(chatId, filePath, caption = '', replyTo = null) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    if (!this.client) throw new Error('Telegram не подключён');
    await this.peerFor(chatId);
    const peer = this.peers.get(String(chatId)) || (await this.client.getEntity(chatId));
    const reply = replyTo ? Number(replyTo) : undefined;
    let sent;
    try {
      sent = await withTimeout(
        this.client.sendFile(peer, { file: filePath, caption: caption || '', replyTo: reply }),
        180000,
        'TIMEOUT_SENDFILE'
      );
    } catch (e) {
      // Telegram не смог обработать картинку (битый/слишком маленький файл) —
      // отправляем его обычным документом, чтобы пересылка не терялась.
      if (!/IMAGE_PROCESS_FAILED|PHOTO_|MEDIA_EMPTY|WEBPAGE/i.test(e.message || '')) throw e;
      sent = await withTimeout(
        this.client.sendFile(peer, { file: filePath, caption: caption || '', forceDocument: true, replyTo: reply }),
        180000,
        'TIMEOUT_SENDFILE'
      );
    }
    // Показываем отправленное медиа сразу (фото/видео/файл).
    let media = null;
    try {
      media = this.describeMedia(sent);
    } catch {
      media = null;
    }
    return this.normalizeSent(chatId, sent, caption, null, media ? [media] : []);
  }

  // Отправка гифки/анимации.
  //
  // Анимацией Telegram считает только настоящие GIF-файлы: если отправить
  // .gif с атрибутом DocumentAttributeAnimated (и без forceDocument), сервер
  // сам конвертирует его в беззвучный MP4 и сохранит атрибут «анимация».
  // Для остальных форматов (mp4/webm и т.п.) просто отправляем обычное медиа:
  // пометить произвольный mp4 гифкой через API нельзя — сервер снимает
  // DocumentAttributeAnimated, и файл остаётся обычным видео.
  async sendAnimation(chatId, filePath, caption = '', replyTo = null) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    if (!this.client) throw new Error('Telegram не подключён');
    if (!/\.gif$/i.test(filePath)) return this.sendFile(chatId, filePath, caption, replyTo);
    await this.peerFor(chatId);
    const peer = this.peers.get(String(chatId)) || (await this.client.getEntity(chatId));
    const reply = replyTo ? Number(replyTo) : undefined;
    let sent;
    try {
      sent = await withTimeout(
        this.client.sendFile(peer, {
          file: filePath,
          caption: caption || '',
          attributes: [new Api.DocumentAttributeAnimated()],
          supportsStreaming: true,
          replyTo: reply,
        }),
        180000,
        'TIMEOUT_SENDANIM'
      );
    } catch (e) {
      // Гифка не распозналась сервером (битая/статичная) — шлём как обычный файл.
      if (!/IMAGE_PROCESS_FAILED|PHOTO_|MEDIA_EMPTY|WEBPAGE|ANIMATED/i.test(e.message || '')) throw e;
      return this.sendFile(chatId, filePath, caption, replyTo);
    }
    let media = null;
    try {
      media = this.describeMedia(sent);
    } catch {
      media = null;
    }
    return this.normalizeSent(chatId, sent, caption, null, media ? [media] : []);
  }

  async shutdown(silent = false) {
    this.shuttingDown = true;
    this.cancelPending();
    const client = this.client;
    this.client = null;
    try {
      if (client) {
        client.removeEventHandler?.(this.handler);
        if (this.statusHandler) client.removeEventHandler?.(this.statusHandler);
        await withTimeout(client.disconnect(), 5000, 'TIMEOUT_DISCONNECT').catch(() => {});
      }
    } catch {
      /* игнорируем */
    }
    if (!silent) {
      this.me = null;
      this.session = '';
      this.setStatus('Telegram не подключён', 'disconnected');
    }
  }

  async logout() {
    try {
      if (this.client) await withTimeout(this.client.logOut(), 8000, 'TIMEOUT_LOGOUT');
    } catch {
      /* всё равно отключаемся локально */
    }
    await this.shutdown(true);
    this.me = null;
    this.session = '';
    this.setStatus('Telegram не подключён', 'disconnected');
  }

  async cancelLogin() {
    this.cancelling = true;
    await this.shutdown(true);
    this.me = null;
    this.setStatus('Вход отменён', 'disconnected');
  }
}

module.exports = { TgClient, displayName };
