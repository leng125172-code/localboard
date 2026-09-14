# Security

Do not include access tokens, cookies, hook transcripts, or private note data in bug reports.

LocalBoard delegates GitHub authentication to `gh`. Use the smallest required scopes and prefer a GitHub App for organization-wide deployment. The local broker listens only on loopback and authenticates every request with a random endpoint token.

Report suspected vulnerabilities privately to the repository owner. Do not open a public Issue before credentials or exploit details have been removed.
