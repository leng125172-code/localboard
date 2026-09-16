const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, nativeTheme } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
let pendingMainNavigation;
let tray;
let brokerRequestImpl;
let appearanceSettings = { theme: 'system', mica: true, reduceMotion: false };
let closeToTray = true;
let appQuitting = false;

const STICKY_PRESETS = Object.freeze({
  small: Object.freeze({ width: 320, height: 480 }),
  medium: Object.freeze({ width: 400, height: 680 }),
  large: Object.freeze({ width: 520, height: 820 })
});
const STICKY_MIN_SIZE = Object.freeze({ width: 280, height: 360 });
const DEFAULT_DOCK = Object.freeze({ snapDistance: 16, exposedStrip: 12, collapseDelay: 700 });
let stickyState = createStickyState();

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

app.on('before-quit', () => { appQuitting = true; });

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
    try {
      await handleCodexHook(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      return app.quit();
    } catch (error) {
      console.error(`localboard hook failed: ${error.message}`);
      return app.exit(1);
    }
  }
  if (utilityMode === 'install') {
    const { installBundledIntegrations } = await import('../core/integration-installer.mjs');
    await installBundledIntegrations({ appRoot: app.getAppPath(), integrationRoot: process.resourcesPath,
      command: process.execPath, appVersion: app.getVersion() });
    return app.quit();
  }
  const { ensureBroker, brokerRequest } = await import('../core/broker-client.mjs');
  await ensureBroker();
  brokerRequestImpl = brokerRequest;
  Menu.setApplicationMenu(null);
  nativeTheme.on('updated', refreshWindowAppearance);
  screen.on('display-removed', restoreStickyToVisibleArea);
  screen.on('display-metrics-changed', restoreStickyToVisibleArea);
  const storedSettings = await brokerRequest('/v1/settings').catch(() => ({ settings: {} }));
  applyRuntimeSettings({ autoStart: true, closeToTray: true, ...(storedSettings.settings || {}) });
  if (app.isPackaged) {
    const statusPath = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'LocalBoard', 'integration-status.json');
    const { bundledIntegrationsNeedRefresh, installBundledIntegrations } = await import('../core/integration-installer.mjs');
    if (await bundledIntegrationsNeedRefresh(statusPath, app.getVersion())) {
      await installBundledIntegrations({ appRoot: app.getAppPath(), integrationRoot: process.resourcesPath,
        command: process.execPath, statusPath, appVersion: app.getVersion() });
    }
  }

  ipcMain.handle('broker:request', (_event, request) => brokerRequest(request.path, request.options));
  ipcMain.handle('app:context', async (_event, requestedCwd, refresh = false) => {
    const cwd = path.resolve(typeof requestedCwd === 'string' && requestedCwd ? requestedCwd : process.cwd());
    const context = { cwd, platform: process.platform };
    context.repository = await brokerRequest('/v1/projects/register', {
      method: 'POST', body: { cwd, refresh, register: false }
    });
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
    if (pendingMainNavigation) {
      event.sender.send('sticky:navigate', pendingMainNavigation);
      pendingMainNavigation = null;
    }
    return payload;
  });
  ipcMain.handle('sticky:open', async (_event, note = {}) => openSticky(note, brokerRequest));
  ipcMain.handle('sticky:preferences', async (_event, patch = {}) => {
    const saved = await brokerRequest('/v1/notes', { method: 'POST', body: { id: 'codex-activity', ...patch } });
    applyStickyPreferences(saved);
    return saved;
  });
  ipcMain.handle('github:auth', (_event, action = 'login', account) => openGitHubAuth(action, account));
  ipcMain.handle('sticky:bounds', (event) => BrowserWindow.fromWebContents(event.sender) === stickyWindow ? stickyWindow.getBounds() : null);
  ipcMain.handle('main-window:action', (event, action) => handleMainWindowAction(event, action));
  ipcMain.handle('sticky:window', (event, action, payload = {}) => handleStickyWindowAction(event, action, payload));
  ipcMain.handle('sticky:pointer', (event, inside) => handleStickyPointer(event, inside));
  ipcMain.handle('appearance:apply', (event, settings = {}) => applyAppearance(event, settings));
  ipcMain.handle('window:action', (event, action) => handleLegacyWindowAction(event, action));

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
  const colors = appearanceColors();
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: colors.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.overlay,
      symbolColor: colors.symbol,
      height: 44
    },
    ...(supportsMica() ? { backgroundMaterial: 'mica' } : {}),
    title: 'LocalBoard',
    icon: applicationIconPath(),
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
  window.on('close', (event) => {
    if (!appQuitting && closeToTray) {
      event.preventDefault();
      window.hide();
    } else if (!appQuitting) {
      appQuitting = true;
      setImmediate(() => app.quit());
    }
  });
  applyWindowAppearance(window, appearanceSettings);
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
  const [notes, settingsResponse] = await Promise.all([
    brokerRequest('/v1/notes'),
    brokerRequest('/v1/settings').catch(() => ({ settings: {} }))
  ]);
  const previous = notes.notes.find((item) => item.id === 'codex-activity');
  const stickySettings = parseObject(settingsResponse.settings?.sticky);
  const defaultPreset = Object.hasOwn(STICKY_PRESETS, stickySettings.defaultPreset) ? stickySettings.defaultPreset : 'medium';
  const layout = normalizeStickyLayout(note.layout ?? previous?.layout ?? { preset: defaultPreset });
  const dock = normalizeDockState({
    ...parseObject(note.dock ?? previous?.dock),
    snapDistance: stickySettings.snapDistance ?? parseObject(note.dock ?? previous?.dock).snapDistance,
    collapseDelay: stickySettings.collapseDelay ?? parseObject(note.dock ?? previous?.dock).collapseDelay,
    exposedStrip: stickySettings.handleWidth ?? parseObject(note.dock ?? previous?.dock).exposedStrip
  });
  const defaultSize = STICKY_PRESETS[defaultPreset];
  appearanceSettings.reduceMotion = stickySettings.reduceMotion === undefined
    ? appearanceSettings.reduceMotion : Boolean(stickySettings.reduceMotion);
  const requested = {
    ...previous,
    ...note,
    id: 'codex-activity',
    title: 'Codex 执行便签',
    width: clampNumber(note.width ?? previous?.width, STICKY_MIN_SIZE.width, 4096, defaultSize.width),
    height: clampNumber(note.height ?? previous?.height, STICKY_MIN_SIZE.height, 4096, defaultSize.height),
    alwaysOnTop: note.alwaysOnTop ?? previous?.alwaysOnTop ?? true,
    desktopPinned: note.desktopPinned ?? previous?.desktopPinned ?? false,
    layout,
    dock,
    visible: true
  };
  if (stickyWindow && !stickyWindow.isDestroyed()) {
    stickyWindow.show();
    stickyWindow.focus();
    brokerRequest('/v1/notes', { method: 'POST', body: requested }).catch(() => {});
    return requested;
  }
  const persisted = await brokerRequest('/v1/notes', { method: 'POST', body: requested });
  const saved = { ...requested, ...persisted, layout, dock };
  const initialDisplay = displayForSavedNote(saved);
  const area = initialDisplay.workArea;
  let initialBounds = clampBoundsToWorkArea({
    x: Number.isFinite(saved.x) ? saved.x : area.x + area.width - saved.width - 24,
    y: Number.isFinite(saved.y) ? saved.y : area.y + 24,
    width: saved.width,
    height: saved.height
  }, area);
  if (dock.edge) {
    initialBounds = dock.collapsed
      ? collapsedBounds(initialBounds, area, dock.edge, dock.exposedStrip)
      : snappedBounds(initialBounds, area, dock.edge);
  }
  stickyWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: STICKY_MIN_SIZE.width,
    minHeight: STICKY_MIN_SIZE.height,
    frame: false,
    transparent: false,
    alwaysOnTop: saved.alwaysOnTop,
    skipTaskbar: false,
    backgroundColor: saved.color,
    title: saved.title,
    icon: applicationIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  stickyState = createStickyState({ note: saved, layout, dock, expandedBounds: dock.collapsed ? snappedBounds(initialBounds, area, dock.edge) : initialBounds });
  stickyWindow.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: { sticky: 'activity', id: saved.id } });
  applyStickyPreferences(saved);
  stickyWindow.webContents.on('did-finish-load', () => emitStickyDockChanged());
  stickyWindow.on('focus', () => {
    cancelStickyCollapse();
    if (stickyState.dock.collapsed) expandSticky();
  });
  stickyWindow.on('blur', () => {
    stickyState.interacting = false;
    if (!stickyState.pointerInside) scheduleStickyCollapse();
  });
  stickyWindow.on('will-move', () => beginStickyInteraction());
  stickyWindow.on('move', () => debounceStickyGeometry('move'));
  stickyWindow.on('will-resize', () => beginStickyInteraction());
  stickyWindow.on('resize', () => debounceStickyGeometry('resize'));
  stickyWindow.on('closed', () => {
    cancelStickyCollapse();
    clearTimeout(stickyState.moveTimer);
    clearTimeout(stickyState.resizeTimer);
    stickyWindow = null;
    stickyState = createStickyState();
  });
  return saved;
}

