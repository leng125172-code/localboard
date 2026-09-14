export class IssuesApi {
  constructor(client) {
    this.client = client;
  }

  async list(owner, repo, state = 'open') {
    const items = await this.client.rest('GET', `repos/${owner}/${repo}/issues`, { state, per_page: 100 });
    return items.filter((item) => !item.pull_request);
  }

  async create({ owner, repo, title, body = '', labels = [], assignees = [], idempotencyKey }) {
    const marker = idempotencyKey ? `<!-- localboard:${idempotencyKey} -->` : '';
    if (marker) {
      const existing = await this.client.rest('GET', 'search/issues', {
        q: `repo:${owner}/${repo} in:body "${marker}"`, per_page: 1
      });
      if (existing.items?.[0]) return { ...existing.items[0], replayed: true };
    }
    return this.client.rest('POST', `repos/${owner}/${repo}/issues`, {
      title,
      body: `${body}${body && marker ? '\n\n' : ''}${marker}`,
      labels,
      assignees
    });
  }

  update({ owner, repo, number, ...fields }) {
    return this.client.rest('PATCH', `repos/${owner}/${repo}/issues/${number}`, fields);
  }

  close({ owner, repo, number, reason = 'completed' }) {
    return this.update({ owner, repo, number, state: 'closed', state_reason: reason });
  }
}
