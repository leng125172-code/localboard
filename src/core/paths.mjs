import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export function runtimeDirectory(env = process.env) {
  return join(env.LOCALAPPDATA || env.XDG_RUNTIME_DIR || join(homedir(), '.local', 'state'), 'LocalBoard');
}

export function temporaryRuntimeDirectory() {
  return join(tmpdir(), `localboard-${process.getuid?.() ?? process.env.USERNAME ?? 'user'}`);
}

export async function findGitRoot(cwd = process.cwd()) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true });
    return resolve(stdout.trim());
  } catch {
    throw new Error(`Not inside a Git repository: ${cwd}`);
  }
}

export function todoFilePath(repoRoot) {
  return join(repoRoot, '.localboard', 'todos.json');
}

