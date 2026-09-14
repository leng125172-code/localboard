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
  if (endpoint && await isHealthy(endpoint)) return endpoint;

  const daemonPath = fileURLToPath(new URL('../daemon.mjs', import.meta.url));
  const executable = process.env.LOCALBOARD_NODE || (process.versions.electron ? 'node' : process.execPath);
  const child = spawn(executable, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(60);
    endpoint = await readEndpoint();
    if (endpoint && await isHealthy(endpoint)) return endpoint;
  }
  throw new Error('LocalBoard broker did not start');
}

async function isHealthy(endpoint) {
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(400)
    });
    return response.ok;
  } catch {
    return false;
  }
}

