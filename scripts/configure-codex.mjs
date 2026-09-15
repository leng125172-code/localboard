#!/usr/bin/env node
import { cp, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hooksPath = resolve(required(options.hooks, '--hooks'));
  const configPath = resolve(required(options.config, '--config'));
  const skillSource = resolve(required(options.skillSource, '--skill-source'));
  const skillTarget = resolve(required(options.skillTarget, '--skill-target'));
  const command = required(options.command, '--command');
  const pluginSource = options.pluginSource ? resolve(options.pluginSource) : null;
  const pluginTarget = options.pluginTarget ? resolve(options.pluginTarget) : null;
  const marketplacePath = options.marketplace ? resolve(options.marketplace) : null;

  await mkdir(dirname(hooksPath), { recursive: true });
  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(dirname(skillTarget), { recursive: true });

  const hooks = await readJson(hooksPath, { hooks: {} });
  hooks.hooks ||= {};
  for (const eventName of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd']) {
    const entries = Array.isArray(hooks.hooks[eventName]) ? hooks.hooks[eventName] : [];
    hooks.hooks[eventName] = mergeLocalBoardHook(entries, localBoardHook(command));
  }
  await writeWithBackup(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

  const config = await readText(configPath, '');
  await writeWithBackup(configPath, enableMcp(enableHooks(config), command));
  await cp(skillSource, skillTarget, { recursive: true, force: true });
  if (pluginSource && pluginTarget && marketplacePath) {
    await mkdir(dirname(pluginTarget), { recursive: true });
    await cp(pluginSource, pluginTarget, { recursive: true, force: true });
    const marketplace = await readJson(marketplacePath, {
      name: 'personal', interface: { displayName: 'Personal plugins' }, plugins: []
    });
    marketplace.plugins = (marketplace.plugins || []).filter((item) => item.name !== 'localboard');
    marketplace.plugins.push({
      name: 'localboard', source: { source: 'local', path: './plugins/localboard' },
      policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_USE' }, category: 'Productivity'
    });
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeWithBackup(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  }

  console.log(JSON.stringify({ hooksPath, configPath, skillTarget, pluginTarget, marketplacePath, command }, null, 2));
}

function localBoardHook(executable) {
  const command = `"${executable}" hook`;
  return { type: 'command', command, commandWindows: command, timeout: 10 };
}

export function mergeLocalBoardHook(entries, hook) {
  const cleaned = entries.flatMap((entry) => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const remainingHooks = entry.hooks.filter((candidate) => !isLocalBoardHook(candidate));
    return remainingHooks.length ? [{ ...entry, hooks: remainingHooks }] : [];
  });
  const targetIndex = cleaned.findIndex(isUnconditionalMatcherGroup);
  if (targetIndex === -1) return [...cleaned, { hooks: [hook] }];
  return cleaned.map((entry, index) => index === targetIndex
    ? { ...entry, hooks: [...entry.hooks, hook] }
    : entry);
}

function isUnconditionalMatcherGroup(entry) {
  return Array.isArray(entry?.hooks) && (entry.matcher === undefined || entry.matcher === null || entry.matcher === '');
}

function isLocalBoardHook(hook) {
  return /(?:^|[\\/])localboard(?:\.cmd|\.exe)?["']?\s+(?:--)?hook(?:\s|$)/i.test(hook?.commandWindows || hook?.command || '');
}

export function enableHooks(text) {
  const normalized = text ? text.replace(/\r\n/g, '\n') : '';
  const section = normalized.match(/(^|\n)\[features\]\s*\n([\s\S]*?)(?=\n\[[^\n]+\]|$)/);
  if (!section) return `${normalized.trimEnd()}${normalized.trim() ? '\n\n' : ''}[features]\nhooks = true\n`;
  const body = section[2];
  const nextBody = /^\s*hooks\s*=.*$/m.test(body)
    ? body.replace(/^\s*hooks\s*=.*$/m, 'hooks = true')
    : `${body.trimEnd()}${body.trim() ? '\n' : ''}hooks = true\n`;
  return `${normalized.slice(0, section.index)}${section[1]}[features]\n${nextBody}${normalized.slice(section.index + section[0].length)}`;
}

export function enableMcp(text, command, options = {}) {
  const normalized = text ? text.replace(/\r\n/g, '\n') : '';
  const args = options.args ?? ['mcp'];
  const env = options.env ?? {};
  const envBlock = Object.keys(env).length
    ? `\n[mcp_servers.localboard.env]\n${Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(String(value))}`).join('\n')}\n`
    : '';
  const block = `[mcp_servers.localboard]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n${envBlock}`;
  const pattern = /(^|\n)\[mcp_servers\.localboard\]\s*\n[\s\S]*?(?=\n\[(?!mcp_servers\.localboard(?:\.|\]))[^\n]+\]|$)/;
  if (pattern.test(normalized)) return normalized.replace(pattern, (_match, prefix) => `${prefix}${block.trimEnd()}`) + (normalized.endsWith('\n') ? '\n' : '');
  return `${normalized.trimEnd()}${normalized.trim() ? '\n\n' : ''}${block}`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[key] = argv[index + 1];
  }
  return result;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function readText(path, fallback) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function writeWithBackup(path, content) {
  try {
    await copyFile(path, `${path}.bak-localboard-${Date.now()}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}
