const api = window.localboard;
const app = document.querySelector('#app');
const query = new URLSearchParams(location.search);
let applicationState;
const icons = window.LocalBoardIcons;
const icon = (name, options) => icons?.icon(name, options) || '';

if (query.get('sticky') === 'activity') renderActivitySticky(query.get('id'));
else renderApplication();

async function renderApplication() {
  const startupWorkspace = query.get('cwd');
  const savedWorkspace = startupWorkspace || localStorage.getItem('localboard.workspace');
  const [context, registry, settingsResponse] = await Promise.all([
    api.context(savedWorkspace || undefined),
    api.request('/v1/projects'),
    api.request('/v1/settings').catch(() => ({ settings: defaultSettings() }))
  ]);
  applicationState = {
    context,
    projects: registry.projects,
    settings: { ...defaultSettings(), ...(settingsResponse.settings || settingsResponse) },
    active: 'todos',
    globalSelected: !context.repository.isGitRepository,
    loadId: 0
  };
  applyAppearance(applicationState.settings);
  app.innerHTML = `
    <header class="app-titlebar">
      <button class="titlebar-button" id="toggle-project-pane" type="button" aria-label="展开或收起项目栏" title="展开或收起项目栏 (Ctrl+Shift+P)">${icon('menu')}</button>
      <div class="titlebar-brand"><span class="mini-brand">LB</span><span>LocalBoard</span></div>
      <div class="titlebar-drag"></div>
    </header>
    <div class="shell ${applicationState.settings.projectPaneExpanded ? 'project-pane-expanded' : ''} ${applicationState.globalSelected ? 'global-workspace' : ''}">
      <aside class="project-rail">
        <div class="project-rail-head"><div class="project-rail-title"><strong>项目</strong><small>Codex 启动目录</small></div></div>
        <label class="project-search">${icon('search')}<input id="project-search" type="search" placeholder="搜索项目" aria-label="搜索项目" /></label>
        <button class="project-button global-project-button" id="global-todos-entry" type="button" title="全局个人待办">
          <span class="selection-indicator"></span><span class="global-project-avatar">${icon('todo')}</span>
          <span class="project-copy"><strong>全局个人待办</strong><small>所有工作区共用</small></span>
        </button>
        <div class="project-rail-divider" aria-hidden="true"></div>
        <div class="project-list" id="project-list" role="listbox" aria-label="项目"></div>
      </aside>
      <aside class="sidebar">
        <div class="brand"><div><strong>LocalBoard</strong><small id="project-kind"></small></div></div>
        <nav class="nav" id="feature-nav"></nav>
        <button class="connection" id="service-status"><span class="dot"></span><span>本地服务</span><strong id="agent-count">0</strong></button>
      </aside>
      <main class="content">
        <header class="topbar"><div><div class="eyebrow" id="workspace-eyebrow">当前工作区</div><h1 id="page-title">个人待办</h1></div><button class="repo-pill" id="workspace-switcher" type="button" title="查看并切换 Codex 仓库"></button></header>
        <div id="error"></div><section id="view"></section>
      </main>
    </div>`;
  document.querySelector('#toggle-project-pane').onclick = toggleProjectPane;
  document.querySelector('#project-search').addEventListener('input', refreshProjectChrome);
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      toggleProjectPane();
    }
  });
  await refreshProjectChrome();
  document.querySelector('#workspace-switcher').addEventListener('click', () => navigate('status'));
  document.querySelector('#service-status').addEventListener('click', () => navigate('status'));
  api.onSecondInstance(({ cwd }) => switchWorkspace(cwd));
  api.onStickyNavigate?.(({ cwd, tab = 'todos', scope = 'repository' }) => {
    const navigateAfterSwitch = async () => {
      if (scope === 'global') return selectGlobalTodos();
      if (cwd && applicationState.context.cwd.toLowerCase() !== cwd.toLowerCase()) await switchWorkspace(cwd);
      await navigate(tab, { scope });
    };
    navigateAfterSwitch().catch(showError);
  });
  const pendingStartup = await api.ready();
  if (pendingStartup?.cwd) return switchWorkspace(pendingStartup.cwd);
  await navigate('todos');
}

async function navigate(tab, options = {}) {
  const state = applicationState;
  state.active = tab;
  const loadId = ++state.loadId;
  const titles = { todos: applicationState.globalSelected ? '全局个人待办' : '仓库待办', git: '源代码管理', project: 'GitHub Project', issues: 'Issues', prs: 'Pull Requests', actions: 'Actions', agents: 'Codex / Agents', notes: '执行便签', status: 'LocalBoard 状态', settings: '设置' };
  document.querySelector('#page-title').textContent = titles[tab];
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  clearError();
  document.querySelector('#view').innerHTML = '<div class="loading">正在加载…</div>';
  try {
    await load(tab, state.context, loadId, options);
  } catch (error) {
    if (loadId !== state.loadId) return;
    showError(error);
    document.querySelector('#view').innerHTML = '<div class="empty">此页面暂不可用。请处理上方提示后刷新，或切换到其他功能。</div>';
  }
}

async function load(tab, context, loadId, options) {
  if (tab === 'todos') return await loadTodos(context, loadId, options);
  if (tab === 'git') return await loadGit(context, loadId);
  if (tab === 'status') return await loadStatus(loadId);
  if (tab === 'agents') return await loadAgents(loadId);
  if (tab === 'notes') return await loadNotes(loadId);
  if (tab === 'project') return await loadProject(context, loadId, options);
  if (tab === 'issues') return await loadIssues(context, loadId, options);
  if (tab === 'prs') return await loadPullRequests(context, loadId, options);
  if (tab === 'actions') return await loadActions(context, loadId, options);
  if (tab === 'settings') return await loadSettings(loadId);
}

async function loadTodos(context, loadId, options = {}) {
  const repository = context.repository;
  const scope = applicationState.globalSelected ? 'global' : 'repository';
  if (scope === 'repository' && !repository.isGitRepository) throw new Error('非 Git 启动目录没有仓库待办，请使用一级栏的全局个人待办。');
  const query = new URLSearchParams({ scope });
  if (scope === 'repository') query.set('projectId', repository.projectId);
  const data = await api.request(`/v1/todos?${query}`);
  const view = currentView(loadId);
  if (!view) return;
  const storageText = scope === 'repository' ? `${repository.repoRoot}\\.localboard\\todos.json` : 'LocalBoard 应用数据目录（全局）';
  view.innerHTML = `<div class="scope-banner"><strong>${scope === 'repository' ? '当前仓库待办' : '全局个人待办'}</strong><span>保存于 ${escapeHtml(storageText)}</span></div>
    <div class="toolbar"><button class="primary" id="add-todo">新建待办</button><button class="secondary" id="refresh">刷新</button></div>
    <div class="grid">${data.todos.length ? data.todos.map(todoCard).join('') : `<div class="empty">还没有${scope === 'repository' ? '当前仓库' : '全局'}待办。</div>`}</div>`;
  document.querySelector('#add-todo').onclick = () => todoDialog(context, scope);
  document.querySelector('#refresh').onclick = () => navigate('todos', { scope });
  document.querySelectorAll('[data-done]').forEach((button) => button.onclick = async () => {
    await api.request('/v1/todos', { method: 'POST', body: { scope, projectId: scope === 'repository' ? repository.projectId : null, operation: 'update', id: button.dataset.done,
      idempotencyKey: crypto.randomUUID(), patch: { status: 'done' } } });
    await navigate('todos', { scope });
  });
  document.querySelectorAll('[data-edit-todo]').forEach((button) => {
    button.onclick = () => todoDialog(context, scope, data.todos.find((todo) => todo.id === button.dataset.editTodo));
  });
  document.querySelectorAll('[data-remove-todo]').forEach((button) => button.onclick = async () => {
    const todo = data.todos.find((item) => item.id === button.dataset.removeTodo);
    if (!todo || !window.confirm(`删除待办“${todo.title}”？`)) return;
    await api.request('/v1/todos', { method: 'POST', body: {
      scope, projectId: scope === 'repository' ? repository.projectId : null,
      operation: 'remove', id: todo.id, idempotencyKey: crypto.randomUUID()
    } });
    await navigate('todos', { scope });
  });
}

