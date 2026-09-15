#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { brokerRequest, ensureBroker } from './core/broker-client.mjs';
import { findGitRoot, runtimeDirectory } from './core/paths.mjs';
import { githubContext } from './core/repo-config.mjs';
import { inspectRepositoryContext } from './core/repository-context.mjs';
import { publishExecutionContext } from './core/context-publisher.mjs';
import { runPreCommit, runPrePush } from './core/git-hooks.mjs';
import { launchDesktop } from './core/desktop-launcher.mjs';
import { handleCodexHook } from './core/codex-hook.mjs';
import { runMcpServer } from './mcp-server.mjs';

const execFileAsync = promisify(execFile);
const { positionals, options } = parseArgs(process.argv.slice(2));
const [group, command, ...args] = positionals;

try {
  const result = await dispatch(group, command, args, options);
  if (result !== undefined) print(result, options.json);
} catch (error) {
  console.error(`localboard: ${error.message}`);
  process.exitCode = 1;
}

async function dispatch(group, command, args, opts) {
  if (!group || group === 'help' || opts.help) return help();
  if (group === 'start' || group === 'open') {
    if (args.length) throw new Error('Only one startup path may be provided');
    return launchDesktop({ cwd: opts.repo || command || process.cwd(), foreground: Boolean(opts.foreground) });
  }
  if (group === 'daemon') return ensureBroker();
  if (group === 'mcp') return runMcpServer();
  if (group === 'status') return brokerRequest('/v1/status');
  if (group === 'workspace') return workspaceCommand(command, opts);
  if (group === 'todo') return todoCommand(command, args, opts);
  if (group === 'project') return projectCommand(command, args, opts);
  if (group === 'issue') return issueCommand(command, args, opts);
  if (group === 'pr') return prCommand(command, args, opts);
  if (group === 'actions') return actionsCommand(command, args, opts);
  if (group === 'note') return noteCommand(command, args, opts);
  if (group === 'context') return contextCommand(command, opts);
  if (group === 'hook') return hookCommand();
  if (group === 'events') return brokerRequest(`/v1/events?limit=${Number(opts.limit ?? 100)}`);
  if (group === 'outbox') return brokerRequest(`/v1/outbox${opts.status ? `?status=${encodeURIComponent(opts.status)}` : ''}`);
  if (group === 'git') {
    if (command === 'install') return installGitHooks(await findGitRoot(opts.repo));
    if (command === 'pre-commit') return runPreCommit(opts.repo);
    if (command === 'pre-push') return runPrePush(opts.repo);
  }
  throw new Error(`Unknown command: ${[group, command].filter(Boolean).join(' ')}`);
}

async function todoCommand(command, args, opts) {
  const target = await resolveTodoTarget(opts.repo || process.cwd(), opts.global ? 'global' : opts.scope);
  const query = new URLSearchParams({ scope: target.scope });
  if (target.projectId) query.set('projectId', target.projectId);
  if (command === 'list') return brokerRequest(`/v1/todos?${query}`);
  const idempotencyKey = opts.idempotencyKey || randomUUID();
  const base = { scope: target.scope, projectId: target.projectId };
  if (command === 'add') {
    return brokerRequest('/v1/todos', { method: 'POST', body: {
      ...base, operation: 'add', idempotencyKey,
      todo: {
        title: required(args[0], 'title'), description: opts.description ?? '',
        priority: Number(opts.priority ?? 0), tags: splitList(opts.tags), dueAt: opts.due ?? null
      }
    } });
  }
  if (command === 'done') {
    return brokerRequest('/v1/todos', { method: 'POST', body: {
      ...base, operation: 'update', id: required(args[0], 'id'), idempotencyKey, patch: { status: 'done' }
    } });
  }
  if (command === 'update') {
    const patch = compact({ title: opts.title, description: opts.description, status: opts.status,
      priority: opts.priority === undefined ? undefined : Number(opts.priority),
      tags: opts.tags === undefined ? undefined : splitList(opts.tags), dueAt: opts.due });
    return brokerRequest('/v1/todos', { method: 'POST', body: {
      ...base, operation: 'update', id: required(args[0], 'id'), idempotencyKey, patch
    } });
  }
  if (command === 'remove') {
    return brokerRequest('/v1/todos', { method: 'POST', body: {
      ...base, operation: 'remove', id: required(args[0], 'id'), idempotencyKey
    } });
  }
  throw new Error(`Unknown todo command: ${command}`);
}

async function workspaceCommand(command, opts) {
  if (command === 'list') return brokerRequest('/v1/projects');
  if (command === 'register') return brokerRequest('/v1/projects/register', {
    method: 'POST', body: { cwd: opts.cwd || opts.repo || process.cwd() }
  });
  throw new Error(`Unknown workspace command: ${command}`);
}

