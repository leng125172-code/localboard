const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

if (process.env.LOCALBOARD_E2E_USER_DATA) app.setPath('userData', process.env.LOCALBOARD_E2E_USER_DATA);

const utilityMode = process.argv.includes('--mcp') || process.argv.includes('mcp') ? 'mcp'
  : process.argv.includes('--hook') ? 'hook'
    : process.argv.includes('--broker') ? 'broker'
      : process.argv.includes('--install-integrations') ? 'install' : null;
const instanceLock = utilityMode || process.env.LOCALBOARD_DISABLE_SINGLE_INSTANCE === '1'
  ? true : app.requestSingleInstanceLock({ cwd: process.cwd() });
if (!instanceLock) app.quit();

let mainWindow;
let stickyWindow;
let mainRendererReady = false;
let pendingSecondInstance;
let tray;

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
  if (utilityMode === 'broker') {
    const { startBroker } = await import('../core/broker-server.mjs');
    const broker = await startBroker();
    if (!broker.owner) return app.quit();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await broker.close();
      app.quit();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  if (utilityMode === 'mcp') {
    const { runMcpServer } = await import('../mcp-server.mjs');
    await runMcpServer();
    return app.quit();
  }
  if (utilityMode === 'hook') {
    const { handleCodexHook } = await import('../core/codex-hook.mjs');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await handleCodexHook(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')).catch(() => {});
    return app.quit();
  }
  if (utilityMode === 'install') {
    const { installBundledIntegrations } = await import('../core/integration-installer.mjs');
    await installBundledIntegrations({ appRoot: app.getAppPath(), integrationRoot: process.resourcesPath, command: process.execPath });
    return app.quit();
  }
  const { ensureBroker, brokerRequest } = await import('../core/broker-client.mjs');
  await ensureBroker();
  if (app.isPackaged) {
    const statusPath = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'LocalBoard', 'integration-status.json');
    if (!fs.existsSync(statusPath)) {
      const { installBundledIntegrations } = await import('../core/integration-installer.mjs');
      await installBundledIntegrations({ appRoot: app.getAppPath(), integrationRoot: process.resourcesPath, command: process.execPath });
    }
  }

  ipcMain.handle('broker:request', (_event, request) => brokerRequest(request.path, request.options));
  ipcMain.handle('app:context', async (_event, requestedCwd, refresh = false) => {
    const cwd = path.resolve(typeof requestedCwd === 'string' && requestedCwd ? requestedCwd : process.cwd());
    const context = { cwd, platform: process.platform };
    context.repository = await brokerRequest('/v1/projects/register', { method: 'POST', body: { cwd, refresh } });
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
  ipcMain.handle('sticky:preferences', async (_event, patch = {}) => {
    const saved = await brokerRequest('/v1/notes', { method: 'POST', body: { id: 'codex-activity', ...patch } });
    applyStickyPreferences(saved);
    return saved;
  });
  ipcMain.handle('github:auth', (_event, action = 'login', account) => openGitHubAuth(action, account));
  ipcMain.handle('sticky:bounds', (event) => BrowserWindow.fromWebContents(event.sender)?.getBounds());
  ipcMain.handle('window:action', (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (action === 'minimize') window.minimize();
    else if (action === 'hide') window.hide();
    else return false;
    return true;
  });

  enableAutoStart();
  if (!process.argv.includes('--background')) {
    ensureMainWindow(process.cwd());
    await openSticky({}, brokerRequest);
  }
  if (process.env.LOCALBOARD_DISABLE_SINGLE_INSTANCE !== '1') {
    try { createTray(brokerRequest); } catch (error) { console.error(`LocalBoard tray unavailable: ${error.message}`); }
  }
  app.on('activate', () => {
    const window = ensureMainWindow();
    window.show();
    window.focus();
  });
}).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  // LocalBoard remains available in the tray so hooks and MCP can keep reporting.
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
  const notes = await brokerRequest('/v1/notes');
  const previous = notes.notes.find((item) => item.id === 'codex-activity');
  const requested = {
    ...previous,
    ...note,
    id: 'codex-activity',
    title: 'Codex 执行便签',
    width: note.width ?? previous?.width ?? 380,
    height: note.height ?? previous?.height ?? 620,
    alwaysOnTop: note.alwaysOnTop ?? previous?.alwaysOnTop ?? true,
    desktopPinned: note.desktopPinned ?? previous?.desktopPinned ?? false,
    visible: true
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
  applyStickyPreferences(saved);
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

function applyStickyPreferences(note) {
  if (!stickyWindow || stickyWindow.isDestroyed()) return;
  stickyWindow.setAlwaysOnTop(Boolean(note.alwaysOnTop));
  stickyWindow.setVisibleOnAllWorkspaces(Boolean(note.desktopPinned), { visibleOnFullScreen: false });
  if (note.visible === false) stickyWindow.hide();
}

function createTray(brokerRequest) {
  const icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAFUlEQVR42mNk+M9Qz0AEYBxVSFUAAL4jHxHRAxHZAAAAAElFTkSuQmCC', 'base64'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('LocalBoard');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => { const win = ensureMainWindow(); win.show(); win.focus(); } },
    { label: '打开执行便签', click: () => openSticky({}, brokerRequest) },
    { type: 'separator' },
    { label: '退出 LocalBoard', click: () => app.quit() }
  ]));
  tray.on('double-click', () => { const win = ensureMainWindow(); win.show(); win.focus(); });
}

function enableAutoStart() {
  if (process.platform !== 'win32') return;
  const args = process.defaultApp ? [path.resolve(__dirname, '..', '..'), '--background'] : ['--background'];
  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args });
}

function openGitHubAuth(action, account) {
  if (process.platform !== 'win32') return false;
  const safeAction = action === 'switch' ? 'switch' : 'login';
  const ghArgs = safeAction === 'switch' && account
    ? `gh auth switch --hostname github.com --user '${String(account).replaceAll("'", "''")}'`
    : 'gh auth login --hostname github.com';
  const child = spawn('powershell.exe', ['-NoExit', '-Command', ghArgs], {
    detached: true, stdio: 'ignore', windowsHide: false
  });
  child.unref();
  return true;
}
