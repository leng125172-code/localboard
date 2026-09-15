import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StateDatabase } from './state-db.mjs';
import { globalTodoFilePath, runtimeDirectory, todoFilePath } from './paths.mjs';
import { TodoStore } from './todo-store.mjs';
import { createTodo, updateTodo } from './model.mjs';
import { GitHubService } from '../github/service.mjs';
import { inspectRepositoryContext } from './repository-context.mjs';
import { inspectGitStatus, readGitDiff, repairTodoIgnore, todoTrackingStatus } from './git-status.mjs';

export async function startBroker() {
  const runtime = runtimeDirectory();
  await mkdir(runtime, { recursive: true });
  const ownership = await acquireOwnership(runtime);
  if (!ownership) return { owner: false };

  const token = randomBytes(32).toString('base64url');
  const state = new StateDatabase(join(runtime, 'state.sqlite3'));
  const github = new GitHubService(state);
  const streamClients = new Set();
  let writeQueue = Promise.resolve();
  const serialize = (work) => {
    const result = writeQueue.then(work, work);
    writeQueue = result.catch(() => {});
    return result;
  };

  const server = http.createServer(async (request, response) => {
    setSecurityHeaders(response);
    if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: 'Unauthorized' });
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        return send(response, 200, { ok: true, pid: process.pid, version: 2, startedAt: endpoint?.startedAt ?? null });
      }
      if (request.method === 'GET' && url.pathname === '/v1/stream') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        });
        response.write('event: ready\ndata: {}\n\n');
        streamClients.add(response);
        request.on('close', () => streamClients.delete(response));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        const integrations = await readJsonFile(join(runtime, 'integration-status.json'));
        return send(response, 200, {
          broker: { ok: true, pid: process.pid, version: 2, startedAt: endpoint?.startedAt ?? null },
          agents: state.agentStatus(),
          projects: state.listProjects(),
          integrations
        });
      }
      if (request.method === 'GET' && url.pathname === '/v1/projects') {
        return send(response, 200, { projects: state.listProjects() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/projects/register') {
        const body = await readJson(request);
        const context = body.register === false
          ? await inspectProject(state, required(body.cwd, 'cwd'), { refresh: body.refresh === true })
          : await inspectAndRegister(state, required(body.cwd, 'cwd'), { refresh: body.refresh === true });
        if (body.register !== false) broadcast(streamClients, 'projects', context);
        return send(response, 200, context);
      }
      if (url.pathname.startsWith('/v1/projects/')) {
        const projectId = decodeURIComponent(url.pathname.slice('/v1/projects/'.length));
        if (request.method === 'PATCH') {
          const value = state.updateProjectPreferences(projectId, await readJson(request));
          broadcast(streamClients, 'projects', value);
          return send(response, 200, value);
        }
        if (request.method === 'DELETE') {
          const value = state.deleteProject(projectId);
          broadcast(streamClients, 'projects', value);
          return send(response, 200, value);
        }
      }
      if (request.method === 'GET' && url.pathname === '/v1/todos') {
        const target = todoTarget(state, {
          scope: url.searchParams.get('scope'), projectId: url.searchParams.get('projectId'), repo: url.searchParams.get('repo')
        });
        return send(response, 200, { ...(await new TodoStore(target.path).read()), scope: target.scope, projectId: target.projectId });
      }
      if (request.method === 'POST' && url.pathname === '/v1/todos') {
        const body = await readJson(request);
        const result = await serialize(() => mutateTodo(state, body));
        broadcast(streamClients, 'todos', { scope: body.scope, projectId: body.projectId });
        return send(response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/v1/events') {
        const body = await readJson(request);
        const key = body.eventKey || eventKey(body.payload ?? body);
        const value = state.recordAgentEvent(body.payload ?? body, key);
        broadcast(streamClients, 'agents', body.payload ?? body);
        return send(response, 200, value);
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        return send(response, 200, { events: state.listAgentEvents(url.searchParams.get('limit') ?? 100) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/contexts') {
        return send(response, 200, { contexts: state.listAgentContexts({
          includeEnded: url.searchParams.get('includeEnded') !== 'false',
          maxAgeHours: url.searchParams.get('maxAgeHours') ?? 24,
          staleAfterMinutes: url.searchParams.get('staleAfterMinutes') ?? 30
        }) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/contexts') {
        const body = await readJson(request);
        const value = await serialize(async () => {
          const saved = state.upsertAgentContext(body);
          state.upsertProject(body.repository);
          return saved;
        });
        broadcast(streamClients, 'agents', value);
        return send(response, 200, value);
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/v1/contexts/')) {
        return send(response, 200, await serialize(async () => state.deleteAgentContext(decodeURIComponent(url.pathname.slice(13)))));
      }
      if (request.method === 'GET' && url.pathname === '/v1/notes') {
        return send(response, 200, { notes: state.listNotes() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/notes') {
        const body = await readJson(request);
        const value = await serialize(async () => state.saveNote({ ...body, id: 'codex-activity' }));
        broadcast(streamClients, 'notes', value);
        return send(response, 200, value);
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/v1/notes/')) {
        return send(response, 200, await serialize(async () => state.deleteNote(decodeURIComponent(url.pathname.slice(10)))));
      }
      if (request.method === 'GET' && url.pathname === '/v1/outbox') {
        return send(response, 200, { items: state.listOutbox(url.searchParams.get('status')) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/git/status') {
        const project = requiredProject(state, url.searchParams.get('projectId'));
        if (!project.isGitRepository) throw new Error('Git status is only available for Git projects');
        return send(response, 200, {
          ...(await inspectGitStatus(project.repoRoot)),
          todoTracking: await todoTrackingStatus(project.repoRoot)
        });
      }
      if (request.method === 'GET' && url.pathname === '/v1/git/diff') {
        const project = requiredProject(state, url.searchParams.get('projectId'));
        if (!project.isGitRepository) throw new Error('Git diff is only available for Git projects');
        return send(response, 200, await readGitDiff(project.repoRoot, required(url.searchParams.get('path'), 'path'), {
          staged: url.searchParams.get('staged') === 'true'
        }));
      }
      if (request.method === 'POST' && url.pathname === '/v1/git/repair-todo-ignore') {
        const body = await readJson(request);
        const project = requiredProject(state, body.projectId);
        if (!project.isGitRepository) throw new Error('Ignore repair is only available for Git projects');
        return send(response, 200, await serialize(() => repairTodoIgnore(project.repoRoot)));
      }
      if (request.method === 'POST' && url.pathname === '/v1/github') {
        const body = await readJson(request);
        const localRepoRoot = required(body.localRepoRoot, 'localRepoRoot');
        const repositoryOverride = body.owner && body.repo ? `${body.owner}/${body.repo}` : undefined;
        let context = await inspectRepositoryContext(localRepoRoot, { repositoryOverride });
        const registered = state.getProject(context.projectId);
        if (registered?.githubAccount) {
          context = await inspectRepositoryContext(localRepoRoot, {
            repositoryOverride, expectedGithubAccount: registered.githubAccount
          });
        }
        if (!context.syncGitHub) throw new Error(`GitHub sync skipped: ${context.syncReason}`);
        return send(response, 200, await serialize(() => github.execute(body)));
      }
      return send(response, 404, { error: 'Not found' });
    } catch (error) {
      return send(response, error.statusCode ?? 400, { error: error.message });
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const endpoint = { port: address.port, token, pid: process.pid, startedAt: new Date().toISOString() };
  await atomicJson(join(runtime, 'broker.json'), endpoint);

  const close = async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    state.close();
    await rm(join(runtime, 'broker.json'), { force: true });
    await rm(join(runtime, 'broker.lock'), { recursive: true, force: true });
  };
  return { owner: true, endpoint, server, close };
}

async function mutateTodo(state, body) {
  const idempotent = state.getIdempotent(body.idempotencyKey);
  if (idempotent) return { ...idempotent, replayed: true };
  const target = todoTarget(state, body);
  if (target.scope === 'repository' && target.repoRoot) {
    const tracking = await todoTrackingStatus(target.repoRoot);
    if (tracking.ignored) await repairTodoIgnore(target.repoRoot);
  }
  const store = new TodoStore(target.path);
  const result = await store.mutate((file) => {
    const todos = [...file.todos];
    let value;
    switch (body.operation) {
      case 'add':
        value = createTodo(body.todo ?? body.patch ?? {});
        todos.push(value);
        break;
      case 'update': {
        const index = todos.findIndex((todo) => todo.id === body.id);
        if (index < 0) throw new Error(`Todo not found: ${body.id}`);
        value = updateTodo(todos[index], body.patch ?? {});
        todos[index] = value;
        break;
      }
      case 'remove': {
        const index = todos.findIndex((todo) => todo.id === body.id);
        if (index < 0) throw new Error(`Todo not found: ${body.id}`);
        [value] = todos.splice(index, 1);
        break;
      }
      default:
        throw new Error(`Unknown todo operation: ${body.operation}`);
    }
    return { file: { schemaVersion: 1, todos }, value };
  });
  const response = { todo: result.value, todos: result.file.todos, scope: target.scope, projectId: target.projectId };
  state.putIdempotent(body.idempotencyKey, response);
  return response;
}

async function inspectAndRegister(state, cwd, options = {}) {
  return state.upsertProject(await inspectProject(state, cwd, options));
}

async function inspectProject(state, cwd, options = {}) {
  const repositoryOptions = options.refresh ? { authCache: false } : {};
  let context = await inspectRepositoryContext(cwd, repositoryOptions);
  const existing = state.getProject(context.projectId);
  if (existing?.githubAccount && existing.githubAccount !== context.expectedGithubAccount) {
    context = await inspectRepositoryContext(cwd, { ...repositoryOptions, expectedGithubAccount: existing.githubAccount });
  }
  return existing ? {
    ...context,
    pinned: existing.pinned,
    githubAccount: existing.githubAccount,
    favoriteProjects: existing.favoriteProjects,
    createdAt: existing.createdAt,
    lastSeenAt: existing.lastSeenAt
  } : context;
}

function requiredProject(state, projectId) {
  return state.getProject(required(projectId, 'projectId')) || (() => { throw new Error(`Project not found: ${projectId}`); })();
}

function todoTarget(state, input = {}) {
  const scope = input.scope || (input.repo || input.projectId ? 'repository' : 'global');
  if (scope === 'global') return { scope, projectId: null, path: globalTodoFilePath() };
  if (scope !== 'repository') throw new Error(`Unknown todo scope: ${scope}`);
  if (input.repo) {
    const repoRoot = resolve(input.repo);
    return { scope, projectId: input.projectId ?? null, repoRoot, path: todoFilePath(repoRoot) };
  }
  const project = requiredProject(state, input.projectId);
  if (!project.isGitRepository) throw new Error('Repository todos require a Git project');
  return { scope, projectId: project.projectId, repoRoot: project.repoRoot, path: todoFilePath(project.repoRoot) };
}

function broadcast(clients, event, value) {
  const message = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const response of clients) {
    try { response.write(message); } catch { clients.delete(response); }
  }
}

async function acquireOwnership(runtime) {
  const lock = join(runtime, 'broker.lock');
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
        process.kill(info.pid, 0);
        return false;
      } catch {
        try {
          const age = Date.now() - (await stat(lock)).mtimeMs;
          if (age < 5000) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 40));
            continue;
          }
        } catch {}
        await rm(lock, { recursive: true, force: true });
      }
    }
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function setSecurityHeaders(response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
}

function required(value, name) {
  if (value === null || value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

function eventKey(payload) {
  return createHash('sha256').update(JSON.stringify([
    payload.session_id,
    payload.turn_id,
    payload.agent_id,
    payload.hook_event_name,
    payload.reason
  ])).digest('hex');
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

async function readJsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
