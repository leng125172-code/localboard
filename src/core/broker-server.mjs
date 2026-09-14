import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StateDatabase } from './state-db.mjs';
import { runtimeDirectory, todoFilePath } from './paths.mjs';
import { TodoStore } from './todo-store.mjs';
import { createTodo, updateTodo } from './model.mjs';
import { GitHubService } from '../github/service.mjs';

export async function startBroker() {
  const runtime = runtimeDirectory();
  await mkdir(runtime, { recursive: true });
  const ownership = await acquireOwnership(runtime);
  if (!ownership) return { owner: false };

  const token = randomBytes(32).toString('base64url');
  const state = new StateDatabase(join(runtime, 'state.sqlite3'));
  const github = new GitHubService(state);
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
        return send(response, 200, { ok: true, pid: process.pid, version: 1 });
      }
      if (request.method === 'GET' && url.pathname === '/v1/todos') {
        const repo = required(url.searchParams.get('repo'), 'repo');
        return send(response, 200, await new TodoStore(todoFilePath(resolve(repo))).read());
      }
      if (request.method === 'POST' && url.pathname === '/v1/todos') {
        const body = await readJson(request);
        const result = await serialize(() => mutateTodo(state, body));
        return send(response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/v1/events') {
        const body = await readJson(request);
        const key = body.eventKey || eventKey(body.payload ?? body);
        return send(response, 200, state.recordAgentEvent(body.payload ?? body, key));
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        return send(response, 200, { events: state.listAgentEvents(url.searchParams.get('limit') ?? 100) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/notes') {
        return send(response, 200, { notes: state.listNotes() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/notes') {
        return send(response, 200, await serialize(async () => state.saveNote(await readJson(request))));
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/v1/notes/')) {
        return send(response, 200, await serialize(async () => state.deleteNote(decodeURIComponent(url.pathname.slice(10)))));
      }
      if (request.method === 'GET' && url.pathname === '/v1/outbox') {
        return send(response, 200, { items: state.listOutbox(url.searchParams.get('status')) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/github') {
        const body = await readJson(request);
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
  const repo = resolve(required(body.repo, 'repo'));
  const store = new TodoStore(todoFilePath(repo));
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
  const response = { todo: result.value, todos: result.file.todos };
  state.putIdempotent(body.idempotencyKey, response);
  return response;
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
  await rename(temporary, path);
}
