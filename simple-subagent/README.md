# simple-subagent

Tiny pi extension. Adds two tools:

- `runSubAgent(thinking, prompt, cwd)`
- `runSubAgents({ agents: [{ name, thinking, prompt, cwd }] })` writes results to `.subagents/<timestamp>/<name>-result.md`

## Install

```bash
pi install /absolute/path/to/simple-subagent
```

Then reload:

```text
/reload
```

## Tool

- uses caller model
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`
- `prompt`: prompt sent to child pi process
- `cwd`: working directory for child pi run

Tool runs separate `pi` process in JSON mode with `--no-session`.

`/runSubAgent` opens split in `cmux`, `tmux`, or Warp, depending on current session.

Warp support uses AppleScript: it opens a right split with `Cmd-D`, pastes the command, and presses Enter. macOS may ask for Accessibility permission for the terminal app running `pi`.
