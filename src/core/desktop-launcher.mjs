import { spawn as nodeSpawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const defaultPackageRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function launchDesktop({
  cwd = process.cwd(),
  foreground = false,
  electronPath,
  packageRoot = defaultPackageRoot,
  spawnImpl = nodeSpawn
} = {}) {
  const launchCwd = resolve(cwd);
  const info = await stat(launchCwd).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`Startup path does not exist: ${launchCwd}`);
    throw error;
  });
  if (!info.isDirectory()) throw new Error(`Startup path is not a directory: ${launchCwd}`);

  const executable = electronPath || require('electron');
  const child = spawnImpl(executable, [resolve(packageRoot)], {
    cwd: launchCwd,
    detached: !foreground,
    stdio: foreground ? 'inherit' : 'ignore',
    windowsHide: true
  });

  if (foreground) {
    const { code, signal } = await waitForExit(child);
    if (code !== 0) throw new Error(`LocalBoard exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
    return { launched: true, mode: 'foreground', cwd: launchCwd, code };
  }

  await waitForSpawn(child);
  child.unref();
  return { launched: true, mode: 'background', cwd: launchCwd, pid: child.pid };
}

function waitForSpawn(child) {
  return new Promise((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn);
    child.once('error', reject);
  });
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
}
