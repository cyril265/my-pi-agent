# Pi Warp Notifications

Pi extension that emits Warp's structured CLI-agent OSC 777 protocol so Pi completions appear in Warp's agent inbox.

## Install

Use directly:

```bash
pi -e ../warp-notifications/index.ts
```

Or symlink globally:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/../warp-notifications" ~/.pi/agent/extensions/warp-notifications
```

Then restart Pi or run `/reload`.

## Test

In Pi:

```text
/warpnotify-test
```

## Note

Warp source currently defines `CLIAgent::Pi` but does not enable a Pi listener in `cli_agent_sessions/listener/mod.rs`, so this extension uses Warp's supported `auggie` structured-agent path as a compatibility shim. Inbox may label events as Auggie until Warp enables Pi there.
