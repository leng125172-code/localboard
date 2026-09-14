import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withDirectoryLock(targetFile, work, options = {}) {
  const lockPath = options.lockPath ?? join(dirname(targetFile), '.write-lock');
  const timeoutMs = options.timeoutMs ?? 4000;
  const staleMs = options.staleMs ?? 30_000;
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();

  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await isStale(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for lock: ${lockPath}`);
      await pause(20 + Math.floor(Math.random() * 30));
    }
  }

  try {
    return await work();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function isStale(lockPath, staleMs) {
  try {
    const info = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
    if (info.pid && isProcessAlive(info.pid)) return false;
  } catch {
    // A creator may not have written owner.json yet; mtime protects that short window.
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