function applyStickyPreferences(note) {
  if (!stickyWindow || stickyWindow.isDestroyed()) return;
  stickyWindow.setAlwaysOnTop(Boolean(note.alwaysOnTop));
  stickyWindow.setVisibleOnAllWorkspaces(Boolean(note.desktopPinned), { visibleOnFullScreen: false });
  if (note.visible === false) stickyWindow.hide();
}

function createStickyState(initial = {}) {
  return {
    note: initial.note || { id: 'codex-activity' },
    layout: normalizeStickyLayout(initial.layout),
    dock: normalizeDockState(initial.dock),
    expandedBounds: initial.expandedBounds || null,
    pointerInside: false,
    interacting: false,
    collapseTimer: null,
    saveTimer: null,
    moveTimer: null,
    resizeTimer: null,
    animationTimer: null,
    expectedBounds: null
  };
}

function normalizeStickyLayout(value) {
  const source = parseObject(value);
  const preset = Object.hasOwn(STICKY_PRESETS, source.preset) ? source.preset : 'custom';
  const sectionRatios = Array.isArray(source.sectionRatios)
    ? source.sectionRatios.map(Number).filter((item) => Number.isFinite(item) && item > 0)
    : undefined;
  const collapsedSections = Array.isArray(source.collapsedSections)
    ? [...new Set(source.collapsedSections.map(String).filter(Boolean))]
    : undefined;
  return {
    preset,
    ...(sectionRatios?.length ? { sectionRatios } : {}),
    ...(collapsedSections?.length ? { collapsedSections } : {})
  };
}

