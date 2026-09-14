const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');

const instanceLock = app.requestSingleInstanceLock({ cwd: process.cwd() });
if (!instanceLock) app.quit();

let mainWindow;
const stickyWindows = new Map();

app.on('second-instance', (_event, argv, cwd) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('second-instance', { argv, cwd });
});

app.whenReady().then(async () => {
  const { ensureBroker, brokerRequest } = await import('../core/broker-client.mjs');
  const { githubContext } = await import('../core/repo-config.mjs');
  await ensureBroker();

  ipcMain.handle('broker:request', (_event, request) => brokerRequest(request.path, request.options));
  ipcMain.handle('app:context', async () => {
    const context = { cwd: process.cwd(), platform: process.platform };
    try { context.github = await githubContext(process.cwd()); }
    catch (error) { context.githubError = error.message; }
    return context;
  });
  ipcMain.handle('sticky:open', async (_event, note = {}) => openSticky(note, brokerRequest));
  ipcMain.handle('sticky:bounds', (event) => BrowserWindow.fromWebContents(event.sender)?.getBounds());

  mainWindow = createWindow();
  mainWindow.on('closed', () => { mainWindow = null; });
  app.on('activate', () => { if (!mainWindow) mainWindow = createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#f5f1e8',
    title: 'LocalBoard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.loadFile(path.join(__dirname, 'ui', 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return window;
}

async function openSticky(note, brokerRequest) {
  const saved = await brokerRequest('/v1/notes', { method: 'POST', body: note });
  if (stickyWindows.has(saved.id)) {
    stickyWindows.get(saved.id).focus();
    return saved;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    x: saved.x ?? area.x + area.width - saved.width - 24,
    y: saved.y ?? area.y + 24,
    width: saved.width,
    height: saved.height,
    minWidth: 220,
    minHeight: 180,
    frame: false,
    transparent: false,
    alwaysOnTop: saved.alwaysOnTop,
    skipTaskbar: false,
    backgroundColor: saved.color,
    title: saved.title,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  stickyWindows.set(saved.id, window);
  window.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: { sticky: '1', id: saved.id } });
  window.on('closed', () => stickyWindows.delete(saved.id));
  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const bounds = window.getBounds();
      brokerRequest('/v1/notes', { method: 'POST', body: { id: saved.id, ...bounds } }).catch(() => {});
    }, 200);
  };
  window.on('move', saveBounds);
  window.on('resize', saveBounds);
  return saved;
}