function todoCard(todo) {
  return `<article class="card todo-card ${todo.status}"><div class="meta">${escapeHtml(todo.status)} · P${todo.priority}</div>
    <h3>${escapeHtml(todo.title)}</h3><p>${escapeHtml(todo.description || ' ')}</p>
    <div class="meta">${todo.tags.map((tag) => `#${escapeHtml(tag)}`).join(' ')}</div>
    <div class="todo-actions">${todo.status !== 'done' ? `<button data-done="${escapeHtml(todo.id)}">完成</button>` : ''}
      <button data-edit-todo="${escapeHtml(todo.id)}">编辑</button><button class="danger-link" data-remove-todo="${escapeHtml(todo.id)}">删除</button></div></article>`;
}

function todoDialog(context, scope, todo = null) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form class="dialog form"><h2>${todo ? '编辑个人待办' : '新建个人待办'}</h2>
    <input name="title" placeholder="要完成什么？" value="${escapeHtml(todo?.title || '')}" required autofocus />
    <textarea name="description" placeholder="补充说明">${escapeHtml(todo?.description || '')}</textarea>
    <input name="tags" placeholder="标签，以逗号分隔" value="${escapeHtml((todo?.tags || []).join(','))}" />
    <select name="priority">${[0, 1, 2, 3].map((priority) => `<option value="${priority}" ${Number(todo?.priority || 0) === priority ? 'selected' : ''}>${priority === 0 ? '普通' : `P${priority}${priority === 3 ? ' 紧急' : ''}`}</option>`).join('')}</select>
    <div class="toolbar"><button class="primary">保存</button><button type="button" class="secondary" id="cancel">取消</button></div></form>`;
  document.body.append(overlay);
  overlay.querySelector('#cancel').onclick = () => overlay.remove();
  overlay.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = {
      title: form.get('title'), description: form.get('description'),
      tags: String(form.get('tags')).split(',').map((tag) => tag.trim()).filter(Boolean),
      priority: Number(form.get('priority'))
    };
    await api.request('/v1/todos', { method: 'POST', body: {
      scope, projectId: scope === 'repository' ? context.repository.projectId : null,
      operation: todo ? 'update' : 'add', id: todo?.id, idempotencyKey: crypto.randomUUID(),
      ...(todo ? { patch: value } : { todo: value })
    } });
    overlay.remove();
    await navigate('todos', { scope });
  };
}

async function refreshProjectChrome() {
  const data = await api.request('/v1/projects');
  applicationState.projects = data.projects;
  const current = applicationState.context.repository;
  const list = document.querySelector('#project-list');
  const filter = document.querySelector('#project-search')?.value.trim().toLowerCase() || '';
  const projects = data.projects.filter((project) => !filter || `${project.repositoryName} ${project.repoRoot || project.cwd}`.toLowerCase().includes(filter));
  const globalEntry = document.querySelector('#global-todos-entry');
  globalEntry.classList.toggle('active', applicationState.globalSelected);
  globalEntry.setAttribute('aria-current', applicationState.globalSelected ? 'page' : 'false');
  globalEntry.onclick = selectGlobalTodos;
  list.innerHTML = projects.map((project) => {
    const active = !applicationState.globalSelected && project.projectId === current.projectId;
    const initials = (project.repositoryName || 'P').slice(0, 2).toUpperCase();
    const projectKind = project.syncGitHub ? 'GitHub' : project.isGitRepository ? 'Git' : '本地目录';
    return `<button class="project-button ${active ? 'active' : ''}" role="option" aria-selected="${active}" data-project-id="${escapeHtml(project.projectId)}" data-project-path="${escapeHtml(project.repoRoot || project.cwd)}" title="${escapeHtml(project.repositoryName)}\n${escapeHtml(project.repoRoot || project.cwd)}\n右键移除">
      <span class="selection-indicator"></span><span class="project-avatar">${escapeHtml(initials)}<i class="project-state ${project.syncGitHub ? 'connected' : ''}"></i></span>
      <span class="project-copy"><strong>${escapeHtml(project.repositoryName)}</strong><small>${projectKind} · ${escapeHtml(project.repoRoot || project.cwd)}</small></span>
      ${project.pinned ? `<span class="project-pin" title="已收藏">${icon('pin')}</span>` : ''}</button>`;
  }).join('') || `<div class="project-filter-empty">没有匹配的项目</div>`;
  list.querySelectorAll('[data-project-path]').forEach((button) => {
    button.onclick = () => switchWorkspace(button.dataset.projectPath);
    button.oncontextmenu = async (event) => {
      event.preventDefault();
      if (!window.confirm('从 LocalBoard 项目栏移除此项目？不会删除磁盘文件。')) return;
      await api.request(`/v1/projects/${encodeURIComponent(button.dataset.projectId)}`, { method: 'DELETE' });
      await refreshProjectChrome();
    };
  });
  renderFeatureNavigation();
  updateWorkspacePill();
  await refreshServiceBadge();
}

function renderFeatureNavigation() {
  const repository = applicationState.context.repository;
  const entries = [
    ...(repository.isGitRepository ? [['todos', '仓库待办', 'todo']] : []),
    ...(repository.isGitRepository ? [['git', '源代码管理', 'branch']] : []),
    ...(repository.githubConfigured ? [
      ['project', 'GitHub Projects', 'board'], ['issues', 'Issues', 'issue'], ['prs', 'Pull Requests', 'pull-request'], ['actions', 'Actions', 'play']
    ] : []),
    ['agents', 'Codex / Agents', 'robot'], ['notes', '执行便签', 'note'], ['settings', '设置', 'settings']
  ];
  const nav = document.querySelector('#feature-nav');
  document.querySelector('#project-kind').textContent = repository.projectKind === 'github' ? 'GitHub 仓库' : repository.projectKind === 'git' ? '本地 Git 仓库' : '非 Git 路径';
  nav.innerHTML = `<div class="workspace-actions"><button data-project-pin>${icon(repository.pinned ? 'unpin' : 'pin')}<span>${repository.pinned ? '取消收藏项目' : '收藏此项目'}</span></button></div>` + entries.map(([tab, label, glyph]) => `<button data-tab="${tab}" class="${applicationState.active === tab ? 'active' : ''}">${icon(glyph)}<span>${label}</span></button>`).join('') + githubAuthPanel(repository);
  nav.querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => navigate(button.dataset.tab));
  nav.querySelector('[data-project-pin]').onclick = async () => {
    applicationState.context.repository = await api.request(`/v1/projects/${encodeURIComponent(repository.projectId)}`, {
      method: 'PATCH', body: { pinned: !repository.pinned }
    });
    await refreshProjectChrome();
  };
  nav.querySelector('[data-gh-login]')?.addEventListener('click', async () => {
    await api.githubAuth('login');
    showError(new Error('已打开 GitHub CLI 登录窗口。完成登录后点击“刷新状态”。'));
  });
  nav.querySelector('[data-gh-refresh]')?.addEventListener('click', () => refreshCurrentContext());
  nav.querySelector('[data-gh-switch]')?.addEventListener('click', async (event) => {
    const select = nav.querySelector('[data-gh-account]');
    if (!select?.value) return;
    await api.request(`/v1/projects/${encodeURIComponent(repository.projectId)}`, {
      method: 'PATCH', body: { githubAccount: select.value }
    });
    await api.githubAuth('switch', select.value);
    showError(new Error(`已打开 gh 账户切换窗口；切换到 ${select.value} 后刷新状态。`));
  });
}

function githubAuthPanel(repository) {
  if (!repository.githubConfigured) return '';
  if (repository.syncGitHub) return `<div class="auth-card ok"><span>gh 已连接</span><strong>${escapeHtml(repository.activeGithubAccount || '')}</strong><button data-gh-refresh>刷新状态</button></div>`;
  const accounts = repository.githubAuthAccounts || [];
  return `<div class="auth-card"><strong>${repository.ghAvailable === false ? '未找到 GitHub CLI' : 'GitHub 需要登录或刷新'}</strong>
    <span>${escapeHtml(syncLabel(repository))}</span>
    ${accounts.length ? `<select data-gh-account>${accounts.map((account) => `<option ${account === repository.expectedGithubAccount ? 'selected' : ''}>${escapeHtml(account)}</option>`).join('')}</select><button data-gh-switch>绑定并切换 gh</button>` : '<button data-gh-login>登录 GitHub</button>'}
    <button data-gh-refresh>刷新状态</button></div>`;
}

async function refreshCurrentContext() {
  applicationState.context = await api.context(applicationState.context.cwd, true);
  await refreshProjectChrome();
  await navigate(applicationState.active);
}

async function refreshServiceBadge() {
  try {
    const status = await api.request('/v1/status');
    document.querySelector('#agent-count').textContent = status.agents.connected;
  } catch {
    document.querySelector('.connection .dot')?.classList.add('offline');
  }
}

