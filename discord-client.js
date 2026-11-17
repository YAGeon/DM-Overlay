'use strict';

/**
 * Минимальный клиент Discord для чтения личных сообщений.
 * Работает с токеном обычного аккаунта (selfbot).
 *
 * Использует только официальный HTTP API и Gateway, без сторонних обёрток.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) discord/1.0.9020 Chrome/131.0.0.0 Electron/33.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLOSE_REASONS = {
  4000: 'Неизвестная ошибка соединения',
  4001: 'Отправлен неизвестный op-код',
  4002: 'Отправлен неверный payload',
  4003: 'Не авторизован',
  4004: 'Неверный токен — проверь его в настройках',
  4005: 'Уже идёт авторизация',
  4007: 'Неверный sequence',
  4008: 'Слишком быстрые запросы к шлюзу',
  4009: 'Сессия истекла',
  4010: 'Неверный shard',
  4011: 'Слишком большая нагрузка на шард',
  4012: 'Неизвестная версия шлюза',
  4013: 'Неверный intent',
  4014: 'Запрещённый intent',
};

class AuthError extends Error {}

class DiscordClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.token = null;
    this.me = null;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.hbTimer = null;
    this.hbAck = true;
    this.manualClose = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.dmChannels = new Map(); // channelId -> channel object
    this.users = new Map(); // userId -> user object
    this.watch = new Set();
    this.watchNames = new Set();
    this.showOwn = true;
    this.allowSend = false;
  }

  // ------------------------------------------------------------------ HTTP

  async api(path, { method = 'GET', body } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(API + path, {
        method,
        headers: {
          Authorization: this.token,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          'X-Super-Properties': Buffer.from(
            JSON.stringify({
              os: 'Windows',
              browser: 'Chrome',
              device: '',
              system_locale: 'ru-RU',
              browser_user_agent: USER_AGENT,
              browser_version: '131.0.0.0',
              os_version: '10',
              referrer: '',
              referring_domain: '',
              release_channel: 'stable',
              client_build_number: 300000,
              client_event_source: null,
            })
          ).toString('base64'),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        let wait = 2;
        try {
          const j = await res.json();
          wait = (j.retry_after || 1) + 0.25;
        } catch {}
        await sleep(wait * 1000);
        continue;
      }

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        const err = new Error(data?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = data?.code;
        throw err;
      }
      return data;
    }
    throw new Error('Discord отвечает слишком медленно, попробуй позже');
  }

  // ---------------------------------------------------------------- login

  async login(token) {
    this.logout(true);
    this.token = (token || '').trim().replace(/^Bot\s+/i, '');
    this.manualClose = false;

    if (!this.token) {
      this.emit('error', 'Токен не указан');
      this.emit('status', { state: 'disconnected', text: 'Нет токена' });
      return;
    }

    if (!/^[\x21-\x7e]+$/.test(this.token)) {
      const msg = 'В токене недопустимые символы. Скопируй его заново из Discord.';
      this.token = null;
      this.emit('error', msg);
      this.emit('status', { state: 'error', text: msg });
      return;
    }

    if (this.token.length < 30) {
      const msg = 'Токен слишком короткий — похоже, скопирована не вся строка.';
      this.token = null;
      this.emit('error', msg);
      this.emit('status', { state: 'error', text: msg });
      return;
    }

    this.emit('status', { state: 'connecting', text: 'Проверяю токен…' });

    try {
      this.me = await this.api('/users/@me');
      this.emit('me', {
        id: this.me.id,
        username: this.me.username,
        globalName: this.me.global_name || this.me.username,
        avatar: avatarUrl(this.me, 64),
      });

      await this.loadDmChannels();
      this.connect();
    } catch (e) {
      this.token = null;
      this.me = null;
      const msg =
        e instanceof AuthError || e.status === 401
          ? 'Неверный токен. Скопируй его заново из Discord.'
          : `Не удалось подключиться: ${e.message}`;
      this.emit('error', msg);
      this.emit('status', { state: 'error', text: msg });
    }
  }

  async loadDmChannels() {
    try {
      const channels = await this.api('/users/@me/channels');
      for (const ch of channels) {
        this.dmChannels.set(ch.id, ch);
        for (const r of ch.recipients || []) this.users.set(r.id, r);
      }
    } catch (e) {
      if (e.status === 401) throw new AuthError(e.message);
    }
  }

  // ---------------------------------------------- новый чат (кому ещё не писал)

  // Поиск пользователей.
  //
  // Discord не даёт обычному токену искать участников серверов
  // (`/guilds/{id}/members/search` отвечает 403), поэтому ищем среди друзей и
  // среди людей, с которыми уже есть личные каналы. Для всех остальных
  // предусмотрен ручной ввод ID.
  async searchUsers(query) {
    const q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return [];

    const found = new Map();
    const add = (u) => {
      if (!u || !u.id || u.id === this.me?.id || u.bot) return;
      if (found.has(u.id)) return;
      const haystack = `${u.username || ''} ${u.global_name || ''}`.toLowerCase();
      if (!haystack.includes(q)) return;
      found.set(u.id, {
        id: u.id,
        username: u.username || '',
        globalName: u.global_name || u.username || 'Пользователь',
        avatar: avatarUrl(u, 64),
        guild: '',
      });
    };

    try {
      const rel = await this.api('/users/@me/relationships');
      for (const r of rel || []) {
        if (r.type === 1) add(r.user); // 1 = друг
      }
    } catch {
      // Список друзей недоступен — не страшно, ниже добавим личные каналы.
    }

    for (const ch of this.dmChannels.values()) {
      for (const r of ch.recipients || []) add(r);
    }

    return Array.from(found.values()).slice(0, 30);
  }

  // Получить пользователя по ID (для ручного ввода).
  async getUser(userId) {
    const id = String(userId || '').trim();
    if (!/^\d{15,25}$/.test(id)) throw new Error('ID пользователя должен состоять из 15–25 цифр');
    const u = await this.api(`/users/${id}`);
    this.users.set(u.id, u);
    return {
      id: u.id,
      username: u.username,
      globalName: u.global_name || u.username,
      avatar: avatarUrl(u, 64),
      guild: '',
    };
  }

  // Открыть (создать) личный канал с пользователем.
  async openDm(recipientId) {
    const id = String(recipientId || '').trim();
    if (!/^\d{15,25}$/.test(id)) throw new Error('ID пользователя должен состоять из 15–25 цифр');
    if (id === this.me?.id) throw new Error('Это твой собственный ID');
    const channel = await this.api('/users/@me/channels', {
      method: 'POST',
      body: { recipient_id: id },
    });
    this.dmChannels.set(channel.id, channel);
    for (const r of channel.recipients || []) this.users.set(r.id, r);
    const recipient = (channel.recipients || []).find((r) => r.id === id) || {};
    return {
      channelId: String(channel.id),
      channelType: channel.type ?? 1,
      user: {
        id: recipient.id || id,
        username: recipient.username || '',
        globalName: recipient.global_name || recipient.username || 'Новый чат',
        avatar: avatarUrl(recipient, 64),
      },
    };
  }

  // -------------------------------------------------------------- gateway

  connect() {
    if (this.manualClose) return;
    this.cleanupSocket();

    const ws = new WebSocket(GATEWAY, {
      headers: {
        'User-Agent': USER_AGENT,
        Origin: 'https://discord.com',
      },
    });
    this.ws = ws;
    this.hbAck = true;

    ws.on('open', () => {
      this.emit('status', { state: 'connecting', text: 'Подключаюсь к Discord…' });
    });

    ws.on('message', (raw) => {
      let pkt;
      try {
        pkt = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (pkt.s != null) this.seq = pkt.s;
      this.onPacket(pkt);
    });

    ws.on('close', (code, reason) => this.onClose(code, reason?.toString()));

    ws.on('error', (err) => {
      this.emit('status', {
        state: 'connecting',
        text: `Сеть: ${err.message}`,
      });
    });
  }

  onPacket(pkt) {
    switch (pkt.op) {
      case 10: {
        // HELLO
        const interval = pkt.d?.heartbeat_interval || 41250;
        this.startHeartbeat(interval);
        if (this.sessionId && this.seq != null) {
          this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.identify();
        }
        break;
      }
      case 11:
        this.hbAck = true;
        break;
      case 1:
        this.send({ op: 1, d: this.seq });
        break;
      case 7:
        this.emit('status', { state: 'connecting', text: 'Переподключаюсь…' });
        this.reconnect(true);
        break;
      case 9:
        this.sessionId = null;
        this.seq = null;
        setTimeout(() => {
          if (!this.manualClose) this.identify();
        }, 1000 + Math.random() * 4000);
        break;
      case 0:
        this.onDispatch(pkt.t, pkt.d);
        break;
      default:
        break;
    }
  }

  identify() {
    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: 16381,
        compress: false,
        properties: {
          os: 'Windows',
          browser: 'Chrome',
          device: '',
          system_locale: 'ru-RU',
          browser_user_agent: USER_AGENT,
          browser_version: '131.0.0.0',
          os_version: '10',
          referrer: '',
          referring_domain: '',
          release_channel: 'stable',
          client_build_number: 300000,
          client_event_source: null,
        },
        presence: { status: 'online', since: 0, activities: [], afk: false },
      },
    });
  }

  onDispatch(type, d) {
    if (type === 'READY') {
      this.sessionId = d.session_id;
      this.reconnectAttempt = 0;
      if (d.user) this.users.set(d.user.id, d.user);
      this.emit('status', {
        state: 'online',
        text: `Подключено как ${d.user?.global_name || d.user?.username || 'аккаунт'}`,
      });
      return;
    }

    if (type === 'RESUMED') {
      this.emit('status', {
        state: 'online',
        text: `Подключено как ${this.me?.global_name || this.me?.username || 'аккаунт'}`,
      });
      return;
    }

    if (type === 'MESSAGE_CREATE') {
      this.onIncoming(d).catch((e) => this.emit('error', `Ошибка обработки сообщения: ${e.message}`));
    }
  }

  async onIncoming(d) {
    if (!d || !d.author || !d.channel_id) return;
    if (d.guild_id) return; // только личные сообщения
    if (d.type !== 0 && d.type !== 19 && d.type !== 20 && d.type !== 21) return;

    const own = d.author.id === this.me?.id;
    if (own && !this.showOwn) return;

    let channel = this.dmChannels.get(d.channel_id);
    if (!channel) {
      try {
        channel = await this.api(`/channels/${d.channel_id}`);
        this.dmChannels.set(channel.id, channel);
        for (const r of channel.recipients || []) this.users.set(r.id, r);
      } catch {
        channel = null;
      }
    }

    this.users.set(d.author.id, d.author);

    if (!own && !this.matchesWatch(d.author)) return;

    // Цитата сообщения, на которое ответили. Если Discord не прислал
    // referenced_message, пробуем забрать его через REST.
    let replyTo = null;
    const ref = d.message_reference;
    const refId = ref?.message_id || d.referenced_message?.id;
    if (refId) {
      const refChannel = ref?.channel_id || d.channel_id;
      let source = d.referenced_message || null;
      if (!source) {
        try {
          source = await this.api(`/channels/${refChannel}/messages/${refId}`);
        } catch {
          source = null;
        }
      }
      replyTo = {
        id: String(refId),
        channelId: String(refChannel),
        author: source?.author
          ? source.author.global_name || source.author.username
          : 'Сообщение',
        authorId: source?.author?.id ? String(source.author.id) : '',
        content: source?.content || '',
        attachments: (source?.attachments || []).length,
        sticker: stickerInfo(source?.sticker_items?.[0]),
      };
    }

    const recipients = (channel?.recipients || []).filter((r) => r.id !== this.me?.id);
    const title = own
      ? recipients.map((r) => r.global_name || r.username).join(', ') || 'Личка'
      : d.author.global_name || d.author.username;

    this.emit('message', {
      id: d.id,
      channelId: d.channel_id,
      content: d.content || '',
      timestamp: d.timestamp,
      edited: !!d.edited_timestamp,
      own,
      channelType: channel?.type ?? 1,
      author: {
        id: d.author.id,
        username: d.author.username,
        globalName: d.author.global_name || d.author.username,
        avatar: avatarUrl(d.author, 64),
        bot: !!d.author.bot,
      },
      channelTitle: title,
      recipients: recipients.map((r) => ({
        id: r.id,
        name: r.global_name || r.username,
        avatar: avatarUrl(r, 64),
      })),
      attachments: (d.attachments || []).map((a) => ({
        id: a.id,
        url: a.url,
        proxyUrl: a.proxy_url,
        filename: a.filename,
        size: a.size,
        contentType: a.content_type || '',
        width: a.width,
        height: a.height,
      })),
      sticker: stickerInfo(d.sticker_items?.[0]),
      replyTo,
    });
  }

  matchesWatch(author) {
    if (!this.watch.size && !this.watchNames.size) return true;
    if (this.watch.has(author.id)) return true;
    const candidates = [author.username, author.global_name, `${author.username}`]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    return candidates.some((c) => this.watchNames.has(c));
  }

  setWatch(list, showOwn) {
    this.watch = new Set();
    this.watchNames = new Set();
    for (const raw of list || []) {
      const v = String(raw).trim().replace(/^@/, '');
      if (!v) continue;
      if (/^\d{15,25}$/.test(v)) this.watch.add(v);
      else this.watchNames.add(v.toLowerCase());
    }
    if (typeof showOwn === 'boolean') this.showOwn = showOwn;
  }

  // ------------------------------------------------------------- socket io

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {}
    }
  }

  startHeartbeat(interval) {
    clearInterval(this.hbTimer);
    const jitter = Math.random();
    setTimeout(() => {
      if (this.manualClose) return;
      this.hbAck = true;
      this.send({ op: 1, d: this.seq });
      this.hbTimer = setInterval(() => {
        if (!this.hbAck) {
          // соединение зависло
          this.reconnect(true);
          return;
        }
        this.hbAck = false;
        this.send({ op: 1, d: this.seq });
      }, interval);
    }, interval * jitter);
  }

  onClose(code, reason) {
    this.clearHeartbeat();
    if (this.manualClose) return;

    if (code === 4004 || code === 4003) {
      this.emit('error', CLOSE_REASONS[code] || 'Ошибка авторизации');
      this.emit('status', { state: 'error', text: CLOSE_REASONS[code] || 'Ошибка авторизации' });
      return;
    }

    const text = CLOSE_REASONS[code] || (reason ? `Код ${code}: ${reason}` : 'Соединение закрыто');
    this.emit('status', { state: 'connecting', text: `${text}. Переподключаюсь…` });
    this.reconnect(true);
  }

  reconnect(resume) {
    if (this.manualClose) return;
    if (!resume) this.sessionId = null;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt++;
    this.cleanupSocket();
    this.reconnectTimer = setTimeout(() => this.connect(), delay + Math.random() * 1000);
  }

  clearHeartbeat() {
    clearInterval(this.hbTimer);
    this.hbTimer = null;
  }

  cleanupSocket() {
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch {}
      this.ws = null;
    }
  }

  logout(silent = false) {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.hbTimer);
    this.cleanupSocket();
    this.sessionId = null;
    this.seq = null;
    if (!silent) {
      this.emit('status', { state: 'disconnected', text: 'Не подключено' });
    }
  }

  // ---------------------------------------------------------------- send

  async sendMessage(channelId, content, replyId) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    if (!content || !content.trim()) return null;
    const nonce = Date.now().toString();
    const body = { content: content.slice(0, 2000), nonce, tts: false };
    if (replyId) {
      body.message_reference = {
        message_id: String(replyId),
        channel_id: String(channelId),
        fail_if_not_exists: false,
      };
    }
    const msg = await this.api(`/channels/${channelId}/messages`, {
      method: 'POST',
      body,
    });
    return msg;
  }

  // Редактирование своего сообщения.
  async editMessage(channelId, messageId, content) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    if (!content || !content.trim()) throw new Error('Пустое сообщение');
    const msg = await this.api(`/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      body: { content: content.slice(0, 2000) },
    });
    return { id: String(msg?.id || messageId), content: msg?.content ?? content, edited: true };
  }

  // Удаление своего сообщения (в Discord — всегда «у всех»).
  // Разрешение на отправку тут не нужно: это управление своими сообщениями.
  async deleteMessage(channelId, messageId) {
    await this.api(`/channels/${channelId}/messages/${messageId}`, { method: 'DELETE' });
    return { ok: true };
  }

  // Загрузка файла (для пересылки медиа между источниками и вложений).
  async sendFile(channelId, buffer, filename, content, replyId) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    if (!buffer || !buffer.length) throw new Error('Пустой файл');

    const payload = { content: (content || '').slice(0, 2000) };
    if (replyId) {
      payload.message_reference = {
        message_id: String(replyId),
        channel_id: String(channelId),
        fail_if_not_exists: false,
      };
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      form.append('files[0]', new Blob([buffer]), String(filename || 'file'));

      const res = await fetch(`${API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: this.token, 'User-Agent': USER_AGENT },
        body: form,
      });

      if (res.status === 429) {
        let wait = 2;
        try {
          const j = await res.json();
          wait = (j.retry_after || 1) + 0.25;
        } catch {}
        await sleep(wait * 1000);
        continue;
      }

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const err = new Error(data?.message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    }
    throw new Error('Discord отвечает слишком медленно, попробуй позже');
  }

  // Стикеры серверов, доступные пользователю (для панели стикеров).
  // Берём только доступные стикеры (available !== false) — заблокированные
  // и платные (Nitro) не показываем и не пытаемся отправить в обход.
  // Discord не группирует стикеры по наборам в удобном для клиента виде,
  // поэтому отдаём один пак «Discord» — контракт совпадает с Telegram.
  async getStickers() {
    const guilds = await this.api('/users/@me/guilds');
    const stickers = [];
    for (const g of (guilds || []).slice(0, 40)) {
      try {
        const list = await this.api(`/guilds/${g.id}/stickers`);
        for (const s of list || []) {
          const info = stickerInfo(s);
          if (info) stickers.push(info);
        }
      } catch {
        /* нет доступа к стикерам сервера */
      }
      if (stickers.length >= 150) break;
    }
    const items = stickers.slice(0, 150);
    if (!items.length) return [];
    return [
      {
        id: 'discord',
        title: 'Discord',
        shortName: '',
        count: items.length,
        cover: items[0].id,
        emoji: '🎨',
        stickers: items,
      },
    ];
  }

  async sendSticker(channelId, stickerId) {
    if (!this.allowSend) throw new Error('Отправка сообщений выключена в настройках');
    const msg = await this.api(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: { sticker_ids: [String(stickerId)] },
    });
    return msg;
  }
}

// Описание стикера Discord: id, имя, формат и ссылка на изображение.
// Недоступные стикеры (available === false) пропускаем — их не отправить легально.
function stickerInfo(item) {
  if (!item || item.available === false) return null;
  const format = item.format_type ?? 1;
  // format_type: 1 — png, 2 — apng, 3 — lottie (json), 4 — gif
  const ext = format === 4 ? 'gif' : 'png';
  return {
    id: String(item.id),
    name: item.name || 'Стикер',
    format,
    url: `https://media.discordapp.net/stickers/${item.id}.${ext}?size=160`,
  };
}

function avatarUrl(user, size = 64) {
  if (!user) return null;
  if (!user.avatar) {
    const idx = user.discriminator && user.discriminator !== '0' ? Number(user.discriminator) % 5 : Number(user.id) % 5;
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }
  const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
}

module.exports = { DiscordClient, avatarUrl };
