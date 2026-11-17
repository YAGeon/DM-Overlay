'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('api', {
  // состояние
  getState: () => ipcRenderer.invoke('state:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  clearHistory: (source) => ipcRenderer.invoke('history:clear', source),

  // Discord
  discordLogin: (token) => ipcRenderer.invoke('discord:login', token),
  discordLogout: () => ipcRenderer.invoke('discord:logout'),

  // Telegram
  telegramLogin: (payload) => ipcRenderer.invoke('telegram:login', payload),
  telegramSubmit: (value) => ipcRenderer.invoke('telegram:submit', value),
  telegramQrCancel: () => ipcRenderer.invoke('telegram:qrCancel'),
  telegramLogout: () => ipcRenderer.invoke('telegram:logout'),

  // Discord
  discordSearchUsers: (query) => ipcRenderer.invoke('discord:searchUsers', query),
  discordOpenDm: (userId) => ipcRenderer.invoke('discord:openDm', userId),
  discordGetUser: (userId) => ipcRenderer.invoke('discord:getUser', userId),

  // Telegram
  telegramAvatar: (userId) => ipcRenderer.invoke('telegram:avatar', userId),
  telegramSearchUsers: (query) => ipcRenderer.invoke('telegram:searchUsers', query),
  telegramOpenDm: (userId) => ipcRenderer.invoke('telegram:openDm', userId),
  telegramPeerName: (payload) => ipcRenderer.invoke('telegram:peerName', payload),
  telegramStatuses: (ids) => ipcRenderer.invoke('telegram:statuses', ids),

  // сообщения
  send: (payload) => ipcRenderer.invoke('message:send', payload),
  edit: (payload) => ipcRenderer.invoke('message:edit', payload),
  forward: (payload) => ipcRenderer.invoke('message:forward', payload),
  deleteMessage: (payload) => ipcRenderer.invoke('message:delete', payload),
  openMedia: (payload) => ipcRenderer.invoke('media:open', payload),
  fetchMedia: (payload) => ipcRenderer.invoke('media:fetch', payload),

  // чаты
  chatDelete: (payload) => ipcRenderer.invoke('chat:delete', payload),
  chatIgnore: (payload) => ipcRenderer.invoke('chat:ignore', payload),
  chatUnignore: (payload) => ipcRenderer.invoke('chat:unignore', payload),

  // стикеры и эмодзи
  stickersList: (source) => ipcRenderer.invoke('stickers:list', source),
  stickerSend: (payload) => ipcRenderer.invoke('sticker:send', payload),
  stickerThumb: (id) => ipcRenderer.invoke('telegram:stickerThumb', id),

  // гифки
  gifSearch: (payload) => ipcRenderer.invoke('gif:search', payload),
  mediaSendUrl: (payload) => ipcRenderer.invoke('media:sendUrl', payload),
  mediaPickFile: () => ipcRenderer.invoke('media:pickFile'),
  mediaSendFile: (payload) => ipcRenderer.invoke('media:sendFile', payload),
  mediaSendBuffer: (payload) => ipcRenderer.invoke('media:sendBuffer', payload),

  // музыка
  musicSearch: (query) => ipcRenderer.invoke('music:search', query),
  musicResolve: (url) => ipcRenderer.invoke('music:resolve', url),
  musicStream: (id) => ipcRenderer.invoke('music:stream', id),
  musicRecommend: (seedId) => ipcRenderer.invoke('music:recommend', seedId),
  musicRepair: (ids) => ipcRenderer.invoke('music:repair', ids),
  musicUpdate: () => ipcRenderer.invoke('music:update'),

  // окно
  minimize: () => ipcRenderer.invoke('win:minimize'),
  close: () => ipcRenderer.invoke('win:close'),
  setOpacity: (value) => ipcRenderer.invoke('win:setOpacity', value),

  // прочее
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  openUrl: (url) => ipcRenderer.invoke('app:openUrl', url),
  testMessage: (source) => ipcRenderer.invoke('app:testMessage', source),

  // события
  onMessage: subscribe('message'),
  onStatus: subscribe('status'),
  onError: subscribe('error'),
  onMe: subscribe('me'),
  onConfig: subscribe('config'),
  onTgAuth: subscribe('tg:auth'),
  onTgQr: subscribe('tg:qr'),
  onTgUserStatus: subscribe('tg:userStatus'),
  onMusicStatus: subscribe('music:status'),
});
