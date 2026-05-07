# Pi Turn Diff Plan

Build a Pi extension that opens a native Monaco/Glimpse review window for two review modes only:

1. the exact file diff produced by the most recent completed Pi agent run
2. the current Git working-tree changes

## Source References

- `pi-rewind-hook`: https://github.com/nicobailon/pi-rewind-hook
  - Relevant implementation: `index.ts`
  - Reuse the temporary Git index snapshot approach from:
    - `captureWorktreeTree()`
    - turn lifecycle handlers: `before_agent_start`, `turn_start`, `agent_end`
- `pi-diff-review`: https://github.com/badlogic/pi-diff-review
  - Relevant implementation:
    - `src/index.ts` — command registration, Glimpse window lifecycle, window ↔ extension messaging
    - `src/git.ts` — repo discovery, changed-file discovery, lazy file content loading
    - `src/prompt.ts` — comment payload → editor prompt
    - `src/ui.ts`, `web/index.html`, `web/app.js` — Monaco review UI

## Product Scope

Add three commands:

- `/last-turn-review`
  - reviews changes introduced by the latest user prompt / agent run that produced reviewable file changes
  - compares that run's pre-run Git tree snapshot with its post-run Git tree snapshot
  - no-op runs and runs without reviewable file changes leave the previous changed turn available
- `/undo-last-turn`
  - restores the Git worktree to the pre-run snapshot for the latest changed agent turn
  - shows a confirmation dialog listing the files that will be reverted
  - refuses to run if the current worktree no longer matches that turn's post-run snapshot
  - persists an undo marker so `/reload` does not resurrect the undone snapshot
- `/git-changes-review`
  - reviews current Git working-tree changes against `HEAD`
  - includes untracked, non-ignored files

The review commands use the same Monaco/Glimpse review UI and existing comment behavior.

## Non-Goals

- No cross-session-lineage snapshot discovery.
- No multi-snapshot retention history; keep only the latest changed snapshot pair per session.
- No automatic notification after agent turns.
- No `last commit` review mode.
- No `all files` review mode.
- No scope selector in the review window.
- No support for ignored files.
- No empty directory tracking.
- No staged-index restoration; snapshots model full worktree content only.
- No multi-repo workspace scanning.
- No remote machine support unless Pi extension execution is already running inside that environment.

## Last-Turn Snapshot Model

Use a temporary Git index tree capture, not `git diff HEAD`.

Why: `git diff HEAD` shows all current uncommitted changes. Last-turn review must isolate only the delta introduced by the most recent agent run, even if the user had dirty files before the prompt.

Implementation sketch:

```ts
async function captureWorktreeTree(repoRoot: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-last-turn-review-"));
  const tempIndex = join(tempDir, "index");

  try {
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

    if (await hasHead(repoRoot)) {
      await execFile("git", ["read-tree", "HEAD"], { cwd: repoRoot, env });
    }

    await execFile("git", ["add", "-A"], { cwd: repoRoot, env });
    const { stdout } = await execFile("git", ["write-tree"], { cwd: repoRoot, env });
    return stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
```

Important: use `node:child_process` / promisified `execFile` for this function because Pi's `pi.exec` supports `cwd`, `timeout`, and `signal`, but not custom environment variables like `GIT_INDEX_FILE`.

This captures:

- tracked file content from the worktree
- staged and unstaged file content as final worktree state
- untracked, non-ignored files

It excludes:

- ignored files
- empty directories

## Extension State

Keep the latest agent run with reviewable file changes in memory and persist it to the current Pi session branch.

```ts
interface TurnSnapshot {
  repoRoot: string;
  beforeCommit: string;
  afterCommit: string;
  prompt?: string;
  completedAt: string;
}
```

Runtime state:

```ts
let activeTurnBefore: { repoRoot: string; tree: string; prompt?: string } | null = null;
let latestChangedTurn: TurnSnapshot | null = null;
```

Critical rule: replace `latestChangedTurn` only when the completed run changed reviewable files.

No-op turns, non-Git turns, failed snapshot attempts, and turns that only touch non-reviewable files should not overwrite the previous changed turn.

## Pi Event Hooks

Lifecycle:

1. `before_agent_start`
   - store prompt text for label/context only
2. `turn_start`
   - only for `event.turnIndex === 0`
   - resolve repo root from `ctx.cwd`
   - capture `beforeTree`
   - if not in a Git repo, clear `activeTurnBefore`
