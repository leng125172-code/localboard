import { readRepoConfig } from './config-file.mjs';
import { inspectRepositoryContext } from './repository-context.mjs';

export { readRepoConfig } from './config-file.mjs';

export async function githubContext(repoRoot, options = {}) {
  const config = await readRepoConfig(repoRoot);
  const repository = await inspectRepositoryContext(repoRoot, {
    config,
    repositoryOverride: options.repository,
    checkGitHubAuth: options.requireAuth !== false
  });
  if (!repository.isGitRepository) throw new Error('GitHub sync skipped: current path is not an initialized Git repository');
  if (!repository.githubConfigured) throw new Error('GitHub sync skipped: no GitHub remote or LocalBoard GitHub configuration');
  if (options.requireAuth !== false && !repository.githubAuthConnected) {
    throw new Error('GitHub sync skipped: gh is not authenticated; run gh auth login');
  }
  const nameWithOwner = repository.githubRepository;
  const [owner, repo] = nameWithOwner.split('/');
  return {
    owner,
    repo,
    ownerType: options.ownerType || config.github?.ownerType || 'user',
    projectOwner: options.owner || config.github?.owner || owner,
    projectNumber: Number(options.projectNumber || config.github?.projectNumber || 0),
    config,
    repository
  };
}
