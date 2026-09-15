const api = window.localboard;
const app = document.querySelector('#app');
const query = new URLSearchParams(location.search);
let applicationState;

if (query.get('sticky') === 'activity') renderActivitySticky(query.get('id'));
else renderApplication();

async function renderApplication() {
  const startupWorkspace = query.get('cwd');
  const savedWorkspace = startupWorkspace || localStorage.getItem('localboard.workspace');
  let context = await api.context(savedWorkspace || undefined);
  if (!startupWorkspace && savedWorkspace && !context.repository.isGitRepository) {
    localStorage.removeItem('localboard.workspace');
    context = await api.context();
  }
  applicationState = { context, active: 'todos', loadId: 0 };
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">LB</div><div><strong>LocalBoard</strong><small>local-first workspace</small></div></div>
        <nav class="nav">
          <button data-tab="todos" class="active">个人待办</button>
          <button data-tab="project">GitHub Project</button>
          <button data-tab="issues">Issues</button>
          <button data-tab="prs">Pull Requests</button>
          <button data-tab="actions">Actions</button>
          <button data-tab="agents">Codex / Agents</button>
          <button data-tab="notes">屏幕便签</button>
        </nav>
        <div class="connection"><span class="dot"></span>本地 broker 已连接</div>
      </aside>
      <main class="content">
        <header class="topbar"><div><div class="eyebrow">Focus workspace</div><h1 id="page-title">个人待办</h1></div><button class="repo-pill" id="workspace-switcher" type="button" title="查看并切换 Codex 仓库"></button></header>
        <div id="error"></div><section id="view"></section>
      </main>
    </div>`;
  updateWorkspacePill();
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.tab)));
  document.querySelector('#workspace-switcher').addEventListener('click', () => navigate('notes'));
  api.onSecondInstance(({ cwd }) => switchWorkspace(cwd));
  const pendingStartup = await api.ready();
  if (pendingStartup?.cwd) return switchWorkspace(pendingStartup.cwd);
  await navigate('todos');
}

async function navigate(tab, options = {}) {
  const state = applicationState;
  state.active = tab;
  const loadId = ++state.loadId;
  const titles = { todos: '个人待办', project: 'GitHub Project', issues: 'Issues', prs: 'Pull Requests', actions: 'Actions', agents: 'Codex / Agents', notes: '屏幕便签' };
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
  if (tab === 'todos') return await loadTodos(context, loadId);
  if (tab === 'agents') return await loadAgents(loadId);
  if (tab === 'notes') return await loadNotes(loadId);
  if (tab === 'project') return await loadProject(context, loadId, options);
  if (tab === 'issues') return await loadIssues(context, loadId, options);
  if (tab === 'prs') return await loadPullRequests(context, loadId, options);
  if (tab === 'actions') return await loadActions(context, loadId, options);
}

async function loadTodos(context, loadId) {
  if (!context.repository.isGitRepository) {
    const view = currentView(loadId);
    if (view) view.innerHTML = '<div class="empty">当前路径还不是 Git 仓库。LocalBoard 不会自动初始化仓库，也不会在这里创建个人待办。</div>';
    return;
  }
  const data = await api.request(`/v1/todos?repo=${encodeURIComponent(context.cwd)}`);
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="toolbar"><button class="primary" id="add-todo">新建待办</button><button class="secondary" id="refresh">刷新</button></div>
    <div class="grid">${data.todos.length ? data.todos.map(todoCard).join('') : '<div class="empty">还没有个人待办。这里的数据只进入当前 Git 仓库，不会写入 GitHub Project。</div>'}</div>`;
  document.querySelector('#add-todo').onclick = () => todoDialog(context);
  document.querySelector('#refresh').onclick = () => navigate('todos');
  document.querySelectorAll('[data-done]').forEach((button) => button.onclick = async () => {
    await api.request('/v1/todos', { method: 'POST', body: { repo: context.cwd, operation: 'update', id: button.dataset.done,
      idempotencyKey: crypto.randomUUID(), patch: { status: 'done' } } });
    await navigate('todos');
  });
}

