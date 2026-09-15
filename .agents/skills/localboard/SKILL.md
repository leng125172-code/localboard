---
name: localboard
description: Manage LocalBoard personal todos and, only when the current path is an initialized Git repository with authenticated GitHub configuration, synchronized Project, Issue, PR, and Actions work. Use when asked to record, update, finish, or inspect LocalBoard work or publish the current Codex repository context to its desktop sticky.
---

# LocalBoard

At the start of LocalBoard work, run `localboard context publish --source skill`. The CLI uses `CODEX_SESSION_ID` or `CODEX_THREAD_ID` when available, so repeated publications update only this session's entry in the single desktop activity sticky; it must not edit the shared memo or another Codex session's entry. Do not pass another session's `--context-key`.

Use `localboard context inspect --json` before any GitHub operation:

- If `isGitRepository` is false, do not initialize Git implicitly and do not query or mutate GitHub.
- If `githubConfigured` or `githubAuthConnected` is false, skip all GitHub synchronization. Local repository todos may still be used when Git is initialized.
- Only when `syncGitHub` is true may Project, Issue, PR, or Actions commands run.

Use the CLI instead of editing `.localboard/todos.json` directly:

- Personal work: `localboard todo add "title"`, `localboard todo update <id> --title "..."`, or `localboard todo done <id>`.
- GitHub Project work: `localboard project set-field <item-id> <field-id> <text|date|single-select> <value>`.
- Issues: `localboard issue create "title" [--body "..."]` and `localboard issue close <number>`.
- Read PR and Actions state with `localboard pr list` and `localboard actions runs`.

GitHub mutations require user authorization for that specific effect. Reuse `--idempotency-key` when retrying one logical mutation. Do not retry persistent authentication, permission, conflict, or validation failures indefinitely; inspect `localboard outbox` and report the failure.
