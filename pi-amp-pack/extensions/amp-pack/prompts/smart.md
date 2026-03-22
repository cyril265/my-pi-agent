---
description: Balanced default workflow: investigate enough, then act
---
Treat this as a smart task: optimize for balanced quality, speed, and context use.

Workflow:
1. Clarify the immediate goal from the user request.
2. Inspect the local code just enough to understand the relevant area.
3. If code discovery is needed, use `search` first.
4. Implement, explain, or answer directly once you have enough context.
5. Use a specialist subagent only when it clearly improves the result.

Subagent guidance:
- Prefer `search` for local discovery.
- Use `reviewer` for review-oriented tasks.
- Use `oracle` only for complex tradeoffs, architecture, or non-obvious bugs.
- Use `librarian` only for broad or deep code-understanding tasks.

Output guidance:
- Be clear and practical.
- Avoid over-research.
- Return the best complete answer once you have enough evidence.
