import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRepositoryContext } from '../src/core/repository-context.mjs';

test('does not inspect GitHub when cwd is not an initialized Git repository', async () => {
  const calls = [];
  const run = async (executable, args) => {
    calls.push([executable, ...args]);
    throw new Error('not a repository');
  };
  const context = await inspectRepositoryContext('.', { run });
  assert.equal(context.isGitRepository, false);
  assert.equal(context.syncGitHub, false);
  assert.equal(context.syncReason, 'not-git');
  assert.equal(calls.some(([executable]) => executable === 'gh'), false);
});

test('does not invoke gh when GitHub has no remote or configuration', async () => {
  const calls = [];
  const run = async (executable, args) => {
    calls.push([executable, ...args]);
    const command = args.join(' ');
    if (command === 'rev-parse --show-toplevel') return { stdout: 'C:/repo\n' };
    if (command === 'rev-parse --git-common-dir') return { stdout: '.git\n' };
    if (command === 'rev-parse --git-dir') return { stdout: '.git\n' };
    if (command === 'branch --show-current') return { stdout: 'main\n' };
    if (command === 'rev-parse HEAD') return { stdout: 'abc123\n' };
    if (command.startsWith('status ')) return { stdout: '' };
    if (command === 'config --get remote.origin.url') throw new Error('no remote');
    throw new Error(`unexpected command: ${executable} ${command}`);
  };
  const context = await inspectRepositoryContext('.', { run, config: {} });
  assert.equal(context.isGitRepository, true);
  assert.equal(context.syncReason, 'github-not-configured');
  assert.equal(calls.some(([executable]) => executable === 'gh'), false);
});

test('reports configured but unauthenticated GitHub without enabling sync', async () => {
  const run = async (executable, args) => {
    const command = args.join(' ');
    if (executable === 'gh') throw new Error('not authenticated');
    if (command === 'rev-parse --show-toplevel') return { stdout: 'C:/repo\n' };
    if (command === 'rev-parse --git-common-dir') return { stdout: '.git\n' };
    if (command === 'rev-parse --git-dir') return { stdout: '.git/worktrees/feature\n' };
    if (command === 'branch --show-current') return { stdout: 'main\n' };
    if (command === 'rev-parse HEAD') return { stdout: 'abc123\n' };
    if (command.startsWith('status ')) return { stdout: '' };
    if (command === 'config --get remote.origin.url') return { stdout: 'git@github.com:owner/repo.git\n' };
    throw new Error(`unexpected command: ${executable} ${command}`);
  };
  const context = await inspectRepositoryContext('.', { run, config: {} });
  assert.equal(context.githubRepository, 'owner/repo');
  assert.equal(context.githubConfigured, true);
  assert.equal(context.githubAuthConnected, false);
  assert.equal(context.syncGitHub, false);
  assert.equal(context.syncReason, 'github-not-authenticated');
  assert.equal(context.isLinkedWorktree, true);
  assert.equal(context.personalTodoScope, 'branch-worktree');
});

test('blocks GitHub sync when the active account differs from the repository account', async () => {
  const run = async (executable, args) => {
    const command = args.join(' ');
    if (executable === 'gh') return { stdout: JSON.stringify({ hosts: { 'github.com': [
      { login: 'work-account', active: true, state: 'success' }
    ] } }) };
    if (command === 'rev-parse --show-toplevel') return { stdout: 'C:/repo\n' };
    if (command === 'rev-parse --git-common-dir' || command === 'rev-parse --git-dir') return { stdout: '.git\n' };
    if (command === 'branch --show-current') return { stdout: 'main\n' };
    if (command === 'rev-parse HEAD') return { stdout: 'abc123\n' };
    if (command.startsWith('status ')) return { stdout: '' };
    if (command === 'config --get remote.origin.url') return { stdout: 'https://github.com/personal/todos.git\n' };
    throw new Error(`unexpected command: ${executable} ${command}`);
  };
  const context = await inspectRepositoryContext('.', {
    run,
    config: { github: { account: 'personal', repositories: ['personal/todos'] } }
  });
  assert.equal(context.activeGithubAccount, 'work-account');
  assert.equal(context.expectedGithubAccount, 'personal');
  assert.equal(context.githubAuthConnected, false);
  assert.equal(context.syncReason, 'github-account-mismatch');
  assert.equal(context.syncGitHub, false);
});