async function loadStatus(loadId) {
  const status = await api.request('/v1/status');
  const view = currentView(loadId);
  if (!view) return;
  const counts = status.agents.counts || {};
  const integrationRows = status.integrations?.results ? Object.entries(status.integrations.results).map(([name, value]) => `<div class="row"><div><strong>${escapeHtml(name)}</strong><div class="meta">${value.ok ? '已配置' : escapeHtml(value.error)}</div></div><span class="badge">${value.ok ? '正常' : '需处理'}</span></div>`).join('') : '<div class="empty">源码运行模式；安装包首次启动后会显示客户端注入状态。</div>';
  view.innerHTML = `<div class="metric-grid">
    <article class="metric"><span>LocalBoard 服务</span><strong>运行中</strong><small>PID ${status.broker.pid} · v${status.broker.version}</small></article>
    <article class="metric"><span>已连接 Agent</span><strong>${status.agents.connected}</strong><small>主 Agent ${status.agents.mainAgents} · 子 Agent ${status.agents.subagents}</small></article>
    <article class="metric"><span>执行状态</span><strong>${counts.active || 0} 活跃</strong><small>${counts.waiting || 0} 等待 · ${status.agents.stale || 0} 失联</small></article>
    <article class="metric"><span>已发现项目</span><strong>${status.projects.length}</strong><small>由 Codex / Agent 路径上报自动登记</small></article>
  </div><h2 class="section-title">客户端集成</h2><div class="panel">${integrationRows}</div><h2 class="section-title">执行连接</h2><div class="panel">${status.agents.contexts.length ? status.agents.contexts.map(contextRow).join('') : '<div class="empty">暂无已连接的 Codex / Agent</div>'}</div>`;
}

async function loadGit(context, loadId) {
  if (!context.repository.isGitRepository) throw new Error('当前项目不是 Git 仓库');
  const data = await api.request(`/v1/git/status?projectId=${encodeURIComponent(context.repository.projectId)}`);
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="scope-banner"><strong>${escapeHtml(data.branch)}</strong><span>${data.ahead} ahead · ${data.behind} behind · ${data.changes.length} 个更改（只读）</span></div>
    ${data.todoTracking.ignored ? `<div class="error">.localboard/todos.json 当前被 Git 忽略。<button class="secondary" id="repair-ignore">修复忽略规则</button></div>` : ''}
    <div class="panel">${data.changes.length ? data.changes.map((change) => `<button class="git-change" data-git-path="${escapeHtml(change.path)}" data-staged="${change.staged}"><span class="git-code">${escapeHtml(change.indexStatus + change.worktreeStatus)}</span><strong>${escapeHtml(change.path)}</strong><small>${change.staged ? '已暂存' : change.untracked ? '未跟踪' : '工作区'}</small></button>`).join('') : '<div class="empty">工作区干净</div>'}</div><pre class="diff" id="git-diff">选择文件查看 diff。LocalBoard 不会暂存、提交或推送。</pre>`;
  document.querySelector('#repair-ignore')?.addEventListener('click', async () => {
    await api.request('/v1/git/repair-todo-ignore', { method: 'POST', body: { projectId: context.repository.projectId } });
    await navigate('git');
  });
  document.querySelectorAll('[data-git-path]').forEach((button) => button.onclick = async () => {
    const query = new URLSearchParams({ projectId: context.repository.projectId, path: button.dataset.gitPath, staged: button.dataset.staged });
    const diff = await api.request(`/v1/git/diff?${query}`);
    document.querySelector('#git-diff').textContent = diff.diff || (button.dataset.staged === 'true' ? '该暂存文件无可显示 diff。' : '未跟踪文件暂不生成 diff。');
  });
}

async function loadAgents(loadId) {
  const data = await api.request('/v1/events?limit=100');
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="panel">${data.events.length ? data.events.map((event) => `
    <div class="row"><div><strong>${escapeHtml(event.eventName)}</strong><div class="meta">${escapeHtml(event.sessionId || 'unknown session')} · ${escapeHtml(event.cwd || '')}</div></div><time class="meta">${escapeHtml(event.createdAt)}</time></div>`).join('') : '<div class="empty">尚未收到 Codex 生命周期事件</div>'}</div>`;
}

