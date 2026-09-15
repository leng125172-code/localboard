import test from 'node:test';
import assert from 'node:assert/strict';
import { GhClient } from '../src/github/client.mjs';

test('paginates array and keyed GitHub REST responses', async () => {
  const client = new GhClient();
  const pages = [];
  client.rest = async (_method, _endpoint, fields) => {
    pages.push(fields.page);
    return fields.page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
  };
  const items = await client.restPaginated('repos/me/repo/issues', { per_page: 2 });
  assert.deepEqual(items.map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(pages, [1, 2]);

  client.rest = async (_method, _endpoint, fields) => ({ total_count: 3, workflow_runs: fields.page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] });
  const runs = await client.restPaginated('repos/me/repo/actions/runs', { per_page: 2 }, { listKey: 'workflow_runs' });
  assert.equal(runs.total_count, 3);
  assert.deepEqual(runs.workflow_runs.map((item) => item.id), [1, 2, 3]);
});
