import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readRepoConfig } from './config-file.mjs';

const execFileAsync = promisify(execFile);

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
    tryRun(run, 'git', ['branch', '--show-current'], repoRoot),
    tryRun(run, 'git', ['rev-parse', 'HEAD'], repoRoot),
    tryRun(run, 'git', ['status', '--porcelain', '--untracked-files=no'], repoRoot),
    tryRun(run, 'git', ['config', '--get', 'remote.origin.url'], repoRoot)
  ]);
  const [common, branch, head, status, remote] = results;
  const remoteUrl = sanitizeRemoteUrl(remote.ok ? remote.stdout.trim() : null);
  const configuredRepository = options.repositoryOverride || config.github?.repositories?.[0] || parseGitHubRepository(remoteUrl);
  const githubEnabled = config.github?.enabled !== false;
  const githubConfigured = githubEnabled && Boolean(configuredRepository);
  let githubAuthConnected = false;

  // Do not even invoke gh unless this is a Git repository with GitHub configured.
  if (githubConfigured && options.checkGitHubAuth !== false) {
    githubAuthConnected = (await tryRun(run, 'gh', ['auth', 'status', '--active', '--hostname', 'github.com'], repoRoot)).ok;
  }

  const syncReason = !githubEnabled
    ? 'github-disabled'
    : !githubConfigured
      ? 'github-not-configured'
      : !githubAuthConnected
        ? 'github-not-authenticated'
        : 'ready';
  const commonDir = common.ok ? common.stdout.trim() : '.git';
  const repositoryKey = createHash('sha256')
    .update(`${repoRoot}\0${commonDir}\0${configuredRepository ?? remoteUrl ?? ''}`)
    .digest('hex');

  return {
    ...base,
    isGitRepository: true,
    repoRoot,
    repositoryKey,
    repositoryName: repoRoot.split(/[\\/]/).at(-1),
    gitCommonDir: commonDir,
    branch: branch.ok ? branch.stdout.trim() || '(detached)' : '(unknown)',
    headSha: head.ok ? head.stdout.trim() : null,
    workingTreeDirty: status.ok && Boolean(status.stdout.trim()),
    changedFileCount: status.ok ? status.stdout.split(/\r?\n/).filter(Boolean).length : null,
    remoteUrl,
    githubRepository: configuredRepository ?? null,
    githubConfigured,
    githubAuthConnected,
    syncGitHub: syncReason === 'ready',
    syncReason,
    github: config.github ?? null
  };
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

