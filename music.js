'use strict';

/**
 * Музыка из YouTube без рекламы.
 *
 * Аудио достаётся через yt-dlp: получаем прямую ссылку на аудио-дорожку и
 * отдаём её в окно — оно играет обычным <audio>, без рекламы и без видео.
 * Если YouTube что-то поменяет и ссылку получить не удастся, окно само
 * переключится на встроенный плеер YouTube (см. renderer.js).
 *
 * yt-dlp.exe лежит рядом в папке bin. При первом запуске копия кладётся в
 * папку данных пользователя — её и обновляем кнопкой «Обновить yt-dlp».
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

const SEP = '\u001f';
const FIELDS = ['%(id)s', '%(title)s', '%(uploader)s', '%(duration)s', '%(is_live)s'];
const PRINT = FIELDS.join(SEP);
const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dm-overlay';

const bundledPath = (() => {
  // В установленной версии приложение лежит в app.asar, а yt-dlp.exe вынесен
  // в app.asar.unpacked (запускать .exe прямо из asar нельзя).
  const unpacked = process.resourcesPath
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'yt-dlp.exe')
    : null;
  if (unpacked && isFile(unpacked)) return unpacked;
  return path.join(__dirname, 'bin', 'yt-dlp.exe');
})();
const binDir = path.join(app.getPath('userData'), 'bin');
const localPath = path.join(binDir, 'yt-dlp.exe');

let binary = null;
let lastError = '';
const cache = new Map(); // id -> { url, at }

function isFile(p) {
  try {
    return fs.statSync(p).size > 1024;
  } catch {
    return false;
  }
}

function pickBinary() {
  if (isFile(localPath)) return localPath;
  if (isFile(bundledPath)) {
    try {
      fs.mkdirSync(binDir, { recursive: true });
      fs.copyFileSync(bundledPath, localPath);
      return localPath;
    } catch {
      return bundledPath;
    }
  }
  return null;
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('слишком много перенаправлений'));
    https
      .get(url, { headers: { 'User-Agent': UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(downloadFile(res.headers.location, dest, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const tmp = `${dest}.tmp`;
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              fs.renameSync(tmp, dest);
            } catch (e) {
              reject(e);
              return;
            }
            resolve();
          });
        });
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

async function ensureBinary() {
  if (binary && isFile(binary)) return binary;

  binary = pickBinary();
  if (binary) {
    lastError = '';
    return binary;
  }

  try {
    fs.mkdirSync(binDir, { recursive: true });
    await downloadFile(DOWNLOAD_URL, localPath);
    binary = localPath;
    lastError = '';
  } catch (e) {
    binary = null;
    lastError = `Не удалось скачать yt-dlp: ${e.message}`;
  }
  return binary;
}

function run(args, timeout = 60000) {
  return new Promise((resolve) => {
    if (!binary) {
      resolve({ ok: false, error: lastError || 'yt-dlp недоступен' });
      return;
    }
    let child;
    try {
      child = spawn(binary, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }

    let out = '';
    let err = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* пусто */
      }
      finish({ ok: false, error: 'превышено время ожидания' });
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, stdout: out, stderr: err });
        return;
      }
      const tail = String(err || out || '')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-3)
        .join(' ');
      finish({ ok: false, error: tail || `yt-dlp завершился с кодом ${code}` });
    });
  });
}

function normalize(raw) {
  const dur = Number(raw.duration);
  const title = raw.title && raw.title !== 'NA' ? raw.title : 'Без названия';
  return {
    id: raw.id,
    title: String(title).slice(0, 300),
    uploader: raw.uploader && raw.uploader !== 'NA' ? String(raw.uploader).slice(0, 160) : '',
    duration: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 0,
    live: raw.live === 'True' || raw.live === 'true',
  };
}

function parse(text) {
  const items = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [id, title, uploader, duration, live] = line.split(SEP);
    if (!id || id === 'NA' || !/^[\w-]{6,20}$/.test(id)) continue;
    items.push(normalize({ id, title, uploader, duration, live }));
  }
  return items;
}

function isYoutubeUrl(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase().replace(/^www\./, '');
    return (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtu.be' ||
      host === 'youtube-nocookie.com'
    );
  } catch {
    return false;
  }
}

// --encoding utf-8 обязателен: иначе yt-dlp на Windows отдаёт текст в кодировке
// консоли (cp1251), и русские названия превращаются в «кракозябры».
const BASE = ['--no-config', '--no-warnings', '--ignore-errors', '--no-progress', '--encoding', 'utf-8'];

// «Top 100 Songs» из YouTube Music — источник популярных песен для рекомендаций.
const CHART_PLAYLIST = 'PL4fGSI1pDJn6O1LS0XSdF3RyO0Rq_LDeI';
const PLAYLIST_QUERIES = ['новинки музыки', 'популярные хиты', 'chill музыка'];

async function search(query, limit = 20) {
  await ensureBinary();
  const q = String(query || '').trim();
  if (!q) return { ok: true, items: [] };
  const n = Math.min(40, Math.max(1, Number(limit) || 20));
  const res = await run([...BASE, '--flat-playlist', '--print', PRINT, `ytsearch${n}:${q}`], 60000);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, items: parse(res.stdout) };
}

