---
name: localboard
description: Report the current agent execution to LocalBoard and manage global or Git-repository personal todos. Use when the user asks to record, update, finish, remove, or inspect LocalBoard work.
---

# LocalBoard

At the beginning of LocalBoard work, call `localboard_report_context` with the exact Codex session launch directory. Never replace it with a nested repository or temporary directory used by an individual command. Update the same execution with `waiting` or `ended` when appropriate.

Use the MCP todo tools instead of editing `.localboard/todos.json` directly:

- With `scope: auto`, a path inside an initialized Git worktree uses that worktree's repository todo file.
- With `scope: auto`, a non-Git path uses global todos in LocalBoard's per-user application data.
- Use `scope: global` only when the user explicitly wants a cross-project todo.
- Do not initialize Git or add a GitHub remote implicitly.

GitHub operations are not exposed as automatic MCP mutations. Use LocalBoard's dashboard for writes that require confirmation, such as merging a pull request or rerunning/cancelling an Actions run.