3. `agent_end`
   - if `activeTurnBefore` exists, capture `afterTree`
   - if `beforeTree !== afterTree`, compute reviewable files
   - when reviewable files exist, create snapshot commits for before/after trees
   - update the current session keepalive ref to those two commits
   - append a hidden Pi custom entry with the snapshot commit SHAs
   - replace `latestChangedTurn`
   - do not notify automatically
   - clear `activeTurnBefore`
4. `session_start` and `session_tree`
   - scan the current branch for the latest `last-turn-review` custom entry
   - restore `latestChangedTurn` if both commits still exist
   - refresh the per-session keepalive ref to the restored commit pair
5. `session_shutdown`
   - close any active Glimpse review window

Use `agent_end` rather than each `turn_end` because the feature is defined around completed user prompt / agent runs.

## Review Data Model

Use a single-scope review window. Do not preserve `pi-diff-review`'s current multi-scope model.

```ts
type ReviewMode = "last-turn" | "git-changes";

interface ReviewWindowData {
  title: string;
  repoRoot: string;
  mode: ReviewMode;
  files: ReviewFile[];
}
```

`ReviewFile` can stay close to `pi-diff-review`, but it only needs one comparison per file:

```ts
interface ReviewFile {
  id: string;
  path: string;
  comparison: ReviewFileComparison;
}

interface ReviewFileComparison {
  status: "modified" | "added" | "deleted" | "renamed";
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
}
```

## Last-Turn Diff Discovery

At capture time, diff `beforeTree` and `afterTree` to decide whether the run changed reviewable files:

```bash
git diff --find-renames -M --name-status <beforeTree> <afterTree> --
```

For persistence and later review, convert those trees to commits and diff `beforeCommit` and `afterCommit`:

```bash
git diff --find-renames -M --name-status <beforeCommit> <afterCommit> --
```

Parse name-status output into review files:

- `M` → modified
- `A` → added
- `D` → deleted
- `R*` → renamed

Filter with the existing `isReviewableFilePath()` rules from `pi-diff-review`.

If `beforeTree === afterTree`, do not replace `latestChangedTurn`.

## Last-Turn Content Loading

For last-turn review, contents come from persisted snapshot commits.

```ts
async function getSnapshotContent(pi, repoRoot, commitSha, path) {
  const result = await pi.exec("git", ["show", `${commitSha}:${path}`], { cwd: repoRoot });
  return result.code === 0 ? result.stdout : "";
}
```

Rules:

- added file:
  - original = `""`
  - modified = `git show <afterCommit>:<newPath>`
- deleted file:
  - original = `git show <beforeCommit>:<oldPath>`
  - modified = `""`
- modified file:
  - original = `git show <beforeCommit>:<oldPath>`
  - modified = `git show <afterCommit>:<newPath>`
- renamed file:
  - original = `git show <beforeCommit>:<oldPath>`
  - modified = `git show <afterCommit>:<newPath>`

## Current Git Changes Review

`/git-changes-review` reviews the current working tree against `HEAD`.

For repositories with `HEAD`:

```bash
git diff --find-renames -M --name-status HEAD --
git ls-files --others --exclude-standard
```

For repositories without `HEAD`, treat non-ignored files as added.

Content loading rules:

- added file:
  - original = `""`
  - modified = working-tree content
- deleted file:
  - original = `git show HEAD:<oldPath>`
  - modified = `""`
- modified file:
  - original = `git show HEAD:<oldPath>`
  - modified = working-tree content
- renamed file:
  - original = `git show HEAD:<oldPath>`
  - modified = working-tree content at `newPath`

Use existing `pi-diff-review` helpers where useful:

- repo root discovery
- name-status parsing
- untracked-file discovery
- reviewable-path filtering
- working-tree file loading
- revision file loading

Remove `last commit` and `all files` behavior.

## UI

Use the existing Monaco/Glimpse review UI, simplified to a single mode per window.

For `/last-turn-review`:

- window title: `Last turn review`
- sidebar shows only files changed in the latest agent run with reviewable changes
- no scope selector
- Monaco diff editor remains unchanged
- comments use existing behavior: file comments, old/new side, and line/range metadata

For `/git-changes-review`:

- window title: `Git changes review`
- sidebar shows only current Git changed files
- no scope selector
- Monaco diff editor remains unchanged
- comments use existing behavior

Remove or hide these UI elements from `pi-diff-review`:

