---
description: Fast path: solve quickly with minimal exploration and subagent usage
---
Treat this as a rush task: optimize for speed and low overhead.

Policy:
- Start with the simplest direct path.
- Minimize file reads and tool calls.
- Avoid broad exploration.
- Do not use subagents unless they are clearly necessary.
- Prefer a quick practical answer or minimal patch over a comprehensive analysis.
- If uncertainty becomes significant, say what is uncertain instead of over-investigating.

Subagent guidance:
- Use `search` only if you need to locate code quickly.
- Avoid `librarian`, `oracle`, and `reviewer` unless the task is blocked or unusually risky.

Output guidance:
- Be concise.
- Return the result, the key files touched or inspected, and any important caveat.