function normalizeDockState(value) {
  const source = parseObject(value);
  const edge = ['left', 'right', 'top', 'bottom'].includes(source.edge) ? source.edge : null;
  return {
    edge,
    collapsed: Boolean(edge && source.collapsed),
    displayId: source.displayId ?? null,
    snapDistance: clampNumber(source.snapDistance, 0, 64, DEFAULT_DOCK.snapDistance),
    exposedStrip: clampNumber(source.exposedStrip, 4, 48, DEFAULT_DOCK.exposedStrip),
    collapseDelay: clampNumber(source.collapseDelay, 0, 5000, DEFAULT_DOCK.collapseDelay),
    expandedBounds: normalizeBounds(source.expandedBounds)
  };
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(value[key])]));
  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function handleMainWindowAction(event, action) {
  if (!isTrustedSender(event)) return false;
  if (action === 'open' || action === 'focus') {
    const window = ensureMainWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize-toggle') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  else if (action === 'close') mainWindow.close();
  else return false;
  return true;
}

async function handleStickyWindowAction(event, action, payload) {
  if (!isTrustedSender(event)) return false;
  if (action === 'open-main') return openMainFromSticky(payload);
  if (!stickyWindow || stickyWindow.isDestroyed()) return false;
  if (BrowserWindow.fromWebContents(event.sender) !== stickyWindow) return false;
  if (action === 'preset') return applyStickyPreset(payload?.preset);
  if (action === 'dock') return dockSticky(payload?.edge);
  if (action === 'expand') return expandSticky();
  if (action === 'collapse') return collapseSticky(true);
  if (action === 'undock') return undockSticky();
  if (action === 'interaction') {
    stickyState.interacting = Boolean(payload?.active);
    if (stickyState.interacting) cancelStickyCollapse();
    else if (!stickyState.pointerInside) scheduleStickyCollapse();
    return stickyDockPayload();
  }
  if (action === 'minimize') {
    cancelStickyCollapse();
    stickyWindow.minimize();
    return true;
  }
  if (action === 'hide') {
    cancelStickyCollapse();
    stickyWindow.hide();
    return true;
  }
  if (action === 'get-state') return stickyDockPayload();
  return false;
}

function handleStickyPointer(event, inside) {
  if (!stickyWindow || stickyWindow.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== stickyWindow) return false;
  stickyState.pointerInside = Boolean(inside);
  if (stickyState.pointerInside) {
    cancelStickyCollapse();
    if (stickyState.dock.collapsed) expandSticky();
  } else if (!stickyState.interacting) {
    scheduleStickyCollapse();
  }
  return true;
}

function handleLegacyWindowAction(event, action) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !isTrustedSender(event)) return false;
  if (action === 'minimize') window.minimize();
  else if (action === 'hide') window.hide();
  else return false;
  return true;
}

