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
  await publishExecutionContext({ cwd: '.', source: 'skill' }, { brokerRequest, repositoryOptions: { run } });
  await publishExecutionContext({ cwd: '.', source: 'skill' }, { brokerRequest, repositoryOptions: { run } });
  assert.notEqual(published[0].contextKey, published[1].contextKey);
  assert.equal(published.every((item) => item.repository.syncReason === 'not-git'), true);
});
