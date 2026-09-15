const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localboard', {
  request: (path, options = {}) => ipcRenderer.invoke('broker:request', { path, options }),
  context: (cwd, refresh = false) => ipcRenderer.invoke('app:context', cwd, refresh),
  ready: () => ipcRenderer.invoke('app:ready'),
  openSticky: (note) => ipcRenderer.invoke('sticky:open', note),
  stickyPreferences: (note) => ipcRenderer.invoke('sticky:preferences', note),
  githubAuth: (action, account) => ipcRenderer.invoke('github:auth', action, account),
  bounds: () => ipcRenderer.invoke('sticky:bounds'),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  onSecondInstance: (callback) => ipcRenderer.on('second-instance', (_event, payload) => callback(payload))
});
