# pi-thinking-footer

A tiny pi package that shows the current thinking level in a `belowEditor` widget.

## Install

From this directory:

```bash
pi install .
```

Or from somewhere else:

```bash
pi install /Users/kpovolotskyy/ai-stuff/my-pi-agent/thinking-level
```

Then restart pi or run:

```bash
/reload
```

## What it shows

- `thinking: <level>` below the editor
- built-in header and footer stay intact
- no custom footer replacement
- no timer or polling

## Notes

This package uses `ctx.ui.setWidget(..., { placement: "belowEditor" })`.
The widget renders the current thinking level directly, so it follows normal pi UI re-renders.
