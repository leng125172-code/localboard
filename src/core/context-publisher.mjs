import { createHash, randomUUID } from 'node:crypto';
import { brokerRequest } from './broker-client.mjs';
import { inspectRepositoryContext } from './repository-context.mjs';

export async function publishExecutionContext(input = {}, options = {}) {
  const request = options.brokerRequest ?? brokerRequest;
  const env = options.env ?? process.env;
  const repository = await inspectRepositoryContext(input.cwd ?? process.cwd(), options.repositoryOptions);
  const sessionId = input.sessionId ?? env.CODEX_SESSION_ID ?? env.CODEX_THREAD_ID ?? null;
  const agentId = input.agentId ?? null;
  const contextKey = input.contextKey || (sessionId
    ? `codex:${sessionId}:${agentId ?? 'main'}`
    : `manual:${randomUUID()}`);
  const value = {
    contextKey,
    sessionId,
    agentId,
    source: input.source ?? 'skill',
    status: input.status ?? 'active',
    eventName: input.eventName ?? null,
    model: input.model ?? null,
    repository
  };
  return request('/v1/contexts', { method: 'POST', body: value, timeoutMs: 3500 });
}

export async function publishCodexHook(payload, options = {}) {
  const request = options.brokerRequest ?? brokerRequest;
  const eventKey = createHash('sha256').update(JSON.stringify([
    payload.session_id, payload.turn_id, payload.agent_id, payload.hook_event_name, payload.reason
  ])).digest('hex');
  const status = hookStatus(payload.hook_event_name);
  const [event, context] = await Promise.all([
    request('/v1/events', { method: 'POST', body: { eventKey, payload }, timeoutMs: 3500 }),
    publishExecutionContext({
      cwd: payload.cwd,
      sessionId: payload.session_id,
      agentId: payload.agent_id,
      source: 'codex-hook',
      status,
      eventName: payload.hook_event_name,
      model: payload.model
    }, options)
  ]);
  return { event, context };
}

function hookStatus(eventName) {
  if (eventName === 'SessionEnd') return 'ended';
  if (eventName === 'Interrupt') return 'interrupted';
  if (eventName === 'Stop' || eventName === 'SubagentStop') return 'idle';
  return 'active';
}
