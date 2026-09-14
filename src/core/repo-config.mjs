import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export async function readRepoConfig(repoRoot) {
  try {
    return JSON.parse(await readFile(join(repoRoot, '.localboard', 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

export async function githubContext(repoRoot, options = {}) {
  const config = await readRepoConfig(repoRoot);
  const configured = config.github?.repositories?.[0];
  const nameWithOwner = options.repository || configured || await inferGitHubRepository(repoRoot);
  if (!nameWithOwner?.includes('/')) throw new Error('GitHub repository is not configured; pass --repository owner/name');
  const [owner, repo] = nameWithOwner.split('/');
  return {
    owner,
    repo,
    ownerType: options.ownerType || config.github?.ownerType || 'user',
    projectOwner: options.owner || config.github?.owner || owner,
    projectNumber: Number(options.projectNumber || config.github?.projectNumber || 0),
    config
  };
}

async function inferGitHubRepository(repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], { cwd: repoRoot, windowsHide: true });
    const url = stdout.trim().replace(/\.git$/, '');
    const match = url.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

