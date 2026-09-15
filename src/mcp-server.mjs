import { randomUUID } from 'node:crypto';
import { brokerRequest } from './core/broker-client.mjs';
import { publishExecutionContext } from './core/context-publisher.mjs';

const tools = [
  tool('localboard_report_context', 'Report an agent execution path and status to LocalBoard.', {
    cwd: stringProperty('The agent working directory.'),
    status: { type: 'string', enum: ['active', 'waiting', 'ended'] },
    sessionId: stringProperty('Stable session identifier.'),
    agentId: stringProperty('Optional sub-agent identifier.'),
    model: stringProperty('Optional model name.')
  }, ['cwd']),
  tool('localboard_list_todos', 'List global todos or repository-local todos. If scope is omitted, a Git path uses repository todos and any other path uses global todos.', {
    cwd: stringProperty('Current working directory.'),
    scope: { type: 'string', enum: ['auto', 'global', 'repository'] }
  }),
  tool('localboard_add_todo', 'Add a global or repository-local personal todo.', {
    title: stringProperty('Todo title.'),
    cwd: stringProperty('Current working directory.'),
    scope: { type: 'string', enum: ['auto', 'global', 'repository'] },
    description: stringProperty('Optional details.'),
    priority: { type: 'integer', minimum: 0, maximum: 3 },
    tags: { type: 'array', items: { type: 'string' } },
    dueAt: stringProperty('Optional ISO due time.')
  }, ['title']),
  tool('localboard_update_todo', 'Update a personal todo.', {
    id: stringProperty('Todo identifier.'), cwd: stringProperty('Current working directory.'),
    scope: { type: 'string', enum: ['auto', 'global', 'repository'] },
    title: stringProperty('New title.'), description: stringProperty('New details.'),
    status: { type: 'string', enum: ['open', 'done'] }, priority: { type: 'integer', minimum: 0, maximum: 3 },
    tags: { type: 'array', items: { type: 'string' } }, dueAt: stringProperty('New ISO due time or empty string to clear it.')
  }, ['id']),
  tool('localboard_remove_todo', 'Remove a personal todo.', {
    id: stringProperty('Todo identifier.'), cwd: stringProperty('Current working directory.'),
    scope: { type: 'string', enum: ['auto', 'global', 'repository'] }
  }, ['id'])
];

export async function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  input.setEncoding?.('utf8');
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk;
    for (;;) {
      const parsed = nextMessage(buffer);
      if (!parsed) break;
      buffer = parsed.rest;
      if (parsed.message.id === undefined) continue;
      try {
        writeMessage(output, { jsonrpc: '2.0', id: parsed.message.id, result: await dispatch(parsed.message) });
      } catch (error) {
        writeMessage(output, { jsonrpc: '2.0', id: parsed.message.id,
          error: { code: -32603, message: error.message } });
      }
    }
  }
}

async function dispatch(message) {
  if (message.method === 'initialize') return {
    protocolVersion: message.params?.protocolVersion || '2025-03-26',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'localboard', version: '0.4.0' }
  };
  if (message.method === 'ping') return {};
  if (message.method === 'tools/list') return { tools };
  if (message.method !== 'tools/call') throw new Error(`Unsupported MCP method: ${message.method}`);
  const args = message.params?.arguments ?? {};
  const value = await callTool(message.params?.name, args);
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

async function callTool(name, args) {
  if (name === 'localboard_report_context') return publishExecutionContext({
    cwd: args.cwd || process.cwd(), status: args.status || 'active', sessionId: args.sessionId,
    agentId: args.agentId, model: args.model, source: 'mcp'
  });
  const target = await resolveTarget(args.cwd || process.cwd(), args.scope || 'auto');
  const base = { scope: target.scope, projectId: target.projectId };
  if (name === 'localboard_list_todos') {
    const query = new URLSearchParams({ scope: target.scope });
    if (target.projectId) query.set('projectId', target.projectId);
    return brokerRequest(`/v1/todos?${query}`);
  }
  if (name === 'localboard_add_todo') return mutate({ ...base, operation: 'add', todo: {
    title: args.title, description: args.description || '', priority: args.priority || 0,
    tags: args.tags || [], dueAt: args.dueAt || null
  } });
  if (name === 'localboard_update_todo') {
    const patch = Object.fromEntries(Object.entries(args).filter(([key, value]) =>
      ['title', 'description', 'status', 'priority', 'tags', 'dueAt'].includes(key) && value !== undefined));
    return mutate({ ...base, operation: 'update', id: args.id, patch });
  }
  if (name === 'localboard_remove_todo') return mutate({ ...base, operation: 'remove', id: args.id });
  throw new Error(`Unknown LocalBoard tool: ${name}`);
}

function mutate(body) {
  return brokerRequest('/v1/todos', { method: 'POST', body: { ...body, idempotencyKey: randomUUID() } });
}

async function resolveTarget(cwd, scope) {
  if (scope === 'global') return { scope: 'global', projectId: null };
  const project = await brokerRequest('/v1/projects/register', { method: 'POST', body: { cwd } });
  if (scope === 'repository' && !project.isGitRepository) throw new Error('Repository todos require a Git project');
  return project.isGitRepository ? { scope: 'repository', projectId: project.projectId } : { scope: 'global', projectId: null };
}

function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

function stringProperty(description) { return { type: 'string', description }; }

function nextMessage(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd >= 0 && /^content-length:/i.test(buffer)) {
    const header = buffer.slice(0, headerEnd);
    const length = Number(header.match(/content-length:\s*(\d+)/i)?.[1]);
    if (!Number.isFinite(length) || buffer.length < headerEnd + 4 + length) return null;
    const start = headerEnd + 4;
    return { message: JSON.parse(buffer.slice(start, start + length)), rest: buffer.slice(start + length) };
  }
  const newline = buffer.indexOf('\n');
  if (newline < 0) return null;
  const line = buffer.slice(0, newline).trim();
  return line ? { message: JSON.parse(line), rest: buffer.slice(newline + 1) }
    : { message: {}, rest: buffer.slice(newline + 1) };
}

function writeMessage(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}
