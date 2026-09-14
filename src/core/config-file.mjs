import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readRepoConfig(repoRoot) {
  try {
    return JSON.parse(await readFile(join(repoRoot, '.localboard', 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