function isTrustedSender(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  return Boolean(window && (window === mainWindow || window === stickyWindow));
}

function openMainFromSticky(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const allowedTabs = new Set(['todos', 'git', 'project', 'issues', 'prs', 'actions', 'agents', 'notes', 'status', 'settings']);
  const navigation = {
    cwd: typeof source.cwd === 'string' && source.cwd ? path.resolve(source.cwd) : undefined,
    tab: allowedTabs.has(source.tab) ? source.tab : 'todos',
    scope: source.scope === 'global' ? 'global' : source.scope === 'repository' ? 'repository' : undefined,
    projectId: typeof source.projectId === 'string' ? source.projectId : undefined
  };
  const window = ensureMainWindow(navigation.cwd);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (mainRendererReady) window.webContents.send('sticky:navigate', navigation);
  else pendingMainNavigation = navigation;
  return true;
}

function applyStickyPreset(name) {
  if (!Object.hasOwn(STICKY_PRESETS, name)) return false;
  cancelStickyAnimation();
  if (stickyState.dock.collapsed) expandSticky(false);
  const current = stickyWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const size = STICKY_PRESETS[name];
  let next = clampBoundsToWorkArea({ ...current, width: size.width, height: size.height }, display.workArea);
  if (stickyState.dock.edge) next = snappedBounds(next, display.workArea, stickyState.dock.edge);
  stickyState.layout = { ...stickyState.layout, preset: name };
  stickyState.dock = { ...stickyState.dock, collapsed: false, displayId: display.id, expandedBounds: next };
  stickyState.expandedBounds = next;
  setStickyBounds(next);
  scheduleStickySave();
  emitStickyDockChanged();
  return stickyDockPayload();
}

function dockSticky(edge) {
  if (!['left', 'right', 'top', 'bottom'].includes(edge)) return false;
  cancelStickyAnimation();
  const current = stickyState.dock.collapsed && stickyState.expandedBounds
    ? stickyState.expandedBounds : stickyWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const next = snappedBounds(clampBoundsToWorkArea(current, display.workArea), display.workArea, edge);
  stickyState.dock = { ...stickyState.dock, edge, collapsed: false, displayId: display.id, expandedBounds: next };
  stickyState.expandedBounds = next;
  setStickyBounds(next);
  scheduleStickySave();
  emitStickyDockChanged();
  if (!stickyState.pointerInside) scheduleStickyCollapse();
  return stickyDockPayload();
}

