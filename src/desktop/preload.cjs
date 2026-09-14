const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localboard', {
  request: (path, options = {}) => ipcRenderer.invoke('broker:request', { path, options }),
  context: () => ipcRenderer.invoke('app:context'),
  openSticky: (note) => ipcRenderer.invoke('sticky:open', note),
  bounds: () => ipcRenderer.invoke('sticky:bounds'),
  onSecondInstance: (callback) => ipcRenderer.on('second-instance', (_event, payload) => callback(payload))
});