async function resolveTodoTarget(cwd, requestedScope) {
  if (requestedScope === 'global') return { scope: 'global', projectId: null };
  const context = await brokerRequest('/v1/projects/register', { method: 'POST', body: { cwd } });
  if (requestedScope === 'repository' && !context.isGitRepository) {
    throw new Error('Repository todos require a Git project');
  }
  return context.isGitRepository
    ? { scope: 'repository', projectId: context.projectId }
    : { scope: 'global', projectId: null };
}

async function projectCommand(command, args, opts) {
  const repoRoot = await findGitRoot(opts.repo);
  const context = await githubContext(repoRoot, opts);
  if (!context.projectNumber && command !== 'set-field' && command !== 'clear-field' && command !== 'update-draft') {
    throw new Error('Project number is not configured; pass --project-number');
  }
  if (command === 'get') return github({ action: 'project.get', ownerType: context.ownerType,
    owner: context.projectOwner, projectNumber: context.projectNumber }, context);
  if (command === 'pull') {
    const project = await github({ action: 'project.get', ownerType: context.ownerType,
      owner: context.projectOwner, projectNumber: context.projectNumber }, context);
    const items = await github({ action: 'project.items', projectId: project.id }, context);
    return { project, items };
  }
  if (command === 'set-field') {
    const projectId = opts.projectId || (await resolveProject(context)).id;
    return github({ action: 'project.setField', projectId, itemId: required(args[0], 'item-id'),
      fieldId: required(args[1], 'field-id'), valueType: required(args[2], 'value-type'),
      value: required(args[3], 'value'), expectedUpdatedAt: opts.expectedUpdatedAt,
      idempotencyKey: opts.idempotencyKey || randomUUID() }, context);
  }
  if (command === 'clear-field') {
    const projectId = opts.projectId || (await resolveProject(context)).id;
    return github({ action: 'project.clearField', projectId, itemId: required(args[0], 'item-id'),
      fieldId: required(args[1], 'field-id'), expectedUpdatedAt: opts.expectedUpdatedAt,
      idempotencyKey: opts.idempotencyKey || randomUUID() }, context);
  }
  if (command === 'update-draft') {
    return github({ action: 'project.updateDraft', draftIssueId: required(args[0], 'draft-issue-id'),
      title: opts.title, body: opts.body, expectedUpdatedAt: opts.expectedUpdatedAt,
      idempotencyKey: opts.idempotencyKey || randomUUID() }, context);
  }
  throw new Error(`Unknown project command: ${command}`);
}

async function issueCommand(command, args, opts) {
  const context = await githubContext(await findGitRoot(opts.repo), opts);
  const base = { owner: context.owner, repo: context.repo };
  if (command === 'list') return github({ action: 'issue.list', ...base, state: opts.state ?? 'open' }, context);
  if (command === 'create') return github({ action: 'issue.create', ...base,
    title: required(args[0], 'title'), body: opts.body ?? '', labels: splitList(opts.labels),
    assignees: splitList(opts.assignees), idempotencyKey: opts.idempotencyKey || randomUUID() }, context);
  if (command === 'close') return github({ action: 'issue.close', ...base,
    number: Number(required(args[0], 'number')), reason: opts.reason ?? 'completed',
    idempotencyKey: opts.idempotencyKey || randomUUID() }, context);
  if (command === 'update') return github({ action: 'issue.update', ...base,
    number: Number(required(args[0], 'number')), title: opts.title, body: opts.body,
    state: opts.state, idempotencyKey: opts.idempotencyKey || randomUUID() }, context);
  throw new Error(`Unknown issue command: ${command}`);
}

async function prCommand(command, args, opts) {
  const context = await githubContext(await findGitRoot(opts.repo), opts);
  const base = { owner: context.owner, repo: context.repo };
  if (command === 'list') return github({ action: 'pr.list', ...base, state: opts.state ?? 'open' }, context);
  if (command === 'get') return github({ action: 'pr.get', ...base, number: Number(required(args[0], 'number')) }, context);
  if (command === 'merge') return github({ action: 'pr.merge', ...base, number: Number(required(args[0], 'number')),
    method: opts.method ?? 'squash', allowWrite: Boolean(opts.yes), idempotencyKey: opts.idempotencyKey || randomUUID() }, context);
  throw new Error(`Unknown pr command: ${command}`);
}

