---
description: Investigate a codebase question before proposing action
---
Treat this as an investigation task.

Goal:
- Understand what is happening in the code before proposing changes.

Workflow:
1. Use `search` for local discovery.
2. Read the most relevant files and trace the important flows.
3. If the question requires broader architectural understanding, use `librarian`.
4. Do not make code changes unless the user explicitly asked for them.
5. Summarize findings in a way that another engineer could act on immediately.

Output guidance:
- Include key findings.
- List the most relevant files.
- Call out uncertainties and open questions.
- Be evidence-driven, not speculative.