async function loadNotes(loadId) {
  const data = await api.request('/v1/contexts?includeEnded=true');
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="toolbar"><button class="primary" id="open-note">打开唯一执行便签</button></div>
    <div class="panel">${data.contexts.length ? data.contexts.map(contextRow).join('') : '<div class="empty">尚未收到 Codex 执行路径</div>'}</div>`;
  document.querySelector('#open-note').onclick = () => api.openSticky({});
  document.querySelectorAll('[data-switch-workspace]').forEach((button) => {
    button.onclick = () => switchWorkspace(button.dataset.switchWorkspace);
  });
  document.querySelectorAll('[data-remove-context]').forEach((button) => {
    button.onclick = async () => {
      await api.request(`/v1/contexts/${encodeURIComponent(button.dataset.removeContext)}`, { method: 'DELETE' });
      await navigate('notes');
    };
  });
}

async function loadSettings(loadId) {
  const response = await api.request('/v1/settings');
  if (!currentView(loadId)) return;
  applicationState.settings = { ...defaultSettings(), ...response.settings, sticky: { ...defaultSettings().sticky, ...response.settings?.sticky } };
  const settings = applicationState.settings;
  document.querySelector('#view').innerHTML = `<div class="settings-stack">
    <section class="settings-group"><div><h2>外观</h2><p>跟随 Windows 个性化设置，并在支持时使用 Mica 背景。</p></div>
      <label class="setting-row"><span><strong>应用主题</strong><small>系统、浅色或深色</small></span><select name="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label class="setting-row"><span><strong>Mica 材质</strong><small>不支持时自动使用纯色背景</small></span><input type="checkbox" name="mica" /></label>
    </section>
    <section class="settings-group"><div><h2>应用行为</h2><p>控制启动方式与主窗口关闭后的行为。</p></div>
      <label class="setting-row"><span><strong>开机自动启动</strong><small>后台启动 Broker 与托盘</small></span><input type="checkbox" name="autoStart" /></label>
      <label class="setting-row"><span><strong>关闭到托盘</strong><small>关闭主窗体后继续接收 Agent 上报</small></span><input type="checkbox" name="closeToTray" /></label>
    </section>
    <section class="settings-group"><div><h2>执行便签</h2><p>调整吸附灵敏度、收缩速度和默认尺寸。</p></div>
      <label class="setting-row"><span><strong>吸附距离</strong><small><output data-output="snapDistance">${settings.sticky.snapDistance}px</output></small></span><input type="range" name="snapDistance" min="0" max="64" step="1" value="${settings.sticky.snapDistance}" /></label>
      <label class="setting-row"><span><strong>收缩延时</strong><small><output data-output="collapseDelay">${settings.sticky.collapseDelay}ms</output></small></span><input type="range" name="collapseDelay" min="0" max="3000" step="100" value="${settings.sticky.collapseDelay}" /></label>
      <label class="setting-row"><span><strong>边缘把手</strong><small><output data-output="handleWidth">${settings.sticky.handleWidth}px</output></small></span><input type="range" name="handleWidth" min="4" max="32" step="1" value="${settings.sticky.handleWidth}" /></label>
      <label class="setting-row"><span><strong>默认尺寸</strong><small>下次新建便签时使用</small></span><select name="defaultPreset"><option value="small">小 · 320 × 480</option><option value="medium">中 · 400 × 680</option><option value="large">大 · 520 × 820</option></select></label>
      <label class="setting-row"><span><strong>减少动画</strong><small>立即完成展开和收缩</small></span><input type="checkbox" name="reduceMotion" /></label>
    </section>
    <div class="settings-actions"><button class="secondary" id="reset-settings">${icon('refresh')}恢复默认设置</button><span id="settings-saved" role="status"></span></div>
  </div>`;
  const view = document.querySelector('#view');
  for (const name of ['theme', 'mica', 'autoStart', 'closeToTray']) {
    const control = view.querySelector(`[name="${name}"]`);
    if (control.type === 'checkbox') control.checked = Boolean(settings[name]);
    else control.value = settings[name];
  }
  for (const name of ['snapDistance', 'collapseDelay', 'handleWidth', 'defaultPreset', 'reduceMotion']) {
    const control = view.querySelector(`[name="${name}"]`);
    if (control.type === 'checkbox') control.checked = Boolean(settings.sticky[name]);
    else control.value = settings.sticky[name];
  }
  view.querySelectorAll('input, select').forEach((control) => {
    control.addEventListener(control.type === 'range' ? 'input' : 'change', async () => {
      const isSticky = ['snapDistance', 'collapseDelay', 'handleWidth', 'defaultPreset', 'reduceMotion'].includes(control.name);
      const value = control.type === 'checkbox' ? control.checked : control.type === 'range' ? Number(control.value) : control.value;
      if (control.type === 'range') view.querySelector(`[data-output="${control.name}"]`).textContent = `${value}${control.name === 'collapseDelay' ? 'ms' : 'px'}`;
      const patch = isSticky ? { sticky: { [control.name]: value } } : { [control.name]: value };
      const saved = await api.request('/v1/settings', { method: 'PATCH', body: patch });
      applicationState.settings = saved.settings;
      applyAppearance(saved.settings);
      const status = view.querySelector('#settings-saved');
      status.textContent = '已保存';
      setTimeout(() => { if (status.isConnected) status.textContent = ''; }, 1200);
    });
  });
  view.querySelector('#reset-settings').onclick = async () => {
    const reset = await api.request('/v1/settings', { method: 'DELETE' });
    applicationState.settings = reset.settings;
    applyAppearance(reset.settings);
    await loadSettings(loadId);
  };
}

function defaultSettings() {
  return { theme: 'system', mica: true, autoStart: true, closeToTray: true, projectPaneExpanded: false,
    sticky: { snapDistance: 16, collapseDelay: 700, handleWidth: 12, defaultPreset: 'medium', reduceMotion: false } };
}

function applyAppearance(settings) {
  document.documentElement.dataset.theme = settings.theme || 'system';
  document.documentElement.classList.toggle('reduce-motion', Boolean(settings.sticky?.reduceMotion));
  api.applyAppearance?.(settings);
}

async function toggleProjectPane() {
  const shell = document.querySelector('.shell');
  const expanded = !shell.classList.contains('project-pane-expanded');
  shell.classList.toggle('project-pane-expanded', expanded);
  const saved = await api.request('/v1/settings', { method: 'PATCH', body: { projectPaneExpanded: expanded } });
  applicationState.settings = saved.settings;
  (expanded ? document.querySelector('#project-search') : document.querySelector('#toggle-project-pane'))?.focus();
}

async function loadProject(context, loadId, options) {
  const github = requireGitHub(context);
  const linked = github.projectNumber ? null : await githubRequest({ action: 'project.listForRepository', owner: github.owner,
    repo: github.repo, refresh: options.refresh === true });
  const selectedProjectId = options.projectId || linked?.find((item) => context.repository.favoriteProjects?.includes(item.id))?.id || linked?.[0]?.id;
  if (linked && !selectedProjectId) {
    const view = currentView(loadId);
    if (view) view.innerHTML = '<div class="empty">这个仓库没有关联 GitHub Project。可在 GitHub 中关联后刷新。</div>';
    return;
  }
  const project = linked
    ? linked.find((item) => item.id === selectedProjectId)
    : await githubRequest({ action: 'project.get', ownerType: github.ownerType, owner: github.projectOwner,
      projectNumber: github.projectNumber, refresh: options.refresh === true });
  const items = await githubRequest({ action: 'project.items', projectId: project.id, refresh: options.refresh === true });
  const statusField = project.fields.nodes.find((field) => field.name.toLowerCase() === 'status' && field.options);
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="toolbar">${linked ? `<select id="project-picker">${linked.map((item) => `<option value="${item.id}" ${item.id === project.id ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select>` : `<span class="badge">${escapeHtml(project.title)}</span>`}<button class="secondary" id="favorite-project">${context.repository.favoriteProjects?.includes(project.id) ? '取消书签' : '加入书签'}</button><button class="secondary" id="refresh-project">刷新</button></div>
    <div class="panel">${items.length ? items.map((item) => projectRow(item, statusField)).join('') : '<div class="empty">Project 中没有项目</div>'}</div>`;
  document.querySelector('#project-picker')?.addEventListener('change', (event) => navigate('project', { projectId: event.target.value }));
  document.querySelector('#refresh-project').onclick = () => navigate('project', { refresh: true, projectId: project.id });
  document.querySelector('#favorite-project').onclick = async () => {
    const favorites = new Set(context.repository.favoriteProjects || []);
    if (favorites.has(project.id)) favorites.delete(project.id); else favorites.add(project.id);
    context.repository = await api.request(`/v1/projects/${encodeURIComponent(context.repository.projectId)}`, {
      method: 'PATCH', body: { favoriteProjects: [...favorites] }
    });
    await navigate('project', { projectId: project.id });
  };
  document.querySelectorAll('[data-project-status]').forEach((select) => select.onchange = async () => {
    select.disabled = true;
    try {
      await githubRequest({ action: 'project.setField', projectId: project.id, itemId: select.dataset.projectStatus,
        fieldId: statusField.id, valueType: 'single-select', value: select.value,
        expectedUpdatedAt: select.dataset.updatedAt, idempotencyKey: crypto.randomUUID() });
      await navigate('project');
    } catch (error) {
      showError(error);
      select.disabled = false;
    }
  });
  document.querySelectorAll('[data-edit-fields]').forEach((button) => button.onclick = () => {
    const item = items.find((candidate) => candidate.id === button.dataset.editFields);
    projectFieldDialog(project, item);
  });
  document.querySelectorAll('[data-edit-project]').forEach((button) => button.onclick = async () => {
    try {
      const item = items.find((candidate) => candidate.id === button.dataset.editProject);
      const title = window.prompt('修改标题', item.content.title);
      if (!title || title === item.content.title) return;
      if (item.content.number && item.content.repository) {
        const [owner, repo] = item.content.repository.nameWithOwner.split('/');
        await githubRequest({ action: 'issue.update', owner, repo, number: item.content.number, title,
          idempotencyKey: crypto.randomUUID() });
      } else {
        await githubRequest({ action: 'project.updateDraft', draftIssueId: item.content.id, title,
          expectedUpdatedAt: item.content.updatedAt, idempotencyKey: crypto.randomUUID() });
      }
      await navigate('project');
    } catch (error) {
      showError(error);
    }
  });
}

function projectRow(item, statusField) {
  const content = item.content ?? { title: '(无权访问的项目)' };
  const current = statusField && item.fieldValues.nodes.find((value) => value.field?.id === statusField.id)?.optionId;
  const editable = content.id && (!content.repository || content.__typename !== 'PullRequest');
  return `<div class="row"><div><strong>${escapeHtml(content.title)}</strong><div class="meta">${escapeHtml(content.repository?.nameWithOwner || 'Project draft')} ${content.number ? `#${content.number}` : ''}</div></div>
    <div class="row-actions">${statusField ? `<select data-project-status="${item.id}" data-updated-at="${escapeHtml(item.updatedAt)}">${statusField.options.map((option) => `<option value="${option.id}" ${option.id === current ? 'selected' : ''}>${escapeHtml(option.name)}</option>`).join('')}</select>` : ''}
    <button class="secondary" data-edit-fields="${item.id}">字段</button>${editable ? `<button class="secondary" data-edit-project="${item.id}">编辑标题</button>` : ''}</div></div>`;
}

function projectFieldDialog(project, item) {
  const fields = project.fields.nodes.filter((field) => ['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION'].includes(field.dataType));
  if (!fields.length) return showError(new Error('这个 Project 没有可编辑字段'));
  const overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form class="dialog form"><h2>编辑 Project 字段</h2><div class="meta">${escapeHtml(item.content?.title || 'Project item')}</div>
    <label>字段<select name="field">${fields.map((field) => `<option value="${field.id}">${escapeHtml(field.name)} · ${escapeHtml(field.dataType)}</option>`).join('')}</select></label>
    <label>值<div id="project-field-value"></div></label>
    <div class="toolbar"><button class="primary">保存</button><button type="button" class="secondary" id="clear-field">清空</button><button type="button" class="secondary" id="cancel">取消</button></div></form>`;
  document.body.append(overlay);
  const fieldSelect = overlay.querySelector('[name="field"]');
  const valueHost = overlay.querySelector('#project-field-value');
  const renderValue = () => {
    const field = fields.find((candidate) => candidate.id === fieldSelect.value);
    const current = item.fieldValues.nodes.find((value) => value.field?.id === field.id);
    if (field.dataType === 'SINGLE_SELECT') {
      valueHost.innerHTML = `<select name="value" required>${field.options.map((option) => `<option value="${option.id}" ${option.id === current?.optionId ? 'selected' : ''}>${escapeHtml(option.name)}</option>`).join('')}</select>`;
    } else if (field.dataType === 'ITERATION') {
      valueHost.innerHTML = `<select name="value" required>${field.configuration.iterations.map((iteration) => `<option value="${iteration.id}" ${iteration.id === current?.iterationId ? 'selected' : ''}>${escapeHtml(iteration.title)}</option>`).join('')}</select>`;
    } else {
      const type = field.dataType === 'NUMBER' ? 'number' : field.dataType === 'DATE' ? 'date' : 'text';
      const value = current?.number ?? current?.date ?? current?.text ?? '';
      valueHost.innerHTML = `<input name="value" type="${type}" value="${escapeHtml(value)}" required />`;
    }
  };
  renderValue();
  fieldSelect.onchange = renderValue;
  overlay.querySelector('#cancel').onclick = () => overlay.remove();
  overlay.querySelector('#clear-field').onclick = async () => {
    const field = fields.find((candidate) => candidate.id === fieldSelect.value);
    await mutateProjectField({ action: 'project.clearField', projectId: project.id, itemId: item.id, fieldId: field.id,
      expectedUpdatedAt: item.updatedAt, idempotencyKey: crypto.randomUUID() }, overlay);
  };
  overlay.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const field = fields.find((candidate) => candidate.id === fieldSelect.value);
    const value = new FormData(event.currentTarget).get('value');
    const valueType = { TEXT: 'text', NUMBER: 'number', DATE: 'date', SINGLE_SELECT: 'single-select', ITERATION: 'iteration' }[field.dataType];
    await mutateProjectField({ action: 'project.setField', projectId: project.id, itemId: item.id, fieldId: field.id,
      valueType, value, expectedUpdatedAt: item.updatedAt, idempotencyKey: crypto.randomUUID() }, overlay);
  };
}

