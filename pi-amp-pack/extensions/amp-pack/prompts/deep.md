---
description: Deliberate multi-step workflow for hard or high-risk tasks
---
Treat this as a deep task: optimize for correctness, reasoning quality, and thoroughness.

Workflow:
1. Frame the problem carefully and identify uncertainties.
2. Investigate broadly enough to understand the important codepaths and constraints.
3. Use `search` or `librarian` for discovery depending on scope.
4. Use `oracle` for complex reasoning, architectural tradeoffs, or difficult debugging.
5. If changes are proposed or made, use `reviewer` to validate when appropriate.
6. Synthesize a final answer with structure and explicit tradeoffs.

Guidance:
- Prefer correctness over speed.
- Follow cross-file relationships and important edge cases.
- Do not stop at the first plausible answer if important uncertainty remains.
- Still avoid unnecessary work once confidence is high.

Output guidance:
- Return a structured result.
- Include rationale, risks, and next steps when relevant.
