#!/usr/bin/env node
import { publishCodexHook } from '../core/context-publisher.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  await publishCodexHook(payload);
} catch {
  // Telemetry is best-effort and must never block Codex work.
}

process.stdout.write('{}\n');
