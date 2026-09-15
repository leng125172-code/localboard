import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateDatabase } from '../src/core/state-db.mjs';

test('persists idempotency and merges partial note updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-db-'));
  const state = new StateDatabase(join(root, 'state.sqlite3'));
  try {
    state.putIdempotent('same-op', { ok: true });
    assert.deepEqual(state.getIdempotent('same-op'), { ok: true });
    const note = state.saveNote({ title: 'A', body: 'keep me', color: '#fff3a6' });
    state.saveNote({ id: note.id, x: 42 });
    assert.equal(state.listNotes()[0].body, 'keep me');
    assert.equal(state.listNotes()[0].x, 42);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps concurrent Codex contexts isolated by context key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-contexts-'));
  const state = new StateDatabase(join(root, 'state.sqlite3'));
  try {
    const repository = { cwd: 'C:/repo', isGitRepository: true, syncReason: 'github-not-configured' };
    state.upsertAgentContext({ contextKey: 'codex:a:main', sessionId: 'a', status: 'active', repository });
    state.upsertAgentContext({ contextKey: 'codex:b:main', sessionId: 'b', status: 'active', repository });
    state.upsertAgentContext({ contextKey: 'codex:a:main', sessionId: 'a', status: 'idle', repository });
    const contexts = state.listAgentContexts();
    assert.equal(contexts.length, 2);
    assert.equal(contexts.find((item) => item.sessionId === 'a').status, 'idle');
    assert.equal(contexts.find((item) => item.sessionId === 'b').status, 'active');
    assert.equal(state.listAgentContexts({ staleAfterMinutes: -1 }).find((item) => item.sessionId === 'b').status, 'stale');
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
