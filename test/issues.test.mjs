import test from 'node:test';
import assert from 'node:assert/strict';
import { IssuesApi } from '../src/github/issues.mjs';

test('does not leak LocalBoard transport metadata into an Issue update', async () => {
  let captured;
  const api = new IssuesApi({ rest: async (method, endpoint, fields) => {
    captured = { method, endpoint, fields };
    return { ok: true };
  } });
  await api.update({ owner: 'me', repo: 'repo', number: 3, title: 'new', action: 'issue.update', localRepoRoot: 'C:/repo', idempotencyKey: 'key' });
  assert.deepEqual(captured, {
    method: 'PATCH',
    endpoint: 'repos/me/repo/issues/3',
    fields: { title: 'new', body: undefined, state: undefined, state_reason: undefined, labels: undefined, assignees: undefined, milestone: undefined }
  });
});
