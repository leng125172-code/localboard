import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { enableHooks, enableMcp, mergeLocalBoardHook } from '../scripts/configure-codex.mjs';

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

test('adds and replaces the LocalBoard MCP block idempotently', () => {
  const first = enableMcp('model = "test"\n', 'C:\\LocalBoard\\localboard.cmd');
  const second = enableMcp(first, 'D:\\Apps\\localboard.cmd');
  assert.equal((second.match(/\[mcp_servers\.localboard\]/g) || []).length, 1);
  assert.match(second, /D:\\\\Apps\\\\localboard\.cmd/);
  assert.doesNotMatch(second, /C:\\\\LocalBoard/);
});

test('merges LocalBoard into the unconditional matcher group without dropping other hooks', () => {
  const existing = { type: 'command', command: 'existing-tool start' };
  const staleLocalBoard = { type: 'command', command: 'C:\\old\\localboard.cmd hook', async: true };
  const replacement = { type: 'command', command: 'C:\\new\\localboard.cmd hook', timeout: 10 };
  const entries = [
    { matcher: 'special-tool', hooks: [{ type: 'command', command: 'matched-tool start' }] },
    { hooks: [existing, staleLocalBoard] }
  ];

  const merged = mergeLocalBoardHook(entries, replacement);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].hooks[0].command, 'matched-tool start');
  assert.deepEqual(merged[1].hooks, [existing, replacement]);
});

test('replaces packaged executable hooks using the --hook argument', () => {
  const stale = { type: 'command', command: '"C:\\Apps\\LocalBoard.exe" --hook', timeout: 10 };
  const replacement = { type: 'command', command: '"D:\\LocalBoard\\LocalBoard.exe" --hook', timeout: 10 };

  const merged = mergeLocalBoardHook([{ hooks: [stale] }], replacement);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].hooks, [replacement]);
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
    assert.equal(hooks.hooks.SessionStart.length, 1);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'existing-tool start');
    assert.equal(hooks.hooks.SessionStart[0].hooks.filter((hook) => hook.command.includes('localboard.cmd')).length, 1);
    for (const eventName of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd']) {
      const localBoardHook = hooks.hooks[eventName].flatMap((entry) => entry.hooks)
        .find((hook) => hook.command.includes('localboard.cmd'));
      assert.equal(localBoardHook.async, undefined);
      assert.equal(localBoardHook.timeout, 10);
    }
    assert.match(await readFile(join(codex, 'config.toml'), 'utf8'), /hooks = true\nother = true/);
    assert.match(await readFile(join(skillTarget, 'SKILL.md'), 'utf8'), /name: localboard/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