function undockSticky() {
  cancelStickyCollapse();
  cancelStickyAnimation();
  if (stickyState.dock.collapsed) expandSticky(false);
  stickyState.dock = { ...stickyState.dock, edge: null, collapsed: false, displayId: null, expandedBounds: null };
  stickyState.expandedBounds = clampBoundsToVisibleWorkArea(stickyWindow.getBounds());
  setStickyBounds(stickyState.expandedBounds);
  scheduleStickySave();
  emitStickyDockChanged();
  return stickyDockPayload();
}

function expandSticky(animate = true) {
  cancelStickyCollapse();
  if (!stickyState.dock.edge || !stickyState.dock.collapsed) return stickyDockPayload();
  const display = displayForDock(stickyState.dock, stickyWindow.getBounds());
  const candidate = stickyState.dock.expandedBounds || stickyState.expandedBounds || stickyWindow.getBounds();
  const next = snappedBounds(clampBoundsToWorkArea(candidate, display.workArea), display.workArea, stickyState.dock.edge);
  stickyState.dock = { ...stickyState.dock, collapsed: false, displayId: display.id, expandedBounds: next };
  stickyState.expandedBounds = next;
  animateStickyBounds(next, animate);
  scheduleStickySave();
  emitStickyDockChanged();
  return stickyDockPayload();
}

function collapseSticky(force = false) {
  cancelStickyCollapse();
  if (!stickyState.dock.edge || stickyState.dock.collapsed) return stickyDockPayload();
  if (!force && (stickyState.pointerInside || stickyState.interacting)) return stickyDockPayload();
  const current = stickyWindow.getBounds();
  const display = displayForDock(stickyState.dock, current);
  const expanded = snappedBounds(clampBoundsToWorkArea(current, display.workArea), display.workArea, stickyState.dock.edge);
  const next = collapsedBounds(expanded, display.workArea, stickyState.dock.edge, stickyState.dock.exposedStrip);
  stickyState.expandedBounds = expanded;
  stickyState.dock = { ...stickyState.dock, collapsed: true, displayId: display.id, expandedBounds: expanded };
  animateStickyBounds(next, true);
  scheduleStickySave();
  emitStickyDockChanged();
  return stickyDockPayload();
}

function scheduleStickyCollapse() {
  cancelStickyCollapse();
  if (!stickyState.dock.edge || stickyState.dock.collapsed || stickyState.pointerInside || stickyState.interacting) return;
  stickyState.collapseTimer = setTimeout(() => collapseSticky(), stickyState.dock.collapseDelay);
}

function cancelStickyCollapse() {
  clearTimeout(stickyState.collapseTimer);
  stickyState.collapseTimer = null;
}

function beginStickyInteraction() {
  if (stickyState.expectedBounds) return;
  cancelStickyCollapse();
  cancelStickyAnimation();
  stickyState.interacting = true;
  if (stickyState.dock.collapsed) expandSticky(false);
}

function debounceStickyGeometry(kind) {
  if (!stickyWindow || stickyWindow.isDestroyed()) return;
  const actual = stickyWindow.getBounds();
  if (consumeExpectedBounds(actual) || stickyState.animationTimer) return;
  const timerKey = kind === 'resize' ? 'resizeTimer' : 'moveTimer';
  clearTimeout(stickyState[timerKey]);
  stickyState[timerKey] = setTimeout(kind === 'resize' ? finishStickyResize : finishStickyMove, 120);
}

