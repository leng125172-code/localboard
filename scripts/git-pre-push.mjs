#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findGitRoot } from '../src/core/paths.mjs';

const execFileAsync = promisify(execFile);
const root = await findGitRoot();
const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', '.localboard/todos.json'], {
  cwd: root, windowsHide: true
});
if (stdout.trim()) {
  console.error('LocalBoard: .localboard/todos.json has uncommitted changes. Commit them before push.');
  process.exit(1);
}

