import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installBundledIntegrations } from '../src/core/integration-installer.mjs';

test('installs Hook, Skill, MCP, and plugin independently into user-scoped paths', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'localboard-integrations-'));
  const codexHome = join(sandbox, '.codex');
  const agentHome = join(sandbox, '.agents');
  const statusPath = join(sandbox, 'runtime', 'integration-status.json');
  try {
    const result = await installBundledIntegrations({
      appRoot: resolve('.'), command: 'C:\\Apps\\LocalBoard.exe', codexHome, agentHome, statusPath
    });
    await installBundledIntegrations({
      appRoot: resolve('.'), command: 'C:\\Apps\\LocalBoard.exe', codexHome, agentHome, statusPath
    });
    assert.equal(result.results.codex.ok, true);
    assert.equal(result.results.skill.ok, true);
    assert.equal(result.results.plugin.ok, true);
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
    assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /LocalBoard\.exe.*--hook/);
    assert.equal(hooks.hooks.SessionStart.flatMap((entry) => entry.hooks)
      .filter((hook) => /LocalBoard\.exe.*--hook/.test(hook.command)).length, 1);
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /\[mcp_servers\.localboard\]/);
    assert.match(config, /ELECTRON_RUN_AS_NODE = "1"/);
    const pluginMcp = JSON.parse(await readFile(join(agentHome, 'plugins', 'localboard', '.mcp.json'), 'utf8'));
    assert.equal(pluginMcp.mcpServers.localboard.args.at(-1), 'mcp');
    assert.equal(pluginMcp.mcpServers.localboard.env.ELECTRON_RUN_AS_NODE, '1');
    const marketplace = JSON.parse(await readFile(join(agentHome, 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.plugins.find((item) => item.name === 'localboard').policy.installation, 'INSTALLED_BY_DEFAULT');
    assert.equal(JSON.parse(await readFile(statusPath, 'utf8')).results.plugin.ok, true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