async function actionsCommand(command, args, opts) {
  const context = await githubContext(await findGitRoot(opts.repo), opts);
  const base = { owner: context.owner, repo: context.repo };
  if (command === 'runs') return github({ action: 'actions.runs', ...base, branch: opts.branch, status: opts.status }, context);
  if (command === 'rerun') return github({ action: 'actions.rerun', ...base, runId: required(args[0], 'run-id'),
    failedOnly: Boolean(opts.failedOnly), allowWrite: Boolean(opts.yes), idempotencyKey: opts.idempotencyKey || randomUUID() }, context);
  if (command === 'cancel') return github({ action: 'actions.cancel', ...base, runId: required(args[0], 'run-id'),
    allowWrite: Boolean(opts.yes), idempotencyKey: opts.idempotencyKey || randomUUID() }, context);
  throw new Error(`Unknown actions command: ${command}`);
}

async function noteCommand(command, args, opts) {
  if (command === 'list') return brokerRequest('/v1/notes');
  if (command === 'add') return brokerRequest('/v1/notes', { method: 'POST', body: {
    title: args[0] ?? '便签', body: opts.body ?? '', color: opts.color, alwaysOnTop: opts.alwaysOnTop !== 'false'
  } });
  if (command === 'remove') return brokerRequest(`/v1/notes/${encodeURIComponent(required(args[0], 'id'))}`, { method: 'DELETE' });
  throw new Error(`Unknown note command: ${command}`);
}

async function contextCommand(command, opts) {
  const cwd = opts.cwd || process.cwd();
  if (command === 'inspect') return inspectRepositoryContext(cwd);
  if (command === 'publish') return publishExecutionContext({
    cwd,
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    contextKey: opts.contextKey,
    source: opts.source ?? 'skill',
    status: opts.status ?? 'active',
    model: opts.model
  });
  if (command === 'list') return brokerRequest(`/v1/contexts?includeEnded=${opts.includeEnded !== 'false'}`);
  throw new Error(`Unknown context command: ${command}`);
}

async function hookCommand() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    await handleCodexHook(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
  } catch (error) {
    await logHookError(error).catch(() => {});
    process.stderr.write(`localboard hook failed: ${error.message}\n`);
  }
  return {};
}

async function logHookError(error) {
  const directory = runtimeDirectory();
  await mkdir(directory, { recursive: true });
  const message = String(error?.stack || error).replace(/[\r\n]+/g, ' ');
  await appendFile(resolve(directory, 'hook-errors.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
}

async function resolveProject(context) {
  if (!context.projectNumber) throw new Error('Project number is not configured; pass --project-number');
  return github({ action: 'project.get', ownerType: context.ownerType, owner: context.projectOwner,
    projectNumber: context.projectNumber }, context);
}

function github(body, context) {
  return brokerRequest('/v1/github', { method: 'POST', body: {
    ...body,
    localRepoRoot: context.repository.repoRoot
  }, timeoutMs: 60_000 });
}

async function installGitHooks(repoRoot) {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repoRoot, windowsHide: true });
  const candidate = stdout.trim();
  const hooks = isAbsolute(candidate) ? candidate : resolve(repoRoot, candidate);
  await mkdir(hooks, { recursive: true });
  const scripts = {
    'pre-commit': '#!/bin/sh\nlocalboard git pre-commit\n',
    'pre-push': '#!/bin/sh\nlocalboard git pre-push\n'
  };
  for (const [name, content] of Object.entries(scripts)) {
    const path = resolve(hooks, name);
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).catch((error) => {
      if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite existing hook: ${path}`);
      throw error;
    });
    await chmod(path, 0o755);
  }
  return { installed: Object.keys(scripts), repoRoot };
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  const aliases = { h: 'help', j: 'json', r: 'repo', y: 'yes' };
  const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); continue; }
    const raw = arg.replace(/^--?/, '');
    const [rawName, inline] = raw.split(/=(.*)/s, 2);
    const name = camel(aliases[rawName] ?? rawName);
    if (inline !== undefined) options[name] = inline;
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('-')) options[name] = argv[++index];
    else options[name] = true;
  }
  return { positionals, options };
}

function print(value, asJson) {
  if (typeof value === 'string') return console.log(value);
  if (asJson || !Array.isArray(value)) return console.log(JSON.stringify(value, null, 2));
  console.table(value);
}

function help() {
  return `LocalBoard\n\n` +
    `  localboard start [path] [--foreground]\n` +
    `  localboard todo list|add|update|done|remove [--global|--scope global|repository]\n` +
    `  localboard project get|pull|set-field|clear-field|update-draft\n` +
    `  localboard issue list|create|update|close\n` +
    `  localboard pr list|get|merge\n` +
    `  localboard actions runs|rerun|cancel\n` +
    `  localboard note list|add|remove\n` +
    `  localboard context inspect|publish|list\n` +
    `  localboard workspace list|register | status | mcp\n` +
    `  localboard events | outbox | git install | daemon\n\n` +
    `Use --json for machine-readable output and --idempotency-key when retrying a mutation.`;
}

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required`);
  return value;
}

function splitList(value) {
  return value ? String(value).split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