function finishStickyMove() {
  if (!stickyWindow || stickyWindow.isDestroyed()) return;
  const actual = stickyWindow.getBounds();
  if (consumeExpectedBounds(actual)) return;
  stickyState.interacting = false;
  const display = screen.getDisplayMatching(actual);
  const clamped = clampBoundsToWorkArea(actual, display.workArea);
  const edge = nearestDockEdge(actual, display.workArea, stickyState.dock.snapDistance);
  if (!edge) {
    stickyState.dock = { ...stickyState.dock, edge: null, collapsed: false, displayId: null, expandedBounds: null };
    stickyState.expandedBounds = clamped;
    if (!sameBounds(actual, clamped)) setStickyBounds(clamped);
  } else {
    const next = snappedBounds(clamped, display.workArea, edge);
    stickyState.dock = { ...stickyState.dock, edge, collapsed: false, displayId: display.id, expandedBounds: next };
    stickyState.expandedBounds = next;
    if (!sameBounds(actual, next)) setStickyBounds(next);
  }
  scheduleStickySave();
  emitStickyDockChanged();
  if (edge && !stickyState.pointerInside) scheduleStickyCollapse();
}

function finishStickyResize() {
  if (!stickyWindow || stickyWindow.isDestroyed()) return;
  const actual = stickyWindow.getBounds();
  if (consumeExpectedBounds(actual)) return;
  stickyState.interacting = false;
  const display = screen.getDisplayMatching(actual);
  let next = clampBoundsToWorkArea({
    ...actual,
    width: Math.max(STICKY_MIN_SIZE.width, actual.width),
    height: Math.max(STICKY_MIN_SIZE.height, actual.height)
  }, display.workArea);
  if (stickyState.dock.edge) next = snappedBounds(next, display.workArea, stickyState.dock.edge);
  const preset = Object.entries(STICKY_PRESETS).find(([, size]) => size.width === next.width && size.height === next.height)?.[0] || 'custom';
  stickyState.layout = { ...stickyState.layout, preset };
  stickyState.expandedBounds = next;
  stickyState.dock = { ...stickyState.dock, collapsed: false, displayId: stickyState.dock.edge ? display.id : null,
    expandedBounds: stickyState.dock.edge ? next : null };
  if (!sameBounds(actual, next)) setStickyBounds(next);
  scheduleStickySave();
  emitStickyDockChanged();
  if (stickyState.dock.edge && !stickyState.pointerInside) scheduleStickyCollapse();
}

function setStickyBounds(bounds) {
  if (!stickyWindow || stickyWindow.isDestroyed()) return;
  stickyState.expectedBounds = { ...bounds };
  stickyWindow.setBounds(bounds);
}

function animateStickyBounds(target, animate) {
  cancelStickyAnimation();
  if (!animate || appearanceSettings.reduceMotion) return setStickyBounds(target);
  const start = stickyWindow.getBounds();
  const startedAt = Date.now();
  stickyState.animationTimer = setInterval(() => {
    if (!stickyWindow || stickyWindow.isDestroyed()) return cancelStickyAnimation();
    const progress = Math.min(1, (Date.now() - startedAt) / 140);
    const eased = 1 - Math.pow(1 - progress, 3);
    const next = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Math.round(start[key] + (target[key] - start[key]) * eased)]));
    setStickyBounds(next);
    if (progress >= 1) cancelStickyAnimation();
  }, 16);
}

function cancelStickyAnimation() {
  clearInterval(stickyState.animationTimer);
  stickyState.animationTimer = null;
}

function consumeExpectedBounds(actual) {
  if (!stickyState.expectedBounds || !sameBounds(actual, stickyState.expectedBounds)) return false;
  stickyState.expectedBounds = null;
  return true;
}

function scheduleStickySave() {
  clearTimeout(stickyState.saveTimer);
  stickyState.saveTimer = setTimeout(saveStickyState, 180);
}

function saveStickyState() {
  if (!brokerRequestImpl || !stickyWindow || stickyWindow.isDestroyed()) return;
  const bounds = stickyState.dock.collapsed && stickyState.expandedBounds
    ? stickyState.expandedBounds : stickyWindow.getBounds();
  const dock = { ...stickyState.dock, expandedBounds: stickyState.dock.edge ? stickyState.expandedBounds : null };
  brokerRequestImpl('/v1/notes', {
    method: 'POST',
    body: { id: stickyState.note.id || 'codex-activity', ...bounds, layout: stickyState.layout, dock }
  }).then((saved) => { stickyState.note = { ...stickyState.note, ...saved }; }).catch(() => {});
}