async function mutateProjectField(request, overlay) {
  try {
    await githubRequest(request);
    overlay.remove();
    await navigate('project');
  } catch (error) {
    showError(error);
  }
}

async function loadIssues(context, loadId, options) {
  const github = requireGitHub(context);
  const items = await githubRequest({ action: 'issue.list', owner: github.owner, repo: github.repo, state: 'open', refresh: options.refresh === true });
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="toolbar"><button class="primary" id="new-issue">新建 Issue</button><button class="secondary" id="refresh-issues">刷新</button></div>
    <div class="panel">${items.length ? items.map((issue) => `<div class="row"><div><strong>#${issue.number} ${escapeHtml(issue.title)}</strong><div class="meta">${issue.labels.map((label) => escapeHtml(label.name)).join(' · ')}</div></div><div class="row-actions"><button class="secondary" data-edit-issue="${issue.number}">编辑</button><button class="secondary" data-close-issue="${issue.number}">关闭</button></div></div>`).join('') : '<div class="empty">没有打开的 Issue</div>'}</div>`;
  document.querySelector('#refresh-issues').onclick = () => navigate('issues', { refresh: true });
  document.querySelector('#new-issue').onclick = () => issueDialog(context);
  document.querySelectorAll('[data-edit-issue]').forEach((button) => button.onclick = async () => {
    const issue = items.find((item) => item.number === Number(button.dataset.editIssue));
    const title = window.prompt('Issue 标题', issue.title);
    if (!title) return;
    const body = window.prompt('Issue 内容', issue.body || '');
    if (body === null) return;
    await githubRequest({ action: 'issue.update', owner: github.owner, repo: github.repo, number: issue.number,
      title, body, idempotencyKey: crypto.randomUUID() });
    await navigate('issues');
  });
  document.querySelectorAll('[data-close-issue]').forEach((button) => button.onclick = async () => {
    try {
      await githubRequest({ action: 'issue.close', owner: github.owner, repo: github.repo, number: Number(button.dataset.closeIssue),
        reason: 'completed', idempotencyKey: crypto.randomUUID() });
      await navigate('issues');
    } catch (error) {
      showError(error);
    }
  });
}

function issueDialog(context) {
  const github = requireGitHub(context);
  const overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form class="dialog form"><h2>新建 Issue</h2><input name="title" placeholder="标题" required autofocus /><textarea name="body" placeholder="问题描述"></textarea>
    <div class="toolbar"><button class="primary">提交到 GitHub</button><button type="button" class="secondary" id="cancel">取消</button></div></form>`;
  document.body.append(overlay);
  overlay.querySelector('#cancel').onclick = () => overlay.remove();
  overlay.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await githubRequest({ action: 'issue.create', owner: github.owner, repo: github.repo, title: form.get('title'), body: form.get('body'),
      idempotencyKey: crypto.randomUUID() });
    overlay.remove();
    await navigate('issues');
  };
}

