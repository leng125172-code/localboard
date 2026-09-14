const api = window.localboard;
const app = document.querySelector('#app');
const query = new URLSearchParams(location.search);

if (query.get('sticky') === '1') renderSticky(query.get('id'));
else renderApplication();

async function renderApplication() {
  const context = await api.context();
  let active = 'todos';
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
        <header class="topbar"><div><div class="eyebrow">Focus workspace</div><h1 id="page-title">个人待办</h1></div><div class="repo-pill" title="${escapeHtml(context.cwd)}">${escapeHtml(context.cwd)}</div></header>
        <div id="error"></div><section id="view"></section>
      </main>
    </div>`;
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', async () => {
    active = button.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
    await load(active, context);
  }));
  await load(active, context);
}

async function load(tab, context) {
  const titles = { todos: '个人待办', project: 'GitHub Project', issues: 'Issues', prs: 'Pull Requests', actions: 'Actions', agents: 'Codex / Agents', notes: '屏幕便签' };
  document.querySelector('#page-title').textContent = titles[tab];
  clearError();
  try {
    if (tab === 'todos') return loadTodos(context);
    if (tab === 'agents') return loadAgents();
    if (tab === 'notes') return loadNotes();
    if (tab === 'project') return loadProject(context);
    if (tab === 'issues') return loadIssues(context);
    if (tab === 'prs') return loadPullRequests(context);
    if (tab === 'actions') return loadActions(context);
  } catch (error) { showError(error); }
}

async function loadTodos(context) {
  const data = await api.request(`/v1/todos?repo=${encodeURIComponent(context.cwd)}`);
  const view = document.querySelector('#view');
  view.innerHTML = `<div class="toolbar"><button class="primary" id="add-todo">新建待办</button><button class="secondary" id="refresh">刷新</button></div>
    <div class="grid">${data.todos.length ? data.todos.map(todoCard).join('') : '<div class="empty">还没有个人待办。这里的数据只进入当前 Git 仓库，不会写入 GitHub Project。</div>'}</div>`;
  document.querySelector('#add-todo').onclick = () => todoDialog(context);
  document.querySelector('#refresh').onclick = () => loadTodos(context);
  document.querySelectorAll('[data-done]').forEach((button) => button.onclick = async () => {
    await api.request('/v1/todos', { method: 'POST', body: { repo: context.cwd, operation: 'update', id: button.dataset.done,
      idempotencyKey: crypto.randomUUID(), patch: { status: 'done' } } });
    await loadTodos(context);
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
    await loadTodos(context);
  };
}

async function loadAgents() {
  const data = await api.request('/v1/events?limit=100');
  document.querySelector('#view').innerHTML = `<div class="panel">${data.events.length ? data.events.map((event) => `
    <div class="row"><div><strong>${escapeHtml(event.eventName)}</strong><div class="meta">${escapeHtml(event.sessionId || 'unknown session')} · ${escapeHtml(event.cwd || '')}</div></div><time class="meta">${escapeHtml(event.createdAt)}</time></div>`).join('') : '<div class="empty">尚未收到 Codex 生命周期事件</div>'}</div>`;
}

async function loadNotes() {
  const data = await api.request('/v1/notes');
  document.querySelector('#view').innerHTML = `<div class="toolbar"><button class="primary" id="new-note">新建置顶便签</button></div>
    <div class="grid">${data.notes.length ? data.notes.map((note) => `<article class="card"><h3>${escapeHtml(note.title)}</h3><p>${escapeHtml(note.body.slice(0, 140))}</p><button class="secondary" data-note="${note.id}">打开</button></article>`).join('') : '<div class="empty">还没有屏幕便签</div>'}</div>`;
  document.querySelector('#new-note').onclick = () => api.openSticky({ title: '新便签', body: '', color: '#fff3a6', alwaysOnTop: true });
  document.querySelectorAll('[data-note]').forEach((button) => button.onclick = () => api.openSticky(data.notes.find((note) => note.id === button.dataset.note)));
}

async function loadProject(context) {
  const github = requireGitHub(context, true);
  const project = await githubRequest({ action: 'project.get', ownerType: github.ownerType,
    owner: github.projectOwner, projectNumber: github.projectNumber });
  const items = await githubRequest({ action: 'project.items', projectId: project.id });
  const statusField = project.fields.nodes.find((field) => field.name.toLowerCase() === 'status' && field.options);
  document.querySelector('#view').innerHTML = `<div class="toolbar"><span class="badge">${escapeHtml(project.title)}</span><button class="secondary" id="refresh-project">刷新</button></div>
    <div class="panel">${items.length ? items.map((item) => projectRow(item, statusField)).join('') : '<div class="empty">Project 中没有项目</div>'}</div>`;
  document.querySelector('#refresh-project').onclick = () => loadProject(context);
  document.querySelectorAll('[data-project-status]').forEach((select) => select.onchange = async () => {
    select.disabled = true;
    try {
      await githubRequest({ action: 'project.setField', projectId: project.id, itemId: select.dataset.projectStatus,
        fieldId: statusField.id, valueType: 'single-select', value: select.value, idempotencyKey: crypto.randomUUID() });
    } finally { select.disabled = false; }
  });
  document.querySelectorAll('[data-edit-project]').forEach((button) => button.onclick = async () => {
    const item = items.find((candidate) => candidate.id === button.dataset.editProject);
    const title = window.prompt('修改标题', item.content.title);
    if (!title || title === item.content.title) return;
    if (item.content.number && item.content.repository) {
      const [owner, repo] = item.content.repository.nameWithOwner.split('/');
      await githubRequest({ action: 'issue.update', owner, repo, number: item.content.number, title,
        idempotencyKey: crypto.randomUUID() });
    } else {
      await githubRequest({ action: 'project.updateDraft', draftIssueId: item.content.id, title,
        idempotencyKey: crypto.randomUUID() });
    }
    await loadProject(context);
  });
}

function projectRow(item, statusField) {
  const content = item.content ?? { title: '(无权访问的项目)' };
  const current = statusField && item.fieldValues.nodes.find((value) => value.field?.id === statusField.id)?.optionId;
  const editable = content.id && (!content.repository || content.__typename !== 'PullRequest');
  return `<div class="row"><div><strong>${escapeHtml(content.title)}</strong><div class="meta">${escapeHtml(content.repository?.nameWithOwner || 'Project draft')} ${content.number ? `#${content.number}` : ''}</div></div>
    <div class="toolbar">${statusField ? `<select data-project-status="${item.id}">${statusField.options.map((option) => `<option value="${option.id}" ${option.id === current ? 'selected' : ''}>${escapeHtml(option.name)}</option>`).join('')}</select>` : ''}
    ${editable ? `<button class="secondary" data-edit-project="${item.id}">编辑标题</button>` : ''}</div></div>`;
}

async function loadIssues(context) {
  const github = requireGitHub(context);
  const items = await githubRequest({ action: 'issue.list', owner: github.owner, repo: github.repo, state: 'open' });
  document.querySelector('#view').innerHTML = `<div class="toolbar"><button class="primary" id="new-issue">新建 Issue</button><button class="secondary" id="refresh-issues">刷新</button></div>
    <div class="panel">${items.length ? items.map((issue) => `<div class="row"><div><strong>#${issue.number} ${escapeHtml(issue.title)}</strong><div class="meta">${issue.labels.map((label) => escapeHtml(label.name)).join(' · ')}</div></div><button class="secondary" data-close-issue="${issue.number}">关闭</button></div>`).join('') : '<div class="empty">没有打开的 Issue</div>'}</div>`;
  document.querySelector('#refresh-issues').onclick = () => loadIssues(context);
  document.querySelector('#new-issue').onclick = () => issueDialog(context);
  document.querySelectorAll('[data-close-issue]').forEach((button) => button.onclick = async () => {
    await githubRequest({ action: 'issue.close', owner: github.owner, repo: github.repo, number: Number(button.dataset.closeIssue),
      reason: 'completed', idempotencyKey: crypto.randomUUID() });
    await loadIssues(context);
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
    await loadIssues(context);
  };
}

async function loadPullRequests(context) {
  const github = requireGitHub(context);
  const items = await githubRequest({ action: 'pr.list', owner: github.owner, repo: github.repo, state: 'open' });
  document.querySelector('#view').innerHTML = `<div class="toolbar"><button class="secondary" id="refresh-prs">刷新</button></div><div class="panel">
    ${items.length ? items.map((pr) => `<div class="row"><div><strong>#${pr.number} ${escapeHtml(pr.title)}</strong><div class="meta">${escapeHtml(pr.user?.login)} · ${pr.draft ? 'Draft' : 'Ready for review'}</div></div><span class="badge">${escapeHtml(pr.mergeable_state || pr.state)}</span></div>`).join('') : '<div class="empty">没有打开的 Pull Request</div>'}</div>`;
  document.querySelector('#refresh-prs').onclick = () => loadPullRequests(context);
}

async function loadActions(context) {
  const github = requireGitHub(context);
  const data = await githubRequest({ action: 'actions.runs', owner: github.owner, repo: github.repo, perPage: 50 });
  document.querySelector('#view').innerHTML = `<div class="toolbar"><button class="secondary" id="refresh-actions">刷新</button></div><div class="panel">
    ${data.workflow_runs?.length ? data.workflow_runs.map((run) => `<div class="row"><div><strong>${escapeHtml(run.name)}</strong><div class="meta">${escapeHtml(run.head_branch)} · ${escapeHtml(run.event)} · ${escapeHtml(run.head_sha.slice(0, 7))}</div></div><span class="badge">${escapeHtml(run.conclusion || run.status)}</span></div>`).join('') : '<div class="empty">没有 Actions 运行记录</div>'}</div>`;
  document.querySelector('#refresh-actions').onclick = () => loadActions(context);
}

function requireGitHub(context, requireProject = false) {
  if (!context.github) throw new Error(context.githubError || '请先配置 GitHub 仓库');
  if (requireProject && !context.github.projectNumber) throw new Error('请在 .localboard/config.json 配置 projectNumber');
  return context.github;
}

function githubRequest(body) {
  return api.request('/v1/github', { method: 'POST', body, timeoutMs: 60000 });
}

async function renderSticky(id) {
  const data = await api.request('/v1/notes');
  const note = data.notes.find((item) => item.id === id);
  if (!note) return app.textContent = '便签不存在';
  document.body.style.background = note.color;
  app.innerHTML = `<div class="sticky" style="background:${escapeHtml(note.color)}"><div class="sticky-head">${escapeHtml(note.title)}</div><textarea aria-label="便签内容">${escapeHtml(note.body)}</textarea><div class="sticky-foot">自动保存 · Local only</div></div>`;
  const textarea = document.querySelector('textarea');
  let timer;
  textarea.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const bounds = await api.bounds();
      await api.request('/v1/notes', { method: 'POST', body: { ...note, ...bounds, body: textarea.value } });
    }, 300);
  });
}

function showError(error) { document.querySelector('#error').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
function clearError() { document.querySelector('#error').textContent = ''; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
