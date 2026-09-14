#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { brokerRequest } from '../core/broker-client.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const eventKey = createHash('sha256').update(JSON.stringify([
    payload.session_id, payload.turn_id, payload.agent_id, payload.hook_event_name, payload.reason
  ])).digest('hex');
  await brokerRequest('/v1/events', {
    method: 'POST', body: { eventKey, payload }, timeoutMs: 2500
  });
} catch {
  // Telemetry is best-effort and must never block Codex work.
}

process.stdout.write('{}\n');

