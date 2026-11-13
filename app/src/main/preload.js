'use strict';

/**
 * Preload — the only bridge between the shell UI and the main process.
 * Nothing here exposes Node or the filesystem: just the handful of typed
 * channels the shell needs.
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, handler) => {
  const wrapped = (_event, ...args) => handler(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('deck', {
  // shell state
  getState: () => ipcRenderer.invoke('deck:get-state'),
  setState: (patch) => ipcRenderer.invoke('deck:set-state', patch),

  // layout
  setContentBounds: (rect) => ipcRenderer.send('deck:content-bounds', rect),
  setView: (view) => ipcRenderer.send('deck:set-view', view),

  // agent server
  serverStatus: () => ipcRenderer.invoke('deck:server-status'),
  reloadAgent: () => ipcRenderer.invoke('deck:reload-agent'),
  restartAgent: () => ipcRenderer.invoke('deck:restart-agent'),
  onServerStatus: (handler) => on('deck:server-status', handler),

  // claude terminal
  startClaude: (opts) => ipcRenderer.invoke('claude:start', opts),
  stopClaude: () => ipcRenderer.invoke('claude:stop'),
  writeClaude: (data) => ipcRenderer.send('claude:write', data),
  resizeClaude: (size) => ipcRenderer.send('claude:resize', size),
  onClaudeData: (handler) => on('claude:data', handler),
  onClaudeExit: (handler) => on('claude:exit', handler),

  // dialogs / environment
  pickDirectory: () => ipcRenderer.invoke('deck:pick-directory'),
  openExternal: (url) => ipcRenderer.invoke('deck:open-external', url),
  openLog: () => ipcRenderer.invoke('deck:open-log'),
  recentLog: () => ipcRenderer.invoke('deck:recent-log'),
  environment: () => ipcRenderer.invoke('deck:environment'),
  onEnvironment: (handler) => on('deck:environment', handler),
  onState: (handler) => on('deck:state', handler),

  // guest front ends (real applications embedded in this window)
  guestStatus: () => ipcRenderer.invoke('guest:status'),
  showGuest: (id, rect) => ipcRenderer.invoke('guest:show', { id, rect }),
  hideGuest: (id) => ipcRenderer.invoke('guest:hide', id),
  layoutGuest: (id, rect) => ipcRenderer.send('guest:layout', { id, rect }),
  stopGuest: (id) => ipcRenderer.invoke('guest:stop', id),
  openVault: () => ipcRenderer.invoke('guest:open-vault'),
  onGuestExit: (handler) => on('guest:exit', handler),
});
