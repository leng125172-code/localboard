export class ActionsApi {
  constructor(client) {
    this.client = client;
  }

  runs(owner, repo, options = {}) {
    return this.client.restPaginated(`repos/${owner}/${repo}/actions/runs`, {
      per_page: options.perPage ?? 30,
      branch: options.branch,
      status: options.status,
      event: options.event
    }, { listKey: 'workflow_runs' });
  }

  rerun({ owner, repo, runId, failedOnly = false }) {
    const suffix = failedOnly ? '/rerun-failed-jobs' : '/rerun';
    return this.client.rest('POST', `repos/${owner}/${repo}/actions/runs/${runId}${suffix}`);
  }

  cancel({ owner, repo, runId }) {
    return this.client.rest('POST', `repos/${owner}/${repo}/actions/runs/${runId}/cancel`);
  }
}
