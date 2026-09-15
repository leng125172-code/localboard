import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export async function inspectGitStatus(repoRoot, options = {}) {
  const run = options.run ?? runCommand;
  const [branch, head, status, upstream] = await Promise.all([
    run('git', ['branch', '--show-current'], repoRoot),
    run('git', ['rev-parse', 'HEAD'], repoRoot).catch(() => ({ stdout: '' })),
    run('git', ['status', '--short', '--branch', '--untracked-files=all'], repoRoot),
    run('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], repoRoot).catch(() => ({ stdout: '0\t0' }))
  ]);
  const [behind = 0, ahead = 0] = String(upstream.stdout).trim().split(/\s+/).map(Number);
  const lines = String(status.stdout).split(/\r?\n/).filter(Boolean);
  return {
    repoRoot,
    branch: String(branch.stdout).trim() || '(detached)',
    headSha: String(head.stdout).trim() || null,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    changes: lines.filter((line) => !line.startsWith('##')).map(parseShortStatus),
    inspectedAt: new Date().toISOString()
  };
}

export async function readGitDiff(repoRoot, path, options = {}) {
  if (!path || path.includes('\0')) throw new Error('path is required');
  const run = options.run ?? runCommand;
  const staged = options.staged === true;
  const args = ['diff', '--no-ext-diff', '--no-color', ...(staged ? ['--cached'] : []), '--', path];
  const result = await run('git', args, repoRoot);
  return { path, staged, diff: String(result.stdout).slice(0, 1024 * 1024) };
}

export async function todoTrackingStatus(repoRoot, options = {}) {
  const run = options.run ?? runCommand;
  try {
    const ignored = await run('git', ['check-ignore', '-v', '--', '.localboard/todos.json'], repoRoot);
    return { ignored: true, rule: String(ignored.stdout).trim() };
  } catch (error) {
    if (error.code === 1 || error.exitCode === 1) return { ignored: false, rule: null };
    return { ignored: false, rule: null };
  }
}

export async function repairTodoIgnore(repoRoot) {
  const path = join(repoRoot, '.gitignore');
  const current = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const rules = ['!.localboard/', '!.localboard/todos.json'];
  const missing = rules.filter((rule) => !current.split(/\r?\n/).includes(rule));
  if (!missing.length) return { changed: false, path, rules };
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  await appendFile(path, `${prefix}# LocalBoard repository todo\n${missing.join('\n')}\n`, 'utf8');
  return { changed: true, path, rules: missing };
}

function parseShortStatus(line) {
  const indexStatus = line[0] ?? ' ';
  const worktreeStatus = line[1] ?? ' ';
  const rawPath = line.slice(3).trim();
  const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath;
  return {
    path,
    originalPath: rawPath.includes(' -> ') ? rawPath.split(' -> ')[0] : null,
    indexStatus,
    worktreeStatus,
    staged: indexStatus !== ' ' && indexStatus !== '?',
    untracked: indexStatus === '?' && worktreeStatus === '?'
  };
}

async function runCommand(executable, args, cwd) {
  try {
    return await execFileAsync(executable, args, { cwd, windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    error.exitCode = error.code;
    throw error;
  }
}
