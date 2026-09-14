const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');

const instanceLock = app.requestSingleInstanceLock({ cwd: process.cwd() });
if (!instanceLock) app.quit();

let mainWindow;
let stickyWindow;

app.on('second-instance', (_event, argv, cwd) => {
  const target = mainWindow ?? stickyWindow;
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  mainWindow?.webContents.send('second-instance', { argv, cwd });
});

app.whenReady().then(async () => {
  const { ensureBroker, brokerRequest } = await import('../core/broker-client.mjs');
  const { inspectRepositoryContext } = await import('../core/repository-context.mjs');
  await ensureBroker();

  ipcMain.handle('broker:request', (_event, request) => brokerRequest(request.path, request.options));
  ipcMain.handle('app:context', async () => {
    const context = { cwd: process.cwd(), platform: process.platform };
    context.repository = await inspectRepositoryContext(process.cwd());
    if (context.repository.syncGitHub) {
      const [owner, repo] = context.repository.githubRepository.split('/');
      context.github = {
        owner,
        repo,
        ownerType: context.repository.github?.ownerType || 'user',
        projectOwner: context.repository.github?.owner || owner,
        projectNumber: Number(context.repository.github?.projectNumber || 0)
      };
    } else {
      context.githubError = `GitHub sync skipped: ${context.repository.syncReason}`;
    }
    return context;
  });
  ipcMain.handle('sticky:open', async (_event, note = {}) => openSticky(note, brokerRequest));
  ipcMain.handle('sticky:bounds', (event) => BrowserWindow.fromWebContents(event.sender)?.getBounds());
  ipcMain.handle('window:action', (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (action === 'minimize') window.minimize();
    else if (action === 'hide') window.hide();
    else return false;
    return true;
  });

  mainWindow = createWindow();
  mainWindow.on('closed', () => { mainWindow = null; });
  await openSticky({}, brokerRequest);
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
  const saved = await brokerRequest('/v1/notes', { method: 'POST', body: {
    ...note,
    id: 'codex-activity',
    title: 'Codex 执行便签',
    width: note.width ?? 380,
    height: note.height ?? 520,
    alwaysOnTop: true
  } });
  if (stickyWindow && !stickyWindow.isDestroyed()) {
    stickyWindow.show();
    stickyWindow.focus();
    return saved;
  }
  const area = screen.getPrimaryDisplay().workArea;
  stickyWindow = new BrowserWindow({
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
  stickyWindow.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: { sticky: 'activity', id: saved.id } });
  stickyWindow.on('closed', () => { stickyWindow = null; });
  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!stickyWindow || stickyWindow.isDestroyed()) return;
      const bounds = stickyWindow.getBounds();
      brokerRequest('/v1/notes', { method: 'POST', body: { id: saved.id, ...bounds } }).catch(() => {});
    }, 200);
  };
  stickyWindow.on('move', saveBounds);
  stickyWindow.on('resize', saveBounds);
  return saved;
}