function emitStickyDockChanged() {
  if (stickyWindow && !stickyWindow.isDestroyed() && !stickyWindow.webContents.isDestroyed()) {
    stickyWindow.webContents.send('sticky:dock-changed', {
      ...stickyState.dock,
      expandedBounds: stickyState.expandedBounds ? { ...stickyState.expandedBounds } : null
    });
  }
}

function stickyDockPayload() {
  return {
    layout: { ...stickyState.layout },
    dock: { ...stickyState.dock, expandedBounds: stickyState.expandedBounds ? { ...stickyState.expandedBounds } : null },
    presets: STICKY_PRESETS,
    minSize: STICKY_MIN_SIZE
  };
}

function nearestDockEdge(bounds, area, distance) {
  const distances = [
    ['left', Math.abs(bounds.x - area.x)],
    ['right', Math.abs(area.x + area.width - (bounds.x + bounds.width))],
    ['top', Math.abs(bounds.y - area.y)],
    ['bottom', Math.abs(area.y + area.height - (bounds.y + bounds.height))]
  ].filter(([, value]) => value <= distance).sort((a, b) => a[1] - b[1]);
  return distances[0]?.[0] || null;
}

function snappedBounds(bounds, area, edge) {
  const next = clampBoundsToWorkArea(bounds, area);
  if (edge === 'left') next.x = area.x;
  if (edge === 'right') next.x = area.x + area.width - next.width;
  if (edge === 'top') next.y = area.y;
  if (edge === 'bottom') next.y = area.y + area.height - next.height;
  return next;
}

function collapsedBounds(bounds, area, edge, exposedStrip) {
  const next = snappedBounds(bounds, area, edge);
  if (edge === 'left') next.x = area.x - next.width + exposedStrip;
  if (edge === 'right') next.x = area.x + area.width - exposedStrip;
  if (edge === 'top') next.y = area.y - next.height + exposedStrip;
  if (edge === 'bottom') next.y = area.y + area.height - exposedStrip;
  return next;
}

function clampBoundsToVisibleWorkArea(bounds) {
  const display = screen.getDisplayMatching(bounds);
  return clampBoundsToWorkArea(bounds, display.workArea);
}

function clampBoundsToWorkArea(bounds, area) {
  const width = Math.min(area.width, Math.max(STICKY_MIN_SIZE.width, Math.round(bounds.width)));
  const height = Math.min(area.height, Math.max(STICKY_MIN_SIZE.height, Math.round(bounds.height)));
  return {
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, bounds.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, bounds.y))),
    width,
    height
  };
}

function displayForSavedNote(note) {
  const dock = normalizeDockState(note.dock);
  const storedDisplay = dock.displayId === null ? null : screen.getAllDisplays().find((display) => String(display.id) === String(dock.displayId));
  if (storedDisplay) return storedDisplay;
  if (Number.isFinite(note.x) && Number.isFinite(note.y)) {
    return screen.getDisplayMatching({ x: note.x, y: note.y, width: note.width, height: note.height });
  }
  return screen.getPrimaryDisplay();
}

function displayForDock(dock, bounds) {
  return screen.getAllDisplays().find((display) => String(display.id) === String(dock.displayId))
    || screen.getDisplayMatching(bounds);
}

function sameBounds(a, b) {
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 1);
}

function restoreStickyToVisibleArea() {
  if (!stickyWindow || stickyWindow.isDestroyed()) return;
  cancelStickyAnimation();
  const reference = stickyState.expandedBounds || stickyWindow.getBounds();
  const display = displayForDock(stickyState.dock, reference);
  let expanded = clampBoundsToWorkArea(reference, display.workArea);
  if (stickyState.dock.edge) expanded = snappedBounds(expanded, display.workArea, stickyState.dock.edge);
  stickyState.expandedBounds = expanded;
  stickyState.dock = {
    ...stickyState.dock,
    displayId: stickyState.dock.edge ? display.id : null,
    expandedBounds: stickyState.dock.edge ? expanded : null
  };
  const next = stickyState.dock.collapsed && stickyState.dock.edge
    ? collapsedBounds(expanded, display.workArea, stickyState.dock.edge, stickyState.dock.exposedStrip)
    : expanded;
  setStickyBounds(next);
  scheduleStickySave();
  emitStickyDockChanged();
}