function todoCard(todo) {
  return `<article class="card todo-card ${todo.status}"><div class="meta">${escapeHtml(todo.status)} · P${todo.priority}</div>
    <h3>${escapeHtml(todo.title)}</h3><p>${escapeHtml(todo.description || ' ')}</p>
    <div class="meta">${todo.tags.map((tag) => `#${escapeHtml(tag)}`).join(' ')}</div>
    <div class="todo-actions">${todo.status !== 'done' ? `<button data-done="${todo.id}">完成</button>` : ''}</div></article>`;
}

function todoDialog(context) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form class="dialog form"><h2>新建个人待办</h2><input name="title" placeholder="要完成什么？" required autofocus />
    <textarea name="description" placeholder="补充说明"></textarea><input name="tags" placeholder="标签，以逗号分隔" />
    <select name="priority"><option value="0">普通</option><option value="1">P1</option><option value="2">P2</option><option value="3">P3 紧急</option></select>
    <div class="toolbar"><button class="primary">保存</button><button type="button" class="secondary" id="cancel">取消</button></div></form>`;
  document.body.append(overlay);
  overlay.querySelector('#cancel').onclick = () => overlay.remove();
  overlay.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api.request('/v1/todos', { method: 'POST', body: { repo: context.cwd, operation: 'add', idempotencyKey: crypto.randomUUID(), todo: {
      title: form.get('title'), description: form.get('description'), tags: String(form.get('tags')).split(',').filter(Boolean), priority: Number(form.get('priority'))
    } } });
    overlay.remove();
    await navigate('todos');
  };
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

async function loadProject(context, loadId, options) {
  const github = requireGitHub(context, true);
  const project = await githubRequest({ action: 'project.get', ownerType: github.ownerType,
    owner: github.projectOwner, projectNumber: github.projectNumber, refresh: options.refresh === true });
  const items = await githubRequest({ action: 'project.items', projectId: project.id, refresh: options.refresh === true });
  const statusField = project.fields.nodes.find((field) => field.name.toLowerCase() === 'status' && field.options);
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="toolbar"><span class="badge">${escapeHtml(project.title)}</span><button class="secondary" id="refresh-project">刷新</button></div>
    <div class="panel">${items.length ? items.map((item) => projectRow(item, statusField)).join('') : '<div class="empty">Project 中没有项目</div>'}</div>`;
  document.querySelector('#refresh-project').onclick = () => navigate('project', { refresh: true });
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
    <div class="panel">${items.length ? items.map((issue) => `<div class="row"><div><strong>#${issue.number} ${escapeHtml(issue.title)}</strong><div class="meta">${issue.labels.map((label) => escapeHtml(label.name)).join(' · ')}</div></div><button class="secondary" data-close-issue="${issue.number}">关闭</button></div>`).join('') : '<div class="empty">没有打开的 Issue</div>'}</div>`;
  document.querySelector('#refresh-issues').onclick = () => navigate('issues', { refresh: true });
  document.querySelector('#new-issue').onclick = () => issueDialog(context);
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
  const items = await githubRequest({ action: 'pr.list', owner: github.owner, repo: github.repo, state: 'open', refresh: options.refresh === true });
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="toolbar"><button class="secondary" id="refresh-prs">刷新</button></div><div class="panel">
    ${items.length ? items.map((pr) => `<div class="row"><div><strong>#${pr.number} ${escapeHtml(pr.title)}</strong><div class="meta">${escapeHtml(pr.user?.login)} · ${pr.draft ? 'Draft' : 'Ready for review'}</div></div><span class="badge">${escapeHtml(pr.mergeable_state || pr.state)}</span></div>`).join('') : '<div class="empty">没有打开的 Pull Request</div>'}</div>`;
  document.querySelector('#refresh-prs').onclick = () => navigate('prs', { refresh: true });
}

async function loadActions(context, loadId, options) {
  const github = requireGitHub(context);
  const data = await githubRequest({ action: 'actions.runs', owner: github.owner, repo: github.repo, perPage: 50, refresh: options.refresh === true });
  const view = currentView(loadId);
  if (!view) return;
  view.innerHTML = `<div class="toolbar"><button class="secondary" id="refresh-actions">刷新</button></div><div class="panel">
    ${data.workflow_runs?.length ? data.workflow_runs.map((run) => `<div class="row"><div><strong>${escapeHtml(run.name)}</strong><div class="meta">${escapeHtml(run.head_branch)} · ${escapeHtml(run.event)} · ${escapeHtml(run.head_sha.slice(0, 7))}</div></div><span class="badge">${escapeHtml(run.conclusion || run.status)}</span></div>`).join('') : '<div class="empty">没有 Actions 运行记录</div>'}</div>`;
  document.querySelector('#refresh-actions').onclick = () => navigate('actions', { refresh: true });
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
    if (context.repository.isGitRepository) localStorage.setItem('localboard.workspace', context.cwd);
    updateWorkspacePill();
    await navigate('todos');
  } catch (error) {
    if (switchId !== applicationState.loadId) return;
    showError(error);
    document.querySelector('#view').innerHTML = `<div class="empty">无法切换到该仓库：${escapeHtml(error.message)}</div>`;
  }
}

function updateWorkspacePill() {
  const context = applicationState.context;
  const repository = context.repository;
  const name = repository.repositoryName || '非 Git 路径';
  const detail = `${repository.branch || repository.syncReason}${repository.isLinkedWorktree ? ' · worktree' : ''}`;
  const button = document.querySelector('#workspace-switcher');
  button.title = `${context.cwd}\n点击查看并切换 Codex 仓库`;
  button.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(detail)} · ${escapeHtml(syncLabel(repository))}</span>`;
}

