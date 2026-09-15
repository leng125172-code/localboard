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
    registerProject: input.registerProject !== false,
    repository
  };
  return request('/v1/contexts', { method: 'POST', body: value, timeoutMs: 3500 });
}

export async function publishCodexHook(payload, options = {}) {
  payload = normalizeCodexHookPayload(payload);
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
      model: payload.model,
      // Turn-level tools can run from temporary directories. Only the session
      // launch directory belongs in the project switcher.
      registerProject: payload.hook_event_name === 'SessionStart'
    }, options)
  ]);
  return { event, context };
}

export function normalizeCodexHookPayload(payload = {}) {
  const hookEvent = payload.hook_event && typeof payload.hook_event === 'object' ? payload.hook_event : {};
  return {
    ...payload,
    hook_event_name: firstDefined(payload.hook_event_name, hookEvent.hook_event_name, hookEvent.event_name, hookEvent.name),
    cwd: firstDefined(payload.cwd, hookEvent.cwd),
    session_id: firstDefined(payload.session_id, payload.sessionId, hookEvent.session_id, hookEvent.sessionId,
      payload.thread_id, payload.threadId, hookEvent.thread_id, hookEvent.threadId),
    turn_id: firstDefined(payload.turn_id, payload.turnId, hookEvent.turn_id, hookEvent.turnId),
    agent_id: firstDefined(payload.agent_id, payload.agentId, hookEvent.agent_id, hookEvent.agentId),
    model: firstDefined(payload.model, hookEvent.model),
    reason: firstDefined(payload.reason, hookEvent.reason)
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function hookStatus(eventName) {
  if (eventName === 'SessionEnd') return 'ended';
  if (eventName === 'Interrupt') return 'interrupted';
  if (eventName === 'Stop' || eventName === 'SubagentStop') return 'idle';
  return 'active';
}