function applyAppearance(event, settings) {
  if (!isTrustedSender(event) || !settings || typeof settings !== 'object') return false;
  applyRuntimeSettings(settings);
  refreshWindowAppearance();
  return { ...appearanceSettings, micaSupported: supportsMica() };
}

function applyRuntimeSettings(settings) {
  const theme = ['system', 'light', 'dark'].includes(settings.theme) ? settings.theme : appearanceSettings.theme;
  const stickySettings = parseObject(settings.sticky);
  appearanceSettings = {
    theme,
    mica: settings.mica === undefined ? appearanceSettings.mica : Boolean(settings.mica),
    reduceMotion: stickySettings.reduceMotion === undefined
      ? (settings.reduceMotion === undefined ? appearanceSettings.reduceMotion : Boolean(settings.reduceMotion))
      : Boolean(stickySettings.reduceMotion)
  };
  if (typeof settings.closeToTray === 'boolean') closeToTray = settings.closeToTray;
  if (typeof settings.autoStart === 'boolean') enableAutoStart(settings.autoStart);
  if (stickyWindow && !stickyWindow.isDestroyed()) {
    stickyState.dock = normalizeDockState({
      ...stickyState.dock,
      snapDistance: stickySettings.snapDistance ?? stickyState.dock.snapDistance,
      collapseDelay: stickySettings.collapseDelay ?? stickyState.dock.collapseDelay,
      exposedStrip: stickySettings.handleWidth ?? stickyState.dock.exposedStrip
    });
    scheduleStickySave();
    emitStickyDockChanged();
  }
  nativeTheme.themeSource = theme;
}

function refreshWindowAppearance() {
  if (mainWindow && !mainWindow.isDestroyed()) applyWindowAppearance(mainWindow, appearanceSettings);
}

function applyWindowAppearance(window, settings = appearanceSettings) {
  const colors = appearanceColors();
  window.setBackgroundColor(colors.background);
  if (typeof window.setTitleBarOverlay === 'function') {
    window.setTitleBarOverlay({ color: colors.overlay, symbolColor: colors.symbol, height: 44 });
  }
  if (typeof window.setBackgroundMaterial === 'function') {
    try {
      window.setBackgroundMaterial(settings.mica !== false && supportsMica() ? 'mica' : 'none');
    } catch {
      // Older Windows builds and remote sessions can reject background materials.
    }
  }
}

function appearanceColors() {
  return nativeTheme.shouldUseDarkColors
    ? { background: '#202020', overlay: '#202020', symbol: '#ffffff' }
    : { background: '#f3f3f3', overlay: '#f3f3f3', symbol: '#1a1a1a' };
}

function supportsMica() {
  if (process.platform !== 'win32' || nativeTheme.shouldUseHighContrastColors) return false;
  const parts = process.getSystemVersion().split('.').map(Number);
  return parts.length >= 3 && parts[0] >= 10 && parts[2] >= 22621;
}

function createTray(brokerRequest) {
  let icon = nativeImage.createFromPath(applicationIconPath());
  if (icon.isEmpty()) icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAFUlEQVR42mNk+M9Qz0AEYBxVSFUAAL4jHxHRAxHZAAAAAElFTkSuQmCC', 'base64'));
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

function applicationIconPath() {
  return path.join(app.getAppPath(), 'assets', 'icon.png');
}

function enableAutoStart(enabled = true) {
  if (process.platform !== 'win32') return;
  const args = process.defaultApp ? [path.resolve(__dirname, '..', '..'), '--background'] : ['--background'];
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath, args });
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
