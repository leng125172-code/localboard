import { cp, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { enableHooks, enableMcp, mergeLocalBoardHook } from '../../scripts/configure-codex.mjs';
import { runtimeDirectory } from './paths.mjs';

export async function installBundledIntegrations({ appRoot, integrationRoot = appRoot, command = process.execPath,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  agentHome = process.env.LOCALBOARD_AGENT_HOME || join(homedir(), '.agents'),
  statusPath = join(runtimeDirectory(), 'integration-status.json') } = {}) {
  const root = resolve(appRoot);
  const results = {};
  results.codex = await attempt(async () => {
    const hooksPath = join(codexHome, 'hooks.json');
    const hooks = await readJson(hooksPath, { hooks: {} });
    hooks.hooks ||= {};
    const hook = { type: 'command', command: `"${command}" --hook`, commandWindows: `"${command}" --hook`, timeout: 10 };
    for (const eventName of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd']) {
      hooks.hooks[eventName] = mergeLocalBoardHook(Array.isArray(hooks.hooks[eventName]) ? hooks.hooks[eventName] : [], hook);
    }
    await atomicBackupWrite(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
    const configPath = join(codexHome, 'config.toml');
    const config = await readText(configPath, '');
    const mcpScript = join(root, 'src', 'cli.mjs');
    const mcpEnv = { ELECTRON_RUN_AS_NODE: '1', LOCALBOARD_PACKAGED_EXECUTABLE: '1' };
    await atomicBackupWrite(configPath, enableMcp(enableHooks(config), command, {
      args: [mcpScript, 'mcp'], env: mcpEnv
    }));
    return { hooksPath, configPath };
  });
  results.skill = await attempt(async () => {
    const target = join(agentHome, 'skills', 'localboard');
    await mkdir(dirname(target), { recursive: true });
    const source = integrationRoot === appRoot
      ? join(root, '.agents', 'skills', 'localboard')
      : join(resolve(integrationRoot), 'integrations', 'skills', 'localboard');
    await cp(source, target, { recursive: true, force: true });
    return { target };
  });
  results.plugin = await attempt(async () => {
    const target = join(agentHome, 'plugins', 'localboard');
    await mkdir(dirname(target), { recursive: true });
    const source = integrationRoot === appRoot
      ? join(root, 'integrations', 'plugins', 'localboard')
      : join(resolve(integrationRoot), 'integrations', 'plugins', 'localboard');
    await cp(source, target, { recursive: true, force: true });
    const mcpPath = join(target, '.mcp.json');
    const mcp = await readJson(mcpPath, { mcpServers: { localboard: {} } });
    mcp.mcpServers.localboard = { command, args: [join(root, 'src', 'cli.mjs'), 'mcp'],
      env: { ELECTRON_RUN_AS_NODE: '1', LOCALBOARD_PACKAGED_EXECUTABLE: '1' } };
    await atomicBackupWrite(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
    const marketplacePath = join(agentHome, 'plugins', 'marketplace.json');
    const marketplace = await readJson(marketplacePath, { name: 'personal', interface: { displayName: 'Personal plugins' }, plugins: [] });
    marketplace.plugins = (marketplace.plugins || []).filter((item) => item.name !== 'localboard');
    marketplace.plugins.push({ name: 'localboard', source: { source: 'local', path: './plugins/localboard' },
      policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_USE' }, category: 'Productivity' });
    await atomicBackupWrite(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
    return { target, marketplacePath };
  });
  const status = { installedAt: new Date().toISOString(), results };
  await mkdir(dirname(statusPath), { recursive: true });
  await writeFile(statusPath, JSON.stringify(status, null, 2), 'utf8');
  return status;
}

async function attempt(work) {
  try { return { ok: true, ...(await work()) }; }
  catch (error) { return { ok: false, error: error.message }; }
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function readText(path, fallback) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicBackupWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await copyFile(path, `${path}.bak-localboard`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}
