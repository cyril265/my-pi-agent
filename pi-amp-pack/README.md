# pi-amp-pack

Amp-inspired subagents and workflow prompts for pi.

## Includes

- Subagent extension with thinking overrides and `inherit`
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

## Subagent API

Preferred shape:

```ts
{
  mode?: "single" | "parallel" | "chain",
  items: [
    {
      agent: "coder" | {
        type?: "generic",
        name?: string,
        systemPrompt: string,
        tools?: string[],
        model?: string,
        thinking?: "low" | "medium" | "high" | "xhigh" | "inherit"
      },
      task: string,
      thinking?: "low" | "medium" | "high" | "xhigh" | "inherit",
      cwd?: string
    }
  ],
  thinking?: "low" | "medium" | "high" | "xhigh" | "inherit",
  todo?: { enabled?: boolean, queuePath?: string, runTitle?: string },
  cwd?: string
}
```

Notes:
- `mode` defaults to `single` for one item and `parallel` for multiple items
- `single` mode requires exactly one item
- `parallel` and `chain` mode require at least two items
- `chain` mode runs sequentially and replaces `{previous}` in later tasks
- `agent` can be a saved agent name or an inline generic agent configured entirely by the caller

## Subagent Todo Tracking

Todo tracking is enabled by default on the `subagent` tool.

- `todo.enabled`: set to `false` to disable tracking for the current subagent invocation
- `todo.queuePath`: optional queue path override (defaults to nearest `.sift/issues.jsonl`)
- `todo.runTitle`: optional title for the parent run item

When enabled, the extension creates one run item and one task item per delegated subagent task/step, updates status during execution, and closes successful items using the bundled `sq-node` library.

## Third-party Notices

This package includes a bundled TypeScript adaptation of portions of the `sq` project by Derek Stride.

- Original project license: MIT
- Bundled notice: `sq-node/LICENSE.md`
- Additional attribution: `THIRD_PARTY_NOTICES.md`
