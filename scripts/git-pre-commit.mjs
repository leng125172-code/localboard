#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { findGitRoot, todoFilePath } from '../src/core/paths.mjs';
import { TodoStore } from '../src/core/todo-store.mjs';

const execFileAsync = promisify(execFile);
try {
  const root = await findGitRoot();
  const path = todoFilePath(root);
  await access(path);
  await new TodoStore(path).read();
  await execFileAsync('git', ['add', '--', join('.localboard', 'todos.json')], { cwd: root, windowsHide: true });
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`LocalBoard pre-commit failed: ${error.message}`);
    process.exit(1);
  }
}

