# LocalBoard repository guidance

- Use `npm test` after changing broker, storage, sync, or CLI behavior.
- Treat `.localboard/todos.json` as user data. Update it through `node src/cli.mjs todo ...`, never by ad-hoc rewriting.
- Never store GitHub tokens in this repository. GitHub access goes through the authenticated `gh` CLI.
- External GitHub mutations require explicit user intent. Read-only Project, Issue, PR, and Actions queries are safe diagnostics.
- Every retryable mutation must accept an idempotency key. The broker is the single writer; desktop windows, hooks, and agents are clients.

