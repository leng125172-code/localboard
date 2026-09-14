---
name: localboard
description: Manage repository-local personal todos and synchronized GitHub Project, Issue, PR, and Actions work through the LocalBoard CLI. Use when a task asks to record, update, finish, or inspect LocalBoard work items.
---

# LocalBoard

Use `localboard` commands instead of editing `.localboard/todos.json` directly. The CLI serializes concurrent Codex and agent writes through the local broker and adds idempotency metadata.

- Personal work: `localboard todo add "title"`, `localboard todo update <id> --title "..."`, or `localboard todo done <id>`.
- GitHub Project work: `localboard project set-field <item-id> <field-id> <text|date|single-select> <value>`.
- Issues: `localboard issue create "title" [--body "..."]` and `localboard issue close <number>`.
- Read PR and Actions state with `localboard pr list` and `localboard actions runs`.

Mutating GitHub commands have external effects. Run them only when the user's request authorizes the change. Do not put credentials in repository files; LocalBoard reuses `gh` authentication.

When several agents work at once, pass `--idempotency-key` when retrying the same logical mutation. Do not retry a failed external mutation indefinitely; inspect `localboard outbox list` and report persistent authentication, permission, or conflict errors.
