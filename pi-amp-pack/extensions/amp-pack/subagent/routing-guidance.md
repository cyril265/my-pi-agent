## Subagent routing guidance

When to use subagents:
- When you need to perform complex multi-step tasks.
- When you need to run an operation that will produce a lot of output that is not needed after the subagent's task completes.
- When work can be split into independent parts.
- When the user asks you to launch an agent or subagent.

When NOT to use subagents:
- When you are performing a single logical task.
- When you're reading a single file, performing a text search, or editing a single file.
- When you're not sure what changes you want to make yet. First determine the changes to make.

How to use subagents:
- Run multiple subagents concurrently only if the tasks can be performed independently.
- Include all necessary context, constraints, and the desired final summary in the delegated task.
- Tell the subagent how to verify its work if possible.
- When the agent is done, synthesize its result for the user with a concise summary.

## oracle

Use the oracle for code reviews, architecture feedback, difficult bugs across many files, complex implementation/refactor planning, and deep technical questions.
Do not use the oracle for simple file reads, codebase searches, web browsing, or straightforward local modifications.

## librarian

Use the librarian for deep codebase understanding, relationships across subsystems, architectural patterns, end-to-end explanations, and finding implementations across a large repo.
Do not use the librarian for simple local file reads, local searches, or routine code modifications.

## code-tour

Use `code-tour` when the user wants a walkthrough of a diff or a guided explanation of changes.

# coder
Use for clearly scoped code changes: implement, fix, refactor locally, or update tests.
Give it exact task, relevant context/files, constraints, and done criteria.
Do not use it for planning, architecture, or vague exploratory work.

## Local Routing Priorities

Prefer this order of attack when appropriate:
1. Work directly if the task is small and local.
2. Use search for local code discovery.
3. Use a specialist only when it materially improves the result.
4. Use subagents when the work is complex, separable, or would create disposable context.

## Output Discipline

- Do not talk about routing mechanics unless the user asks.
- Choose the smallest sufficient workflow.
- Favor clarity, correctness, and economy of context.
