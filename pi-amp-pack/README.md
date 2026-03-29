# pi-amp-pack

Amp-inspired subagents and workflow prompts for pi.

## Includes

- Subagent extension with thinking overrides, `inherit`, and provider-aware model selection
- Injected routing guidance from extension context
- Auto-synced packaged agents into `~/.pi/agent/agents`
- Workflow prompts like `/rush`, `/smart`, `/deep`

## Install

```bash
pi install /absolute/path/to/pi-amp-pack
```

Then run:

```text
/reload
```

## Agents

This package ships a small set of bundled agents that are synced into `~/.pi/agent/agents`.

- `coder` — fast worker for clearly scoped local code changes, fixes, refactors, and tests
- `search` — quick codebase search agent for finding relevant files and line ranges
- `librarian` — deep codebase understanding agent for architecture, flow tracing, and subsystem relationships
- `oracle` — stronger second-opinion agent for planning, reviews, difficult bugs, and technical trade-offs
- `reviewer` — diff-focused code review agent for file-by-file change analysis
- `code-tour` — guided walkthrough agent for explaining a diff in a useful reading order

The bundled routing guidance also pushes usage toward the smallest sufficient workflow: work directly for small local tasks, use `search` for discovery, and delegate to specialist agents only when it materially helps.

Bundled subagents prefer the active session's provider when that provider exposes the configured model ID, then fall back to the agent's explicit `fallbackModel`.

## Subagent Shape

The `subagent` tool accepts:

- `steps`: array of `{ agent, task, thinking?, cwd? }`
- `agent`: either a saved agent name or an inline generic agent object with `systemPrompt` and optional `tools`, `model`, `thinking`, and `name`
- `sequential`: optional boolean to run 2+ steps as a chain with `{previous}` placeholders
- `cwd`: optional default working directory for all steps
- `runTitle`: optional tracking title for the parent run item

## Subagent Todo Tracking

Todo tracking is always attempted on the `subagent` tool.

The extension creates one run item and one task item per delegated subagent task/step, updates status during execution, and closes successful items using the bundled `sq-node` library when queue setup succeeds. The queue is resolved once per tool invocation from the top-level `cwd` when provided, otherwise from the shared resolved step `cwd` when all steps agree, else from the current working directory.

## Third-party Notices

This package includes a bundled TypeScript adaptation of portions of the `sq` project by Derek Stride.

- Original project license: MIT
- Bundled notice: `sq-node/LICENSE.md`
- Additional attribution: `THIRD_PARTY_NOTICES.md`