async function resolve(url) {
  await ensureBinary();
  const u = String(url || '').trim();
  if (!isYoutubeUrl(u)) return { ok: false, error: 'Это не похоже на ссылку YouTube' };
  const res = await run(
    [...BASE, '--flat-playlist', '--playlist-end', '100', '--print', PRINT, u],
    90000
  );
  if (!res.ok) return { ok: false, error: res.error };
  const items = parse(res.stdout);
  if (!items.length) return { ok: false, error: 'Не удалось прочитать ссылку' };
  return { ok: true, items, playlist: items.length > 1 };
}

async function stream(id) {
  await ensureBinary();
  const vid = String(id || '').trim();
  if (!/^[\w-]{6,20}$/.test(vid)) return { ok: false, error: 'неверный идентификатор' };

  const hit = cache.get(vid);
  if (hit && Date.now() - hit.at < 20 * 60 * 1000) return { ok: true, url: hit.url };

  const res = await run(
    [
      ...BASE,
      '--no-playlist',
      '-f',
      'bestaudio[ext=m4a]/bestaudio/best',
      '-g',
      `https://www.youtube.com/watch?v=${vid}`,
    ],
    90000
  );
  if (!res.ok) return { ok: false, error: res.error };

  const url = res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'не удалось получить аудио' };

  cache.set(vid, { url, at: Date.now() });
  return { ok: true, url };
}

async function chart() {
  await ensureBinary();
  const res = await run(
    [...BASE, '--flat-playlist', '--playlist-end', '30', '--print', PRINT, `https://www.youtube.com/playlist?list=${CHART_PLAYLIST}`],
    90000
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, items: parse(res.stdout) };
}

// Похожие песни («радио») для указанного трека.
async function related(id) {
  await ensureBinary();
  const vid = String(id || '').trim();
  if (!/^[\w-]{6,20}$/.test(vid)) return { ok: false, error: 'неверный идентификатор' };
  const res = await run(
    [...BASE, '--flat-playlist', '--playlist-end', '25', '--print', PRINT, `https://www.youtube.com/watch?v=${vid}&list=RD${vid}`],
    90000
  );
  if (!res.ok) return { ok: false, error: res.error };
  const items = parse(res.stdout).filter((it) => it.id !== vid);
  return { ok: true, items };
}

// Поиск плейлистов YouTube (фильтр «Плейлист» в результатах поиска).
async function searchPlaylists(query, limit = 6) {
  await ensureBinary();
  const q = String(query || '').trim();
  if (!q) return [];
  const res = await run(
    [...BASE, '--flat-playlist', '--playlist-end', String(limit), '--print', `%(id)s${SEP}%(title)s${SEP}%(ie_key)s`,
      `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAw%3D%3D`],
    60000
  );
  if (!res.ok) return [];
  const out = [];
  const seen = new Set();
  for (const line of String(res.stdout || '').split(/\r?\n/)) {
    const [id, title, ie] = line.split(SEP);
    if (!id || seen.has(id)) continue;
    if (ie && ie !== 'YoutubeTab') continue;
    if (!/^[\w-]{20,40}$/.test(id)) continue;
    seen.add(id);
    out.push({ id, title: String(title || 'Плейлист').slice(0, 200) });
  }
  return out;
}

async function recommend(seedId) {
  await ensureBinary();
  const seed = /^[\w-]{6,20}$/.test(String(seedId || '').trim()) ? String(seedId).trim() : '';
  const songsPromise = seed ? related(seed) : chart();
  const listsPromise = (async () => {
    const merged = [];
    const seen = new Set();
    for (const q of PLAYLIST_QUERIES) {
      for (const pl of await searchPlaylists(q, 4)) {
        if (seen.has(pl.id)) continue;
        seen.add(pl.id);
        merged.push(pl);
        if (merged.length >= 8) break;
      }
      if (merged.length >= 8) break;
    }
    return merged;
  })();

  let songsRes = await songsPromise;
  let songs = songsRes.ok ? songsRes.items : [];
  if (!songs.length && seed) {
    const c = await chart();
    if (c.ok) songs = c.items;
  }
  const playlists = await listsPromise;
  return { ok: true, songs, playlists, seed: seed || '' };
}

// Починка «кракозябр» в сохранённых названиях.
//
// Раньше yt-dlp отдавал текст в кодировке консоли (cp1251), и русские названия
// портились. Заново запрашиваем метаданные по id и возвращаем исправленное.
async function repair(ids) {
  await ensureBinary();
  const list = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^[\w-]{6,20}$/.test(id))
    .slice(0, 60);
  if (!list.length) return { ok: true, items: [] };
  const res = await run(
    [...BASE, '--no-playlist', '--print', PRINT, ...list.map((id) => `https://www.youtube.com/watch?v=${id}`)],
    120000
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, items: parse(res.stdout) };
}

async function update() {
  await ensureBinary();
  if (!binary) return { ok: false, error: lastError || 'yt-dlp недоступен' };
  const res = await run([...BASE, '-U'], 180000);
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.ok, output: output.slice(-800), error: res.error };
}

function status() {
  return { ready: !!binary && isFile(binary), error: lastError };
}

module.exports = { ensureBinary, search, resolve, stream, update, status, isYoutubeUrl, recommend, repair };
