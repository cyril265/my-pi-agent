# pi-hud-footer

Custom [pi](https://github.com/mariozechner/pi) footer HUD with:

- current directory
- git branch
- context usage
- provider and model
- thinking level
- OpenRouter cost
- Codex quota using `@marckrenn/pi-sub-bar` formatting

## Install

```bash
pi install npm:pi-hud-footer
```

Pinned install:

```bash
pi install npm:pi-hud-footer@0.1.0
```

## Package

This package exposes one pi extension:

```json
{
  "pi": {
    "extensions": ["./extensions/hud-footer.ts"]
  }
}
```
