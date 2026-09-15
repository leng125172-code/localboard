import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateDatabase } from '../src/core/state-db.mjs';
import { GitHubService } from '../src/github/service.mjs';

test('caches GitHub reads and invalidates them after a mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localboard-github-cache-'));
  const state = new StateDatabase(join(root, 'state.sqlite3'));
  const service = new GitHubService(state, {});
  let calls = 0;
  service.dispatch = async (request) => ({ action: request.action, call: ++calls });
  try {
    const request = { action: 'issue.list', owner: 'me', repo: 'repo', state: 'open' };
    assert.equal((await service.execute(request)).call, 1);
    assert.equal((await service.execute({ ...request })).call, 1);
    assert.equal((await service.execute({ ...request, refresh: true })).call, 2);

    await service.execute({ action: 'issue.close', owner: 'me', repo: 'repo', number: 1, idempotencyKey: 'close-1' });
    assert.equal((await service.execute(request)).call, 4);
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
