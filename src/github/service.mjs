import { createHash, randomUUID } from 'node:crypto';
import { GhClient } from './client.mjs';
import { ProjectsApi } from './projects.mjs';
import { IssuesApi } from './issues.mjs';
import { PullsApi } from './pulls.mjs';
import { ActionsApi } from './actions.mjs';

const READ_ACTIONS = new Set(['project.get', 'project.items', 'issue.list', 'pr.list', 'pr.get', 'actions.runs']);

export class GitHubService {
  constructor(state, client = new GhClient()) {
    this.state = state;
    this.projects = new ProjectsApi(client);
    this.issues = new IssuesApi(client);
    this.pulls = new PullsApi(client);
    this.actions = new ActionsApi(client);
  }

  async execute(request) {
    if (READ_ACTIONS.has(request.action)) {
      const { refresh: _refresh, cacheTtlSeconds: _cacheTtlSeconds, ...cacheRequest } = request;
      const key = `read:${createHash('sha256').update(stableJson(cacheRequest)).digest('hex')}`;
      const cached = request.refresh === true ? null : this.state.getGitHubCache(key, request.cacheTtlSeconds ?? 30);
      if (cached !== null) return cached;
      const result = await this.dispatch(request);
      this.state.putGitHubCache(key, result);
      return result;
    }
    const key = request.idempotencyKey || randomUUID();
    const cached = this.state.getIdempotent(key);
    if (cached) return { ...cached, replayed: true };

    if ((request.action === 'actions.rerun' || request.action === 'actions.cancel' || request.action === 'pr.merge') && request.allowWrite !== true) {
      throw new Error(`${request.action} requires allowWrite=true`);
    }
    const outbox = this.state.enqueue(request.action, request, key);
    try {
      const result = await this.dispatch({ ...request, idempotencyKey: key });
      this.state.markOutbox(outbox.id, 'done');
      this.state.putIdempotent(key, result);
      this.state.clearGitHubCache();
      return result;
    } catch (error) {
      this.state.markOutbox(outbox.id, 'failed', error.message);
      throw error;
    }
  }

  async dispatch(request) {
    switch (request.action) {
      case 'project.get': return this.projects.getProject(request.ownerType, request.owner, request.projectNumber);
      case 'project.items': return this.projects.listItems(request.projectId);
      case 'project.setField': return this.projects.setField(request);
      case 'project.clearField': return this.projects.clearField(request);
      case 'project.updateDraft': return this.projects.updateDraft(request);
      case 'issue.list': return this.issues.list(request.owner, request.repo, request.state);
      case 'issue.create': return this.issues.create(request);
      case 'issue.update': return this.issues.update(request);
      case 'issue.close': return this.issues.close(request);
      case 'pr.list': return this.pulls.list(request.owner, request.repo, request.state);
      case 'pr.get': return this.pulls.get(request.owner, request.repo, request.number);
      case 'pr.merge': return this.pulls.merge(request);
      case 'actions.runs': return this.actions.runs(request.owner, request.repo, request);
      case 'actions.rerun': return this.actions.rerun(request);
      case 'actions.cancel': return this.actions.cancel(request);
      default: throw new Error(`Unknown GitHub action: ${request.action}`);
    }
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
