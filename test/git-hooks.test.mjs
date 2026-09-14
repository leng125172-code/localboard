import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreCommit, runPrePush } from '../src/core/git-hooks.mjs';
import { TodoStore } from '../src/core/todo-store.mjs';
import { createTodo } from '../src/core/model.mjs';

const execFileAsync = promisify(execFile);

test('git hooks stage personal todos and block an uncommitted push', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'localboard-hooks-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repoRoot, windowsHide: true });
    const store = new TodoStore(join(repoRoot, '.localboard', 'todos.json'));
    await store.mutate((file) => ({ ...file, todos: [createTodo({ title: 'tracked todo' })] }));

    const staged = await runPreCommit(repoRoot);
    assert.equal(staged.staged, true);
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: repoRoot, windowsHide: true });
    assert.match(stdout.replaceAll('\\', '/'), /\.localboard\/todos\.json/);

    await execFileAsync('git', ['config', 'user.email', 'localboard@example.invalid'], { cwd: repoRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'LocalBoard Test'], { cwd: repoRoot, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'track todos'], { cwd: repoRoot, windowsHide: true });
    await store.mutate((file) => ({ ...file, todos: [...file.todos, createTodo({ title: 'not committed' })] }));
    await assert.rejects(() => runPrePush(repoRoot), /uncommitted changes/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('pre-commit is a no-op before a personal todo file exists', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'localboard-hooks-empty-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repoRoot, windowsHide: true });
    assert.deepEqual(await runPreCommit(repoRoot), { staged: false, reason: 'no-personal-todo-file' });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