async function loadPullRequests(context, loadId, options) {
  const github = requireGitHub(context);
  if (options.number) {
    const [pr, reviews] = await Promise.all([
      githubRequest({ action: 'pr.get', owner: github.owner, repo: github.repo, number: Number(options.number), refresh: options.refresh === true }),
      githubRequest({ action: 'pr.reviews', owner: github.owner, repo: github.repo, number: Number(options.number), refresh: options.refresh === true })
    ]);
    const view = currentView(loadId);
    if (!view) return;
    view.innerHTML = `<div class="toolbar"><button class="secondary" id="back-prs">返回列表</button><button class="danger" id="merge-pr">确认合并</button></div>
      <article class="card"><div class="meta">#${pr.number} · ${escapeHtml(pr.user?.login)} · ${escapeHtml(pr.state)}</div><h3>${escapeHtml(pr.title)}</h3><p>${escapeHtml(pr.body || '')}</p><div class="meta">${escapeHtml(pr.head?.label)} → ${escapeHtml(pr.base?.label)} · ${escapeHtml(pr.mergeable_state || '')}</div></article>
      <h2 class="section-title">Review</h2><div class="panel">${reviews.length ? reviews.map((review) => `<div class="row"><div><strong>${escapeHtml(review.user?.login)}</strong><div class="meta">${escapeHtml(review.state)}</div><p>${escapeHtml(review.body || '')}</p></div></div>`).join('') : '<div class="empty">暂无 Review</div>'}</div>
      <form class="form review-form" id="review-form"><textarea name="body" placeholder="Review 意见"></textarea><select name="event"><option value="COMMENT">评论</option><option value="APPROVE">批准</option><option value="REQUEST_CHANGES">请求修改</option></select><button class="primary">提交 Review</button></form>`;
    document.querySelector('#back-prs').onclick = () => navigate('prs');
    document.querySelector('#merge-pr').onclick = async () => {
      if (!window.confirm(`确认合并 PR #${pr.number}？此操作会修改 GitHub。`)) return;
      await githubRequest({ action: 'pr.merge', owner: github.owner, repo: github.repo, number: pr.number,
        method: 'squash', allowWrite: true, idempotencyKey: crypto.randomUUID() });
      await navigate('prs');
    };
    document.querySelector('#review-form').onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await githubRequest({ action: 'pr.review', owner: github.owner, repo: github.repo, number: pr.number,
        body: form.get('body'), event: form.get('event'), idempotencyKey: crypto.randomUUID() });
      await navigate('prs', { number: pr.number, refresh: true });
    };
    return;
  }
  const items = await githubRequest({ action: 'pr.list', owner: github.owner, repo: github.repo, state: 'open', refresh: options.refresh === true });
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="toolbar"><button class="secondary" id="refresh-prs">刷新</button></div><div class="panel">
    ${items.length ? items.map((pr) => `<div class="row"><div><strong>#${pr.number} ${escapeHtml(pr.title)}</strong><div class="meta">${escapeHtml(pr.user?.login)} · ${pr.draft ? 'Draft' : 'Ready for review'}</div></div><button class="secondary" data-pr-detail="${pr.number}">详情 / Review</button></div>`).join('') : '<div class="empty">没有打开的 Pull Request</div>'}</div>`;
  document.querySelector('#refresh-prs').onclick = () => navigate('prs', { refresh: true });
  document.querySelectorAll('[data-pr-detail]').forEach((button) => button.onclick = () => navigate('prs', { number: Number(button.dataset.prDetail) }));
}

async function loadActions(context, loadId, options) {
  const github = requireGitHub(context);
  if (options.runId) {
    const detail = await githubRequest({ action: 'actions.get', owner: github.owner, repo: github.repo, runId: options.runId, refresh: options.refresh === true });
    const view = currentView(loadId);
    if (!view) return;
    view.innerHTML = `<div class="toolbar"><button class="secondary" id="back-actions">返回列表</button><button class="secondary" id="load-logs">加载日志</button><button class="danger" id="rerun-action">确认重跑</button>${detail.run.status !== 'completed' ? '<button class="danger" id="cancel-action">确认取消</button>' : ''}</div>
      <article class="card"><div class="meta">${escapeHtml(detail.run.event)} · ${escapeHtml(detail.run.head_branch)}</div><h3>${escapeHtml(detail.run.name)}</h3><p>${escapeHtml(detail.run.status)} · ${escapeHtml(detail.run.conclusion || '运行中')}</p></article>
      <div class="panel">${detail.jobs.map((job) => `<div class="row"><div><strong>${escapeHtml(job.name)}</strong><div class="meta">${escapeHtml(job.status)} · ${escapeHtml(job.conclusion || '')}</div>${job.steps?.map((step) => `<small>${step.number}. ${escapeHtml(step.name)} · ${escapeHtml(step.conclusion || step.status)}</small>`).join('<br>') || ''}</div></div>`).join('')}</div><pre class="diff" id="action-logs">点击“加载日志”读取 gh run 日志。</pre>`;
    document.querySelector('#back-actions').onclick = () => navigate('actions');
    document.querySelector('#load-logs').onclick = async () => {
      document.querySelector('#action-logs').textContent = await githubRequest({ action: 'actions.logs', owner: github.owner, repo: github.repo, runId: options.runId, refresh: true });
    };
    document.querySelector('#rerun-action').onclick = async () => {
      if (!window.confirm(`确认重跑 Actions #${options.runId}？`)) return;
      await githubRequest({ action: 'actions.rerun', owner: github.owner, repo: github.repo, runId: options.runId,
        allowWrite: true, idempotencyKey: crypto.randomUUID() });
      await navigate('actions', { runId: options.runId, refresh: true });
    };
    document.querySelector('#cancel-action')?.addEventListener('click', async () => {
      if (!window.confirm(`确认取消 Actions #${options.runId}？`)) return;
      await githubRequest({ action: 'actions.cancel', owner: github.owner, repo: github.repo, runId: options.runId,
        allowWrite: true, idempotencyKey: crypto.randomUUID() });
      await navigate('actions', { runId: options.runId, refresh: true });
    });
    return;
  }
  const data = await githubRequest({ action: 'actions.runs', owner: github.owner, repo: github.repo, perPage: 50, refresh: options.refresh === true });
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="toolbar"><button class="secondary" id="refresh-actions">刷新</button></div><div class="panel">
    ${data.workflow_runs?.length ? data.workflow_runs.map((run) => `<div class="row"><div><strong>${escapeHtml(run.name)}</strong><div class="meta">${escapeHtml(run.head_branch)} · ${escapeHtml(run.event)} · ${escapeHtml(run.head_sha.slice(0, 7))}</div></div><button class="secondary" data-action-detail="${run.id}">${escapeHtml(run.conclusion || run.status)} · 详情</button></div>`).join('') : '<div class="empty">没有 Actions 运行记录</div>'}</div>`;
  document.querySelector('#refresh-actions').onclick = () => navigate('actions', { refresh: true });
  document.querySelectorAll('[data-action-detail]').forEach((button) => button.onclick = () => navigate('actions', { runId: button.dataset.actionDetail }));
}

function requireGitHub(context, requireProject = false) {
  if (!context.github) throw new Error(context.githubError || '请先配置 GitHub 仓库');
  if (requireProject && !context.github.projectNumber) throw new Error('请在 .localboard/config.json 配置 projectNumber');
  return context.github;
}

function githubRequest(body) {
  return api.request('/v1/github', { method: 'POST', body: {
    ...body,
    localRepoRoot: applicationState.context.repository.repoRoot
  }, timeoutMs: 60000 });
}

function currentView(loadId) {
  return applicationState?.loadId === loadId ? document.querySelector('#view') : null;
}

async function switchWorkspace(cwd) {
  if (!cwd) return;
  const switchId = ++applicationState.loadId;
  clearError();
  document.querySelector('#view').innerHTML = '<div class="loading">正在切换仓库…</div>';
  try {
    const context = await api.context(cwd);
    if (switchId !== applicationState.loadId) return;
    applicationState.context = context;
    applicationState.globalSelected = false;
    document.querySelector('.shell').classList.remove('global-workspace');
    localStorage.setItem('localboard.workspace', context.cwd);
    await refreshProjectChrome();
    await navigate(context.repository.isGitRepository ? 'todos' : 'agents');
  } catch (error) {
    if (switchId !== applicationState.loadId) return;
    showError(error);
    document.querySelector('#view').innerHTML = `<div class="empty">无法切换到该仓库：${escapeHtml(error.message)}</div>`;
  }
}

async function selectGlobalTodos() {
  applicationState.globalSelected = true;
  document.querySelector('.shell').classList.add('global-workspace');
  await refreshProjectChrome();
  await navigate('todos', { scope: 'global' });
}

function updateWorkspacePill() {
  const context = applicationState.context;
  const repository = context.repository;
  const name = repository.repositoryName || '非 Git 路径';
  const detail = `${repository.branch || repository.syncReason}${repository.isLinkedWorktree ? ' · worktree' : ''}`;
  const button = document.querySelector('#workspace-switcher');
  const eyebrow = document.querySelector('#workspace-eyebrow');
  if (applicationState.globalSelected) {
    eyebrow.textContent = '个人空间';
    button.hidden = true;
    return;
  }
  eyebrow.textContent = '当前工作区';
  button.hidden = false;
  button.title = `${context.cwd}\n点击查看并切换 Codex 仓库`;
  button.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(detail)} · ${escapeHtml(syncLabel(repository))}</span>`;
}

