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

  // provider (the key never travels back to the renderer)
  providerGet: () => ipcRenderer.invoke('provider:get'),
  providerSet: (patch) => ipcRenderer.invoke('provider:set', patch),
  providerClear: () => ipcRenderer.invoke('provider:clear'),
  providerTest: (cfg) => ipcRenderer.invoke('provider:test', cfg),

  // sandbox: readiness and the agent execution environment itself
  sandboxStatus: () => ipcRenderer.invoke('sandbox:status'),
  sandboxCreate: (opts) => ipcRenderer.invoke('sandbox:create', opts),
  sandboxExec: (payload) => ipcRenderer.invoke('sandbox:exec', payload),
  sandboxList: () => ipcRenderer.invoke('sandbox:list'),
  sandboxRemove: (name) => ipcRenderer.invoke('sandbox:remove', name),
  sandboxInspect: (name) => ipcRenderer.invoke('sandbox:inspect', name),
  sandboxHostHealth: () => ipcRenderer.invoke('sandbox:host-health'),
  sandboxCommands: (limit) => ipcRenderer.invoke('sandbox:commands', limit),
  sandboxInstallWatch: () => ipcRenderer.invoke('sandbox:install-watch'),
  sandboxWatchStatus: () => ipcRenderer.invoke('sandbox:watch-status'),
  sandboxProcesses: (name) => ipcRenderer.invoke('sandbox:processes', name),
  sandboxLogPath: () => ipcRenderer.invoke('sandbox:log-path'),
  sandboxOpenLog: () => ipcRenderer.invoke('sandbox:open-log'),
  sandboxRunAgent: (payload) => ipcRenderer.invoke('sandbox:run-agent', payload),

  // customisation: MCP definitions and the built-in guide
  customizeGuide: () => ipcRenderer.invoke('customize:guide'),
  customizeTemplate: (opts) => ipcRenderer.invoke('customize:template', opts),
  customizeApply: (opts) => ipcRenderer.invoke('customize:apply', opts),
  customizeCatalogue: () => ipcRenderer.invoke('customize:catalogue'),

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
  // `invoke`, not `send`: bringing a hidden guest back can fail (its window may be
  // gone), and the caller has to be able to tell that apart from success.
  layoutGuest: (id, rect) => ipcRenderer.invoke('guest:layout', { id, rect }),
  stopGuest: (id) => ipcRenderer.invoke('guest:stop', id),
  openVault: () => ipcRenderer.invoke('guest:open-vault'),
  onGuestExit: (handler) => on('guest:exit', handler),
});
