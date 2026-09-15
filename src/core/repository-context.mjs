import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readRepoConfig } from './config-file.mjs';

const execFileAsync = promisify(execFile);
const githubAuthCache = new Map();

export async function inspectRepositoryContext(cwd = process.cwd(), options = {}) {
  const run = options.run ?? runCommand;
  const inspectedAt = new Date().toISOString();
  const base = {
    cwd: resolve(cwd),
    isGitRepository: false,
    githubConfigured: false,
    githubAuthConnected: false,
    syncGitHub: false,
    syncReason: 'not-git',
    inspectedAt
  };

  const rootResult = await tryRun(run, 'git', ['rev-parse', '--show-toplevel'], cwd);
  if (!rootResult.ok || !rootResult.stdout.trim()) return base;

  const repoRoot = resolve(rootResult.stdout.trim());
  const config = options.config ?? await readRepoConfig(repoRoot);
  const results = await Promise.all([
    tryRun(run, 'git', ['rev-parse', '--git-common-dir'], repoRoot),
    tryRun(run, 'git', ['rev-parse', '--git-dir'], repoRoot),
    tryRun(run, 'git', ['branch', '--show-current'], repoRoot),
    tryRun(run, 'git', ['rev-parse', 'HEAD'], repoRoot),
    tryRun(run, 'git', ['status', '--porcelain', '--untracked-files=no'], repoRoot),
    tryRun(run, 'git', ['config', '--get', 'remote.origin.url'], repoRoot)
  ]);
  const [common, gitDirResult, branch, head, status, remote] = results;
  const remoteUrl = sanitizeRemoteUrl(remote.ok ? remote.stdout.trim() : null);
  const configuredRepository = options.repositoryOverride || config.github?.repositories?.[0] || parseGitHubRepository(remoteUrl);
  const githubEnabled = config.github?.enabled !== false;
  const githubConfigured = githubEnabled && Boolean(configuredRepository);
  const expectedGithubAccount = config.github?.account || null;
  let githubAuthConnected = false;
  let activeGithubAccount = null;

  // Do not even invoke gh unless this is a Git repository with GitHub configured.
  if (githubConfigured && options.checkGitHubAuth !== false) {
    const authKey = `github.com\0${repoRoot}\0${expectedGithubAccount ?? ''}`;
    const cached = options.run === undefined && options.authCache !== false ? githubAuthCache.get(authKey) : null;
    if (cached && Date.now() - cached.checkedAt < Number(options.authCacheTtlMs ?? 15_000)) {
      githubAuthConnected = cached.connected;
      activeGithubAccount = cached.account;
    } else {
      const auth = await tryRun(run, 'gh', ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'], repoRoot);
      activeGithubAccount = auth.ok ? activeAccountFromStatus(auth.stdout) : null;
      githubAuthConnected = auth.ok && (!expectedGithubAccount || sameAccount(activeGithubAccount, expectedGithubAccount));
      if (options.run === undefined && options.authCache !== false) {
        githubAuthCache.set(authKey, { connected: githubAuthConnected, account: activeGithubAccount, checkedAt: Date.now() });
      }
    }
  }

  const syncReason = !githubEnabled
    ? 'github-disabled'
    : !githubConfigured
      ? 'github-not-configured'
      : expectedGithubAccount && activeGithubAccount && !sameAccount(activeGithubAccount, expectedGithubAccount)
        ? 'github-account-mismatch'
        : !githubAuthConnected
        ? 'github-not-authenticated'
        : 'ready';
  const commonDir = common.ok ? common.stdout.trim() : '.git';
  const gitDir = gitDirResult.ok ? gitDirResult.stdout.trim() : commonDir;
  const resolvedCommonDir = resolve(repoRoot, commonDir);
  const resolvedGitDir = resolve(repoRoot, gitDir);
  const repositoryKey = createHash('sha256')
    .update(`${repoRoot}\0${resolvedCommonDir}\0${configuredRepository ?? remoteUrl ?? ''}`)
    .digest('hex');

  return {
    ...base,
    isGitRepository: true,
    repoRoot,
    repositoryKey,
    repositoryName: repoRoot.split(/[\\/]/).at(-1),
    gitCommonDir: commonDir,
    gitDir,
    isLinkedWorktree: resolvedGitDir !== resolvedCommonDir,
    personalTodoScope: 'branch-worktree',
    branch: branch.ok ? branch.stdout.trim() || '(detached)' : '(unknown)',
    headSha: head.ok ? head.stdout.trim() : null,
    workingTreeDirty: status.ok && Boolean(status.stdout.trim()),
    changedFileCount: status.ok ? status.stdout.split(/\r?\n/).filter(Boolean).length : null,
    remoteUrl,
    githubRepository: configuredRepository ?? null,
    githubConfigured,
    githubAuthConnected,
    activeGithubAccount,
    expectedGithubAccount,
    syncGitHub: syncReason === 'ready',
    syncReason,
    github: config.github ?? null
  };
}

export function activeAccountFromStatus(output) {
  try {
    const status = JSON.parse(output);
    const accounts = status.hosts?.['github.com'] ?? [];
    return accounts.find((account) => account.active && account.state === 'success')?.login ?? null;
  } catch {
    return null;
  }
}

function sameAccount(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}

export function parseGitHubRepository(remoteUrl) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl.replace(/\.git$/, '');
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function sanitizeRemoteUrl(remoteUrl) {
  if (!remoteUrl) return null;
  try {
    const parsed = new URL(remoteUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return remoteUrl;
  }
}

async function runCommand(executable, args, cwd) {
  return execFileAsync(executable, args, { cwd, windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 });
}

async function tryRun(run, executable, args, cwd) {
  try {
    const result = await run(executable, args, cwd);
    return { ok: true, stdout: String(result?.stdout ?? '') };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? ''), error };
  }
}
