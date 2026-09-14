import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { findGitRoot, todoFilePath } from './paths.mjs';
import { TodoStore } from './todo-store.mjs';

const execFileAsync = promisify(execFile);

export async function runPreCommit(cwd = process.cwd()) {
  const repoRoot = await findGitRoot(cwd);
  const path = todoFilePath(repoRoot);
  try {
    await access(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { staged: false, reason: 'no-personal-todo-file' };
    throw error;
  }
  await new TodoStore(path).read();
  await execFileAsync('git', ['add', '--', join('.localboard', 'todos.json')], { cwd: repoRoot, windowsHide: true });
  return { staged: true, repoRoot };
}

export async function runPrePush(cwd = process.cwd()) {
  const repoRoot = await findGitRoot(cwd);
  const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', '.localboard/todos.json'], {
    cwd: repoRoot,
    windowsHide: true
  });
  if (stdout.trim()) throw new Error('.localboard/todos.json has uncommitted changes; commit them before push');
  return { allowed: true, repoRoot };
}
