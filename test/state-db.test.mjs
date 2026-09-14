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

