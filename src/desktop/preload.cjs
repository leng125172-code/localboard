const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localboard', {
  request: (path, options = {}) => ipcRenderer.invoke('broker:request', { path, options }),
  context: (cwd, refresh = false) => ipcRenderer.invoke('app:context', cwd, refresh),
  ready: () => ipcRenderer.invoke('app:ready'),
  openSticky: (note) => ipcRenderer.invoke('sticky:open', note),
  stickyPreferences: (note) => ipcRenderer.invoke('sticky:preferences', note),
  githubAuth: (action, account) => ipcRenderer.invoke('github:auth', action, account),
  bounds: () => ipcRenderer.invoke('sticky:bounds'),
  mainWindowAction: (action) => ipcRenderer.invoke('main-window:action', action),
  stickyWindow: (action, payload = {}) => ipcRenderer.invoke('sticky:window', action, payload),
  stickyPointer: (inside) => ipcRenderer.invoke('sticky:pointer', Boolean(inside)),
  applyAppearance: (settings = {}) => ipcRenderer.invoke('appearance:apply', settings),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  onSecondInstance: (callback) => subscribe('second-instance', callback),
  onStickyDockChanged: (callback) => subscribe('sticky:dock-changed', callback),
  onStickyNavigate: (callback) => subscribe('sticky:navigate', callback)
});

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
