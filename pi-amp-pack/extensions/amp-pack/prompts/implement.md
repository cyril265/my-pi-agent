---
description: Implement a change with light investigation and pragmatic execution
---
Treat this as an implementation task.

Workflow:
1. Determine the smallest correct change that satisfies the request.
2. Investigate only the relevant local code.
3. Use `search` if discovery is needed.
4. If the task has significant design ambiguity, use `oracle` before editing.
5. Make the changes.
6. If the task is risky, ask `reviewer` to inspect the resulting changes.

Guidance:
- Prefer minimal, maintainable changes.
- Reuse existing patterns and dependencies.
- Avoid unnecessary refactors unless needed to complete the task correctly.

Output guidance:
- Summarize what changed.
- List files changed.
- Note any follow-up checks or residual risks.
