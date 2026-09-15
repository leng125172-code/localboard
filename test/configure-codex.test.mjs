import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { enableHooks } from '../scripts/configure-codex.mjs';

const execFileAsync = promisify(execFile);

test('enables Codex hooks without replacing other feature settings', () => {
  const input = 'model = "test"\n\n[features]\nhooks = false\njs_repl = true\n\n[desktop]\nmode = "steps"\n';
  const output = enableHooks(input);
  assert.match(output, /\[features\]\nhooks = true\njs_repl = true/);
  assert.match(output, /\[desktop\]\nmode = "steps"/);
});

test('adds a features section when Codex config has none', () => {
  assert.equal(enableHooks('model = "test"\n'), 'model = "test"\n\n[features]\nhooks = true\n');
});

test('Codex setup preserves existing hooks and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-codex-config-'));
  try {
    const codex = join(root, 'codex');
    const skillSource = join(root, 'skill-source');
    const skillTarget = join(root, 'agents', 'skills', 'localboard');
    await mkdir(codex, { recursive: true });
    await mkdir(skillSource, { recursive: true });
    await writeFile(join(skillSource, 'SKILL.md'), '---\nname: localboard\n---\n', 'utf8');
    await writeFile(join(codex, 'hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'existing-tool start' }] }]
    } }), 'utf8');
    await writeFile(join(codex, 'config.toml'), '[features]\nhooks = false\nother = true\n', 'utf8');
    const args = [resolve('scripts/configure-codex.mjs'),
      '--hooks', join(codex, 'hooks.json'), '--config', join(codex, 'config.toml'),
      '--skill-source', skillSource, '--skill-target', skillTarget,
      '--command', 'C:\\LocalBoard\\localboard.cmd'];
    await execFileAsync(process.execPath, args);
    await execFileAsync(process.execPath, args);

    const hooks = JSON.parse(await readFile(join(codex, 'hooks.json'), 'utf8'));
    assert.equal(hooks.hooks.SessionStart.length, 2);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'existing-tool start');
    assert.equal(hooks.hooks.SessionStart.filter((entry) => entry.hooks[0].command.includes('localboard.cmd')).length, 1);
    assert.match(await readFile(join(codex, 'config.toml'), 'utf8'), /hooks = true\nother = true/);
    assert.match(await readFile(join(skillTarget, 'SKILL.md'), 'utf8'), /name: localboard/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