async function renderActivitySticky(id) {
  const [data, settingsResponse] = await Promise.all([api.request('/v1/notes'), api.request('/v1/settings').catch(() => ({ settings: defaultSettings() }))]);
  const note = data.notes.find((item) => item.id === id);
  if (!note) return app.textContent = '便签不存在';
  const settings = { ...defaultSettings(), ...(settingsResponse.settings || {}), sticky: { ...defaultSettings().sticky, ...(settingsResponse.settings?.sticky || {}) } };
  const sectionIds = ['agents', 'global', 'repository', 'memo'];
  const defaultRatios = [.30, .17, .23, .30];
  const layout = {
    preset: note.layout?.preset || settings.sticky.defaultPreset,
    sectionRatios: normalizeRatios(note.layout?.sectionRatios, defaultRatios),
    collapsedSections: Array.isArray(note.layout?.collapsedSections) ? note.layout.collapsedSections.filter((item) => sectionIds.includes(item)) : []
  };
  document.body.style.background = note.color;
  app.innerHTML = `<div class="sticky" data-edge="${escapeHtml(note.dock?.edge || '')}" data-collapsed="${Boolean(note.dock?.collapsed)}" style="background:${escapeHtml(note.color)};font-size:${note.fontSize}px;--sticky-color:${escapeHtml(note.color)};--dock-handle:${Number(note.dock?.exposedStrip || settings.sticky.handleWidth)}px">
    <div class="edge-handle" aria-hidden="true"><i></i></div>
    <div class="sticky-head"><span class="sticky-title">${icon('note')}${escapeHtml(note.title)}</span><div class="sticky-window-actions">
      <button type="button" data-sticky-toggle="alwaysOnTop" class="${note.alwaysOnTop ? 'selected' : ''}" title="置顶" aria-label="置顶">${icon('pin')}</button>
      <button type="button" data-sticky-toggle="desktopPinned" class="${note.desktopPinned ? 'selected' : ''}" title="显示在所有虚拟桌面" aria-label="显示在所有虚拟桌面">${icon('desktop')}</button>
      <button type="button" id="sticky-more" title="便签设置" aria-label="便签设置" aria-expanded="false">${icon('more')}</button>
      <button type="button" data-window-action="minimize" title="最小化" aria-label="最小化">${icon('minimize')}</button>
      <button type="button" data-window-action="hide" title="隐藏；可从主窗口再次打开" aria-label="隐藏">${icon('close')}</button></div></div>
    <div class="sticky-command-menu" id="sticky-command-menu" hidden>
      <div class="command-label">窗口大小</div><div class="size-presets">${[['small','小'],['medium','中'],['large','大']].map(([value,label]) => `<button data-preset="${value}" class="${layout.preset === value ? 'selected' : ''}">${label}</button>`).join('')}</div>
      <div class="command-row"><span>字号</span><button data-font="down" title="缩小字号">${icon('text-decrease')}</button><button data-font="up" title="放大字号">${icon('text-increase')}</button></div>
      <label class="command-row"><span>颜色</span><input type="color" id="sticky-color" value="${escapeHtml(note.color)}" title="便签颜色" /></label>
      <button class="command-wide" data-sticky-window="undock">${icon('unpin')}解除屏幕吸附</button>
    </div>
    <div class="sticky-sections" id="sticky-sections">
      ${stickySection('agents', `Codex 执行 <span id="sticky-agent-count"></span>`, `<div class="sticky-contexts" id="sticky-contexts"></div>`, layout)}
      <div class="section-resizer" data-resizer="0" role="separator" aria-orientation="horizontal" tabindex="0"></div>
      ${stickySection('global', '全局个人待办', `<form class="quick-add" data-quick-add="global"><input aria-label="新增全局待办" placeholder="新增全局待办，按 Enter 保存" /><button title="新增">${icon('add')}</button></form><div id="sticky-global-todos"></div>`, layout)}
      <div class="section-resizer" data-resizer="1" role="separator" aria-orientation="horizontal" tabindex="0"></div>
      ${stickySection('repository', '仓库待办', `<div class="bookmark-tabs" id="sticky-bookmarks" role="tablist" aria-label="切换仓库待办"></div><div id="sticky-repo-todos"></div>`, layout)}
      <div class="section-resizer" data-resizer="2" role="separator" aria-orientation="horizontal" tabindex="0"></div>
      ${stickySection('memo', '便签', `<textarea aria-label="共享便签内容" placeholder="支持 Markdown 与 - [ ] 清单；Codex 不会覆盖这里">${escapeHtml(note.body)}</textarea>`, layout, 'memo')}
    </div><div class="sticky-foot"><span>本地保存 · 自动保存</span><span id="sticky-dock-label">${note.dock?.edge ? `已吸附${dockEdgeLabel(note.dock.edge)}` : '自由窗口'}</span></div></div>`;
  const textarea = document.querySelector('textarea');
  let preferences = { ...note };
  const stickyRoot = document.querySelector('.sticky');
  const commandMenu = document.querySelector('#sticky-command-menu');
  const moreButton = document.querySelector('#sticky-more');
  setSectionGrid(layout);
  stickyRoot.addEventListener('mouseenter', () => api.stickyPointer?.(true));
  stickyRoot.addEventListener('mouseleave', () => api.stickyPointer?.(false));
  stickyRoot.addEventListener('focusin', () => api.stickyWindow?.('interaction', { active: true }));
  stickyRoot.addEventListener('focusout', () => setTimeout(() => {
    if (!stickyRoot.contains(document.activeElement)) api.stickyWindow?.('interaction', { active: false });
  }));
  moreButton.onclick = () => {
    const opened = commandMenu.hidden;
    commandMenu.hidden = !opened;
    moreButton.setAttribute('aria-expanded', String(opened));
    api.stickyPointer?.(true);
  };
  document.querySelectorAll('[data-window-action]').forEach((button) => {
    button.addEventListener('click', () => api.windowAction(button.dataset.windowAction));
  });
  document.querySelectorAll('[data-sticky-window]').forEach((button) => button.onclick = () => api.stickyWindow?.(button.dataset.stickyWindow));
  document.querySelectorAll('[data-preset]').forEach((button) => button.onclick = async () => {
    layout.preset = button.dataset.preset;
    document.querySelectorAll('[data-preset]').forEach((item) => item.classList.toggle('selected', item === button));
    await api.stickyWindow?.('preset', { preset: layout.preset });
    await persistStickyLayout(note.id, layout);
  });
  document.querySelectorAll('[data-sticky-toggle]').forEach((button) => button.onclick = async () => {
    const key = button.dataset.stickyToggle;
    preferences[key] = !preferences[key];
    preferences = await api.stickyPreferences({ [key]: preferences[key] });
    button.classList.toggle('selected', preferences[key]);
  });
  document.querySelectorAll('[data-font]').forEach((button) => button.onclick = async () => {
    const fontSize = Math.max(11, Math.min(24, preferences.fontSize + (button.dataset.font === 'up' ? 1 : -1)));
    preferences = await api.stickyPreferences({ fontSize });
    document.querySelector('.sticky').style.fontSize = `${preferences.fontSize}px`;
  });
  document.querySelector('#sticky-color').oninput = async (event) => {
    preferences = await api.stickyPreferences({ color: event.target.value });
    document.querySelector('.sticky').style.background = preferences.color;
    document.querySelector('.sticky').style.setProperty('--sticky-color', preferences.color);
    document.body.style.background = preferences.color;
  };
  document.querySelectorAll('[data-section-toggle]').forEach((button) => button.onclick = async () => {
    const sectionId = button.dataset.sectionToggle;
    const collapsed = layout.collapsedSections.includes(sectionId);
    layout.collapsedSections = collapsed ? layout.collapsedSections.filter((item) => item !== sectionId) : [...layout.collapsedSections, sectionId];
    document.querySelector(`[data-section="${sectionId}"]`).classList.toggle('collapsed', !collapsed);
    button.setAttribute('aria-expanded', String(collapsed));
    button.innerHTML = icon(collapsed ? 'chevron-up' : 'chevron-down');
    setSectionGrid(layout);
    await persistStickyLayout(note.id, layout);
  });
  installSectionResizers(layout, note.id);
  let selectedStickyProjectId = null;
  const refreshSticky = async () => {
    try {
      const [contexts, todos, projects] = await Promise.all([
        api.request('/v1/contexts?includeEnded=false'),
        api.request('/v1/todos?scope=global'),
        api.request('/v1/projects')
      ]);
      document.querySelector('#sticky-agent-count').textContent = contexts.contexts.length ? `· ${contexts.contexts.length}` : '';
      stickyRoot.dataset.agentState = contexts.contexts.some((item) => item.status === 'active') ? 'active'
        : contexts.contexts.some((item) => item.status === 'interrupted') ? 'error'
          : contexts.contexts.length ? 'idle' : 'offline';
      document.querySelector('#sticky-contexts').innerHTML = contexts.contexts.length ? contexts.contexts.map(contextCard).join('')
        : '<div class="sticky-empty">等待 Codex 上报执行路径…</div>';
      document.querySelector('#sticky-global-todos').innerHTML = todos.todos.length ? todos.todos.slice(0, 8).map((todo) => stickyTodo(todo, 'global')).join('') : '<div class="sticky-empty">暂无全局待办</div>';
      document.querySelectorAll('#sticky-global-todos [data-open-todo]').forEach((button) => button.onclick = async (event) => {
        event.stopPropagation();
        await api.stickyWindow?.('open-main', { tab: 'todos', scope: 'global' });
      });
      const summaries = await Promise.all(projects.projects.filter((project) => project.isGitRepository).slice(0, 12).map(async (project) => {
        const repoTodos = await api.request(`/v1/todos?scope=repository&projectId=${encodeURIComponent(project.projectId)}`).catch(() => ({ todos: [] }));
        return { project, todos: repoTodos.todos };
      }));
      if (!summaries.some(({ project }) => project.projectId === selectedStickyProjectId)) {
        selectedStickyProjectId = summaries[0]?.project.projectId || null;
      }
      const tabs = document.querySelector('#sticky-bookmarks');
      tabs.innerHTML = summaries.length ? summaries.map(({ project }) => `<button type="button" role="tab"
        aria-selected="${project.projectId === selectedStickyProjectId}" class="${project.projectId === selectedStickyProjectId ? 'active' : ''}"
        data-sticky-project="${escapeHtml(project.projectId)}" title="${escapeHtml(project.repoRoot)}">${escapeHtml(project.repositoryName)}${project.syncGitHub ? '<i></i>' : ''}</button>`).join('')
        : '<div class="sticky-empty">等待 Codex 从仓库目录启动…</div>';
      const renderRepositoryTodos = () => {
        const selected = summaries.find(({ project }) => project.projectId === selectedStickyProjectId);
        const host = document.querySelector('#sticky-repo-todos');
        if (!selected) return host.innerHTML = '';
        host.innerHTML = `<form class="quick-add" data-quick-add="repository"><input aria-label="新增仓库待办" placeholder="新增到 ${escapeHtml(selected.project.repositoryName)}" /><button title="新增">${icon('add')}</button></form>` + (selected.todos.length
          ? selected.todos.slice(0, 10).map((todo) => stickyTodo(todo, 'repository')).join('')
          : '<div class="sticky-empty compact">该仓库暂无个人待办</div>');
        host.querySelectorAll('[data-repo-todo]').forEach((button) => button.onclick = async () => {
          const todo = selected.todos.find((item) => item.id === button.dataset.repoTodo);
          await api.request('/v1/todos', { method: 'POST', body: {
            scope: 'repository', projectId: selected.project.projectId, operation: 'update', id: todo.id,
            idempotencyKey: crypto.randomUUID(), patch: { status: todo.status === 'done' ? 'open' : 'done' }
          } });
          await refreshSticky();
        });
        installQuickAdd(host.querySelector('[data-quick-add="repository"]'), 'repository', selected.project.projectId, refreshSticky);
        host.querySelectorAll('[data-open-todo]').forEach((button) => button.onclick = async (event) => {
          event.stopPropagation();
          await api.stickyWindow?.('open-main', { cwd: selected.project.repoRoot || selected.project.cwd, tab: 'todos', scope: 'repository' });
        });
      };
      tabs.querySelectorAll('[data-sticky-project]').forEach((button) => button.onclick = () => {
        selectedStickyProjectId = button.dataset.stickyProject;
        tabs.querySelectorAll('[data-sticky-project]').forEach((tab) => {
          const active = tab.dataset.stickyProject === selectedStickyProjectId;
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-selected', String(active));
        });
        renderRepositoryTodos();
      });
      renderRepositoryTodos();
      document.querySelectorAll('#sticky-contexts [data-remove-context]').forEach((button) => {
        button.onclick = async () => {
          await api.request(`/v1/contexts/${encodeURIComponent(button.dataset.removeContext)}`, { method: 'DELETE' });
          await refreshSticky();
        };
      });
      document.querySelectorAll('[data-global-todo]').forEach((button) => button.onclick = async () => {
        const todo = todos.todos.find((item) => item.id === button.dataset.globalTodo);
        await api.request('/v1/todos', { method: 'POST', body: { scope: 'global', operation: 'update', id: todo.id,
          idempotencyKey: crypto.randomUUID(), patch: { status: todo.status === 'done' ? 'open' : 'done' } } });
        await refreshSticky();
      });
      installQuickAdd(document.querySelector('[data-quick-add="global"]'), 'global', null, refreshSticky);
    } catch {}
  };
  await refreshSticky();
  setInterval(refreshSticky, 3000);
  let timer;
  textarea.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const bounds = await api.bounds();
      preferences = await api.request('/v1/notes', { method: 'POST', body: { id: note.id, ...bounds, body: textarea.value } });
    }, 300);
  });
  api.onStickyDockChanged?.((dock) => {
    preferences.dock = dock;
    stickyRoot.dataset.edge = dock.edge || '';
    stickyRoot.dataset.collapsed = String(Boolean(dock.collapsed));
    stickyRoot.style.setProperty('--dock-handle', `${Number(dock.exposedStrip || 12)}px`);
    document.querySelector('#sticky-dock-label').textContent = dock.edge ? `已吸附${dockEdgeLabel(dock.edge)}` : '自由窗口';
  });
}

