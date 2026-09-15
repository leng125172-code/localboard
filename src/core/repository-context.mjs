import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, resolve } from 'node:path';
import { readRepoConfig } from './config-file.mjs';

const execFileAsync = promisify(execFile);
const githubAuthCache = new Map();

export async function inspectRepositoryContext(cwd = process.cwd(), options = {}) {
  const run = options.run ?? runCommand;
  const inspectedAt = new Date().toISOString();
  const resolvedCwd = resolve(cwd);
  const base = {
    projectId: `path:${createHash('sha256').update(resolvedCwd.toLowerCase()).digest('hex')}`,
    projectKind: 'non-git',
    repositoryName: basename(resolvedCwd) || resolvedCwd,
    cwd: resolvedCwd,
    isGitRepository: false,
    ghAvailable: null,
    githubAuthAccounts: [],
    githubConfigured: false,
    githubAuthConnected: false,
    syncGitHub: false,
    syncReason: 'not-git',
    capabilities: ['global-todos'],
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
    tryRun(run, 'git', ['config', '--get', 'remote.origin.url'], repoRoot),
    tryRun(run, 'git', ['remote', '-v'], repoRoot)
  ]);
  const [common, gitDirResult, branch, head, status, remote, remoteList] = results;
  const remoteUrl = sanitizeRemoteUrl(remote.ok ? remote.stdout.trim() : null);
  const remotes = parseGitRemotes(remoteList.ok ? remoteList.stdout : '');
  const githubRepositories = [...new Set([
    parseGitHubRepository(remoteUrl),
    ...remotes.map((item) => parseGitHubRepository(item.url))
  ].filter(Boolean))];
  const configuredRepository = options.repositoryOverride || config.github?.repositories?.[0] || githubRepositories[0];
  const githubEnabled = config.github?.enabled !== false;
  const githubConfigured = githubEnabled && Boolean(configuredRepository);
  const expectedGithubAccount = options.expectedGithubAccount || config.github?.account || null;
  let githubAuthConnected = false;
  let activeGithubAccount = null;
  let githubAuthAccounts = [];
  let ghAvailable = null;

  // Do not even invoke gh unless this is a Git repository with GitHub configured.
  if (githubConfigured && options.checkGitHubAuth !== false) {
    const authKey = `github.com\0${repoRoot}\0${expectedGithubAccount ?? ''}`;
    const cached = options.run === undefined && options.authCache !== false ? githubAuthCache.get(authKey) : null;
    if (cached && Date.now() - cached.checkedAt < Number(options.authCacheTtlMs ?? 15_000)) {
      githubAuthConnected = cached.connected;
      activeGithubAccount = cached.account;
      githubAuthAccounts = cached.accounts ?? [];
      ghAvailable = cached.ghAvailable ?? true;
    } else {
      const auth = await tryRun(run, 'gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], repoRoot);
      ghAvailable = auth.ok || auth.error?.code !== 'ENOENT';
      activeGithubAccount = activeAccountFromStatus(auth.stdout);
      githubAuthAccounts = accountsFromStatus(auth.stdout);
      githubAuthConnected = Boolean(activeGithubAccount) && (!expectedGithubAccount || sameAccount(activeGithubAccount, expectedGithubAccount));
      if (options.run === undefined && options.authCache !== false) {
        githubAuthCache.set(authKey, {
          connected: githubAuthConnected,
          account: activeGithubAccount,
          accounts: githubAuthAccounts,
          ghAvailable,
          checkedAt: Date.now()
        });
      }
    }
  }

  const syncReason = !githubEnabled
    ? 'github-disabled'
    : !githubConfigured
      ? 'github-not-configured'
      : ghAvailable === false
        ? 'gh-not-installed'
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
  const projectId = `worktree:${createHash('sha256')
    .update(`${repoRoot.toLowerCase()}\0${resolvedGitDir.toLowerCase()}`)
    .digest('hex')}`;

  return {
    ...base,
    projectId,
    projectKind: githubConfigured ? 'github' : 'git',
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
    remotes,
    githubRepositories,
    githubRepository: configuredRepository ?? null,
    ghAvailable,
    githubAuthAccounts,
    githubConfigured,
    githubAuthConnected,
    activeGithubAccount,
    expectedGithubAccount,
    syncGitHub: syncReason === 'ready',
    syncReason,
    capabilities: githubConfigured
      ? ['repository-todos', 'git-status', 'github-projects', 'issues', 'pull-requests', 'actions']
      : ['repository-todos', 'git-status'],
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

export function accountsFromStatus(output) {
  try {
    const status = JSON.parse(output);
    return [...new Set((status.hosts?.['github.com'] ?? [])
      .filter((account) => account.state === 'success')
      .map((account) => account.login)
      .filter(Boolean))];
  } catch {
    return [];
  }
}

export function parseGitRemotes(output) {
  const seen = new Set();
  const remotes = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match || match[3] !== 'fetch') continue;
    const key = `${match[1]}\0${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    remotes.push({ name: match[1], url: sanitizeRemoteUrl(match[2]) });
  }
  return remotes;
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
