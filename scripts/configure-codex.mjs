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

  await mkdir(dirname(hooksPath), { recursive: true });
  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(dirname(skillTarget), { recursive: true });

  const hooks = await readJson(hooksPath, { hooks: {} });
  hooks.hooks ||= {};
  for (const eventName of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd']) {
    const entries = Array.isArray(hooks.hooks[eventName]) ? hooks.hooks[eventName] : [];
    hooks.hooks[eventName] = entries.filter((entry) => !isLocalBoardEntry(entry));
    hooks.hooks[eventName].push(localBoardEntry(command, eventName !== 'SessionEnd'));
  }
  await writeWithBackup(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

  const config = await readText(configPath, '');
  await writeWithBackup(configPath, enableHooks(config));
  await cp(skillSource, skillTarget, { recursive: true, force: true });

  console.log(JSON.stringify({ hooksPath, configPath, skillTarget, command }, null, 2));
}

function localBoardEntry(executable, async) {
  const hook = { type: 'command', command: `"${executable}" hook`, commandWindows: `"${executable}" hook`, timeout: async ? 10 : 3 };
  if (async) hook.async = true;
  return { hooks: [hook] };
}

function isLocalBoardEntry(entry) {
  return entry?.hooks?.some((hook) => /(?:^|[\\/])localboard(?:\.cmd)?["']?\s+hook(?:\s|$)/i.test(hook.commandWindows || hook.command || ''));
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