function stickySection(id, title, body, layout, extraClass = '') {
  const collapsed = layout.collapsedSections.includes(id);
  return `<section class="sticky-section ${extraClass} ${collapsed ? 'collapsed' : ''}" data-section="${id}"><header><h2>${title}</h2><button data-section-toggle="${id}" aria-label="折叠或展开${title}" aria-expanded="${!collapsed}">${icon(collapsed ? 'chevron-up' : 'chevron-down')}</button></header><div class="section-content">${body}</div></section>`;
}

function stickyTodo(todo, scope) {
  const dataAttribute = scope === 'global' ? 'data-global-todo' : 'data-repo-todo';
  return `<div class="sticky-todo-row"><button class="sticky-todo ${escapeHtml(todo.status)}" ${dataAttribute}="${escapeHtml(todo.id)}"><span>${todo.status === 'done' ? icon('check') : icon('circle')}</span><b>${escapeHtml(todo.title)}</b></button><button class="todo-open" data-open-todo="${escapeHtml(todo.id)}" title="在主窗口编辑" aria-label="在主窗口编辑">${icon('edit')}</button></div>`;
}

function installQuickAdd(form, scope, projectId, refresh) {
  if (!form || form.dataset.bound) return;
  form.dataset.bound = 'true';
  form.onsubmit = async (event) => {
    event.preventDefault();
    const input = form.querySelector('input');
    const title = input.value.trim();
    if (!title) return;
    input.disabled = true;
    await api.request('/v1/todos', { method: 'POST', body: { scope, projectId, operation: 'add', idempotencyKey: crypto.randomUUID(), todo: { title } } });
    input.value = '';
    await refresh();
  };
}

function normalizeRatios(value, fallback) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => !Number.isFinite(Number(item)) || Number(item) <= 0)) return [...fallback];
  const total = value.reduce((sum, item) => sum + Number(item), 0);
  return value.map((item) => Number(item) / total);
}

function setSectionGrid(layout) {
  const grid = document.querySelector('#sticky-sections');
  if (!grid) return;
  const rows = [];
  ['agents', 'global', 'repository', 'memo'].forEach((section, index) => {
    rows.push(layout.collapsedSections.includes(section) ? '36px' : `minmax(${section === 'memo' ? 72 : 54}px, ${layout.sectionRatios[index]}fr)`);
    if (index < 3) rows.push('5px');
  });
  grid.style.gridTemplateRows = rows.join(' ');
}

function installSectionResizers(layout, noteId) {
  document.querySelectorAll('[data-resizer]').forEach((resizer) => {
    const adjust = async (delta) => {
      const index = Number(resizer.dataset.resizer);
      const grid = document.querySelector('#sticky-sections');
      const sections = [...grid.querySelectorAll('.sticky-section')];
      const first = sections[index].getBoundingClientRect().height;
      const second = sections[index + 1].getBoundingClientRect().height;
      const total = first + second;
      const nextFirst = Math.max(54, Math.min(total - 54, first + delta));
      const pairRatio = layout.sectionRatios[index] + layout.sectionRatios[index + 1];
      layout.sectionRatios[index] = pairRatio * nextFirst / total;
      layout.sectionRatios[index + 1] = pairRatio - layout.sectionRatios[index];
      layout.collapsedSections = layout.collapsedSections.filter((item) => item !== sections[index].dataset.section && item !== sections[index + 1].dataset.section);
      sections[index].classList.remove('collapsed');
      sections[index + 1].classList.remove('collapsed');
      setSectionGrid(layout);
    };
    resizer.onpointerdown = (event) => {
      event.preventDefault();
      api.stickyPointer?.(true);
      resizer.setPointerCapture(event.pointerId);
      let lastY = event.clientY;
      resizer.onpointermove = (move) => { const delta = move.clientY - lastY; lastY = move.clientY; adjust(delta); };
      resizer.onpointerup = async () => { resizer.onpointermove = null; await persistStickyLayout(noteId, layout); };
    };
    resizer.ondblclick = async () => { layout.sectionRatios = [.30, .17, .23, .30]; setSectionGrid(layout); await persistStickyLayout(noteId, layout); };
    resizer.onkeydown = async (event) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      await adjust(event.key === 'ArrowUp' ? -12 : 12);
      await persistStickyLayout(noteId, layout);
    };
  });
}

async function persistStickyLayout(noteId, layout) {
  await api.request('/v1/notes', { method: 'POST', body: { id: noteId, layout } });
}

function dockEdgeLabel(edge) { return ({ left: '左侧', right: '右侧', top: '顶部', bottom: '底部' })[edge] || ''; }

function contextRow(context) {
  const repo = context.repository;
  return `<div class="row"><div><strong>${escapeHtml(repo.repositoryName || '非 Git 目录')}</strong>
    <div class="meta">${escapeHtml(repo.cwd)} · ${escapeHtml(context.sessionId || context.contextKey)}</div></div>
    <div class="row-actions"><span class="badge">${escapeHtml(syncLabel(repo))}</span>${repo.isGitRepository ? `<button class="secondary" data-switch-workspace="${escapeHtml(repo.repoRoot)}">切换</button>` : ''}<button class="context-remove" data-remove-context="${escapeHtml(context.contextKey)}" title="移除此会话卡片" aria-label="移除此会话卡片">×</button></div></div>`;
}

function contextCard(context) {
  const repo = context.repository;
  const remove = context.status === 'stale'
    ? `<button type="button" class="context-delete" data-remove-context="${escapeHtml(context.contextKey)}" title="删除此已失效会话">删除</button>`
    : '';
  return `<article class="context-card ${escapeHtml(context.status)}"><div class="context-title"><strong>${escapeHtml(repo.repositoryName || '非 Git 目录')}</strong><span class="context-status">${escapeHtml(statusLabel(context.status))}${remove}</span></div>
    <div>${escapeHtml(repo.branch || repo.syncReason)}</div>
    <small title="${escapeHtml(repo.cwd)}">${escapeHtml(repo.cwd)}</small>
    <small>${escapeHtml(syncLabel(repo))} · ${escapeHtml((context.sessionId || context.contextKey).slice(0, 14))}</small></article>`;
}

function statusLabel(status) {
  return ({ active: '活跃', idle: '空闲', stale: '已失联', interrupted: '已中断', ended: '已结束' })[status] || status;
}

function syncLabel(repository) {
  const labels = {
    ready: `GitHub · ${repository.githubRepository}`,
    'not-git': '仅路径，不同步 GitHub',
    'github-disabled': 'GitHub 同步已关闭',
    'github-not-configured': 'GitHub 未配置',
    'github-not-authenticated': 'GitHub 未登录',
    'github-account-mismatch': `GitHub 账户不匹配（需要 ${repository.expectedGithubAccount}）`
  };
  return labels[repository.syncReason] || repository.syncReason;
}

function showError(error) { document.querySelector('#error').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
function clearError() { document.querySelector('#error').textContent = ''; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
