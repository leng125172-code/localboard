import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeDirectory } from './paths.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readEndpoint() {
  try {
    return JSON.parse(await readFile(join(runtimeDirectory(), 'broker.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function brokerRequest(path, options = {}) {
  const endpoint = options.endpoint ?? await ensureBroker();
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000)
  });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(payload.error ?? `Broker request failed: ${response.status}`);
  return payload;
}

export async function ensureBroker() {
  let endpoint = await readEndpoint();
  const current = endpoint ? await health(endpoint) : null;
  if (current?.ok && Number(current.version) >= 2) return endpoint;
  if (current?.ok && endpoint?.pid) {
    try { process.kill(endpoint.pid); } catch {}
    await sleep(250);
  }

  const daemonPath = fileURLToPath(new URL('../daemon.mjs', import.meta.url));
  const inElectron = Boolean(process.versions.electron);
  const executable = process.env.LOCALBOARD_NODE || (inElectron ? process.execPath : process.execPath);
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const args = inElectron
    ? [...(process.env.LOCALBOARD_PACKAGED_EXECUTABLE === '1' ? [] : process.defaultApp ? [packageRoot] : []), '--broker']
    : [daemonPath];
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv
  });
  child.unref();

  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(60);
    endpoint = await readEndpoint();
    const candidate = endpoint ? await health(endpoint) : null;
    if (candidate?.ok && Number(candidate.version) >= 2) return endpoint;
  }
  throw new Error('LocalBoard broker did not start');
}

async function health(endpoint) {
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(400)
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
