const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');

const instanceLock = app.requestSingleInstanceLock({ cwd: process.cwd() });
if (!instanceLock) app.quit();

let mainWindow;
let stickyWindow;
let mainRendererReady = false;
let pendingSecondInstance;

app.on('second-instance', (_event, argv, cwd, additionalData) => {
  if (!app.isReady()) return;
  const requestedCwd = additionalData?.cwd || cwd;
  const hadMainWindow = Boolean(mainWindow && !mainWindow.isDestroyed());
  const target = ensureMainWindow(requestedCwd);
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  if (hadMainWindow && mainRendererReady) target.webContents.send('second-instance', { argv, cwd: requestedCwd });
  else if (hadMainWindow) pendingSecondInstance = { argv, cwd: requestedCwd };
});

app.whenReady().then(async () => {
  const { ensureBroker, brokerRequest } = await import('../core/broker-client.mjs');
  const { inspectRepositoryContext } = await import('../core/repository-context.mjs');
  await ensureBroker();

  ipcMain.handle('broker:request', (_event, request) => brokerRequest(request.path, request.options));
  ipcMain.handle('app:context', async (_event, requestedCwd) => {
    const cwd = path.resolve(typeof requestedCwd === 'string' && requestedCwd ? requestedCwd : process.cwd());
    const context = { cwd, platform: process.platform };
    context.repository = await inspectRepositoryContext(cwd);
    context.cwd = context.repository.repoRoot || context.repository.cwd;
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
  ipcMain.handle('app:ready', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    mainRendererReady = true;
    const payload = pendingSecondInstance;
    pendingSecondInstance = null;
    return payload;
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

  ensureMainWindow(process.cwd());
  await openSticky({}, brokerRequest);
  app.on('activate', () => {
    const window = ensureMainWindow();
    window.show();
    window.focus();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function createWindow(startupCwd) {
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
  window.loadFile(path.join(__dirname, 'ui', 'index.html'), startupCwd ? { query: { cwd: startupCwd } } : undefined);
  window.webContents.on('did-start-loading', () => { mainRendererReady = false; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return window;
}

function ensureMainWindow(startupCwd) {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = createWindow(startupCwd);
  mainWindow.on('closed', () => {
    mainWindow = null;
    mainRendererReady = false;
  });
  return mainWindow;
}

async function openSticky(note, brokerRequest) {
  const requested = {
    ...note,
    id: 'codex-activity',
    title: 'Codex 执行便签',
    width: note.width ?? 380,
    height: note.height ?? 520,
    alwaysOnTop: true
  };
  if (stickyWindow && !stickyWindow.isDestroyed()) {
    stickyWindow.show();
    stickyWindow.focus();
    brokerRequest('/v1/notes', { method: 'POST', body: requested }).catch(() => {});
    return requested;
  }
  const saved = await brokerRequest('/v1/notes', { method: 'POST', body: requested });
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
