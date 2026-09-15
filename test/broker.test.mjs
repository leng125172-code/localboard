import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('broker is a single writer and replays an idempotent mutation', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'localboard-broker-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = runtime;
  const { startBroker } = await import('../src/core/broker-server.mjs');
  const { brokerRequest } = await import('../src/core/broker-client.mjs');
  const repo = join(runtime, 'repo');
  const broker = await startBroker();
  try {
    assert.equal(broker.owner, true);
    assert.equal((await startBroker()).owner, false);
    const body = { repo, operation: 'add', idempotencyKey: 'repeat', todo: { title: 'one' } };
    const first = await brokerRequest('/v1/todos', { endpoint: broker.endpoint, method: 'POST', body });
    const second = await brokerRequest('/v1/todos', { endpoint: broker.endpoint, method: 'POST', body });
    assert.equal(first.todos.length, 1);
    assert.equal(second.todos.length, 1);
    assert.equal(second.replayed, true);
    await assert.rejects(() => brokerRequest('/v1/github', {
      endpoint: broker.endpoint, method: 'POST', body: { action: 'issue.list', owner: 'me', repo: 'repo' }
    }), /localRepoRoot is required/);
  } finally {
    await broker.close();
    if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    await rm(runtime, { recursive: true, force: true });
  }
});
