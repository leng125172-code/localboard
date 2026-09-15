import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCodexHook } from '../src/core/codex-hook.mjs';

test('Codex SessionStart publishes context and starts the single-instance desktop', async () => {
  const calls = [];
  const result = await handleCodexHook({ hook_event_name: 'SessionStart', cwd: 'C:/repo' }, {
    publish: async (payload) => { calls.push(['publish', payload]); return { context: { ok: true } }; },
    launch: async (options) => { calls.push(['launch', options]); return { launched: true }; }
  });
  assert.deepEqual(calls.map(([name]) => name), ['publish', 'launch']);
  assert.equal(calls[1][1].cwd, 'C:/repo');
  assert.equal(result.desktop.launched, true);
});

test('non-session Codex hooks do not repeatedly launch or focus the desktop', async () => {
  let launchCount = 0;
  await handleCodexHook({ hook_event_name: 'UserPromptSubmit', cwd: 'C:/repo' }, {
    publish: async () => ({}),
    launch: async () => { launchCount += 1; }
  });
  assert.equal(launchCount, 0);
});

test('Codex hook normalizes nested runtime context before publishing', async () => {
  const calls = [];
  await handleCodexHook({
    hook_event_name: 'SessionStart',
    hook_event: {
      cwd: 'C:/nested-repo',
      session_id: 'nested-session',
      turn_id: 'nested-turn'
    }
  }, {
    publish: async (payload) => { calls.push(['publish', payload]); return {}; },
    launch: async (options) => { calls.push(['launch', options]); return {}; }
  });

  assert.equal(calls[0][1].cwd, 'C:/nested-repo');
  assert.equal(calls[0][1].session_id, 'nested-session');
  assert.equal(calls[0][1].turn_id, 'nested-turn');
  assert.equal(calls[1][1].cwd, 'C:/nested-repo');
});
