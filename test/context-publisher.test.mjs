import test from 'node:test';
import assert from 'node:assert/strict';
import { publishExecutionContext } from '../src/core/context-publisher.mjs';

test('manual skill publications use distinct keys and cannot overwrite another Codex instance', async () => {
  const published = [];
  const brokerRequest = async (_path, options) => {
    published.push(options.body);
    return options.body;
  };
  const run = async () => { throw new Error('not a repository'); };
  await publishExecutionContext({ cwd: '.', source: 'skill' }, { brokerRequest, repositoryOptions: { run }, env: {} });
  await publishExecutionContext({ cwd: '.', source: 'skill' }, { brokerRequest, repositoryOptions: { run }, env: {} });
  assert.notEqual(published[0].contextKey, published[1].contextKey);
  assert.equal(published.every((item) => item.repository.syncReason === 'not-git'), true);
});

test('uses the Codex session environment as a stable isolated context key', async () => {
  const brokerRequest = async (_path, options) => options.body;
  const run = async () => { throw new Error('not a repository'); };
  const options = { brokerRequest, repositoryOptions: { run }, env: { CODEX_SESSION_ID: 'session-a' } };
  const first = await publishExecutionContext({ cwd: 'C:/one' }, options);
  const second = await publishExecutionContext({ cwd: 'C:/two' }, options);
  assert.equal(first.contextKey, 'codex:session-a:main');
  assert.equal(second.contextKey, first.contextKey);
});
