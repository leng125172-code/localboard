export class PullsApi {
  constructor(client) {
    this.client = client;
  }

  list(owner, repo, state = 'open') {
    return this.client.rest('GET', `repos/${owner}/${repo}/pulls`, { state, per_page: 100 });
  }

  get(owner, repo, number) {
    return this.client.rest('GET', `repos/${owner}/${repo}/pulls/${number}`);
  }

  merge({ owner, repo, number, method = 'squash', title, message }) {
    return this.client.rest('PUT', `repos/${owner}/${repo}/pulls/${number}/merge`, {
      merge_method: method, commit_title: title, commit_message: message
    });
  }
}