async function renderActivitySticky(id) {
  const data = await api.request('/v1/notes');
  const note = data.notes.find((item) => item.id === id);
  if (!note) return app.textContent = '便签不存在';
  document.body.style.background = note.color;
  app.innerHTML = `<div class="sticky" style="background:${escapeHtml(note.color)}"><div class="sticky-head"><span>${escapeHtml(note.title)}</span><div class="sticky-window-actions"><button type="button" data-window-action="minimize" title="最小化" aria-label="最小化">−</button><button type="button" data-window-action="hide" title="隐藏；可从主窗口再次打开" aria-label="隐藏">×</button></div></div>
    <div class="sticky-contexts" id="sticky-contexts"></div>
    <textarea aria-label="共享便签内容" placeholder="手写备注；Codex 不会覆盖这里">${escapeHtml(note.body)}</textarea>
    <div class="sticky-foot">一个窗口 · 多会话隔离 · 自动保存</div></div>`;
  const textarea = document.querySelector('textarea');
  document.querySelectorAll('[data-window-action]').forEach((button) => {
    button.addEventListener('click', () => api.windowAction(button.dataset.windowAction));
  });
  const refreshContexts = async () => {
    try {
      const contexts = await api.request('/v1/contexts?includeEnded=false');
      document.querySelector('#sticky-contexts').innerHTML = contexts.contexts.length
        ? contexts.contexts.map(contextCard).join('')
        : '<div class="sticky-empty">等待 Codex 上报执行路径…</div>';
    } catch {}
  };
  await refreshContexts();
  setInterval(refreshContexts, 2000);
  let timer;
  textarea.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const bounds = await api.bounds();
      await api.request('/v1/notes', { method: 'POST', body: { ...note, ...bounds, body: textarea.value } });
    }, 300);
  });
}

function contextRow(context) {
  const repo = context.repository;
  return `<div class="row"><div><strong>${escapeHtml(repo.repositoryName || '非 Git 目录')}</strong>
    <div class="meta">${escapeHtml(repo.cwd)} · ${escapeHtml(context.sessionId || context.contextKey)}</div></div>
    <div class="row-actions"><span class="badge">${escapeHtml(syncLabel(repo))}</span>${repo.isGitRepository ? `<button class="secondary" data-switch-workspace="${escapeHtml(repo.repoRoot)}">切换</button>` : ''}<button class="context-remove" data-remove-context="${escapeHtml(context.contextKey)}" title="移除此会话卡片" aria-label="移除此会话卡片">×</button></div></div>`;
}

function contextCard(context) {
  const repo = context.repository;
  return `<article class="context-card ${escapeHtml(context.status)}"><div class="context-title"><strong>${escapeHtml(repo.repositoryName || '非 Git 目录')}</strong><span>${escapeHtml(statusLabel(context.status))}</span></div>
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
    'github-not-authenticated': 'GitHub 未登录'
  };
  return labels[repository.syncReason] || repository.syncReason;
}

function showError(error) { document.querySelector('#error').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
function clearError() { document.querySelector('#error').textContent = ''; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
