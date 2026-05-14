# pi-last-turn-review

A tiny pi package for reviewing what just changed before you keep going.

## Install

This repository contains multiple pi packages, so install this package from a checkout:

```sh
npm --prefix pi-last-turn-review install
pi install ./pi-last-turn-review
```

A one-command Git install for this package requires publishing it separately or moving it to its own repository.

## What it does

- Opens a native diff review window for the latest agent turn with file changes.
- Lets you leave overall, file, and inline comments.
- Inserts the review feedback back into pi for the agent to address.
- Can review current Git working-tree changes too.
- Can annotate the latest assistant response.
- Can undo the latest changed agent turn when the worktree still matches it.

## Commands

- `/diff-turn` — review the latest agent turn diff.
- `/diff-git` — review current Git changes.
- `/annotate-turn` — annotate the latest assistant response.
- `/undo-turn` — undo the latest changed agent turn.

## Development

```sh
npm install
npm run check
```

## License

MIT. Portions are based on work from [`badlogic/pi-diff-review`](https://github.com/badlogic/pi-diff-review).