- `Git diff` scope button if the command is already `/git-changes-review`
- `Last commit` scope button
- `All files` scope button
- scope switching logic

## Prompt Generation

Keep existing comment formatting behavior from `pi-diff-review`:

- include file path
- include line/range when present
- include old/new side for diff comments
- include file-level comments
- include overall comment

Use mode-specific prompt headers.

Last-turn review:

```text
Please address the following feedback on the changes from the latest agent turn with reviewable changes
```

Current Git changes review:

```text
Please address the following feedback on the current Git changes
```

## Command Behavior

### `/last-turn-review`

Handler:

1. ensure no review window is already open
2. ensure `latestChangedTurn != null`
3. ensure current cwd is still inside the same repo root, or clearly warn
4. compute review files from `beforeTree`/`afterTree`
5. if the saved changed turn no longer has reviewable files, notify `The latest changed turn no longer has reviewable files.`
6. open Glimpse window
7. lazy-load file contents from tree SHAs
8. on submit, compose prompt and `ctx.ui.setEditorText(prompt)`

If no snapshot is available:

```text
No changed last-turn Git snapshot is available.
```

### `/git-changes-review`

Handler:

1. ensure no review window is already open
2. resolve repo root from `ctx.cwd`
3. compute current Git changed files
4. if no reviewable files, notify `No current Git changes to review.`
5. open Glimpse window
6. lazy-load file contents from `HEAD` and working tree
7. on submit, compose prompt and `ctx.ui.setEditorText(prompt)`

If not in a Git repo:

```text
Not inside a Git repository.
```

## Edge Cases

- No Git repo during agent run:
  - do not capture snapshots
  - keep any previous changed-turn snapshot
- No changes during last agent run:
  - keep any previous changed-turn snapshot
- Only non-reviewable changes during last agent run:
  - keep any previous changed-turn snapshot
- Current Git changes empty:
  - `/git-changes-review` says no current Git changes to review
- Binary/minified files:
  - filter using existing `isReviewableFilePath()`
- File paths with tabs/newlines:
  - existing line/tab-based parser is acceptable for MVP
- Git object garbage collection:
  - changed-turn trees are converted to snapshot commits
  - per-session keepalive ref `refs/pi-last-turn-review/sessions/<session-id>` keeps the active branch's latest snapshot pair reachable
  - updating/restoring a branch refreshes that ref and intentionally drops older inactive snapshot pairs for that session
  - keepalive commits use a real tree from the repository, not a hard-coded empty-tree SHA, so SHA-256 repositories work
- Submodules:
  - treat as normal Git diff entries for MVP; content loading may return empty

## Implementation Steps

1. Fork/copy `pi-diff-review` into a new extension.
2. Remove `last commit`, `all files`, and multi-scope UI behavior.
3. Add the simplified single-mode review data model.
4. Add temp-index tree capture for last-turn snapshots.
5. Track `latestChangedTurn` via Pi lifecycle hooks.
6. Persist changed-turn snapshot commits with `pi.appendEntry("last-turn-review", ...)`.
7. Restore the latest valid snapshot from the current branch on `session_start` and `session_tree`.
8. Add `/last-turn-review`.
9. Add `/undo-last-turn` with strict current-tree validation and persisted undo marker.
10. Add `/git-changes-review`.
11. Add separate content loaders for:
   - last-turn snapshot-commit review
   - current Git changes review
12. Keep existing comment UX and prompt formatting semantics.
13. Ensure `session_shutdown` closes active Glimpse windows.

## Validation Checklist

- Dirty file before prompt is not included in `/last-turn-review` unless the agent changes it.
- No-op agent run keeps the previous changed turn available for `/last-turn-review`.
- Added, modified, deleted, and renamed files work in `/last-turn-review`.
- `/last-turn-review` still works after exiting Pi and resuming the same session branch.
- `/undo-last-turn` confirmation lists the affected files before mutating the worktree.
- `/undo-last-turn` refuses when the worktree no longer matches the latest changed turn's after snapshot.
- After successful `/undo-last-turn`, `/last-turn-review` remains cleared after `/reload`.
- Added, modified, deleted, renamed, and untracked files work in `/git-changes-review`.
- Ignored files are excluded.
- Binary/minified files are excluded.
- Review submit inserts prompt into Pi editor.
- Review cancel and window close leave editor unchanged.
- `session_shutdown` closes the native review window.
