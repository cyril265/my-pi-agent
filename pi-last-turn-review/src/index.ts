import { execFile as execFileCallback, spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import {
  getGitChangesReviewFiles,
  getLastTurnReviewFiles,
  getRepoRoot,
  loadGitChangesFileContents,
  loadLastTurnFileContents,
} from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  AnnotateCancelPayload,
  AnnotateCopyTextPayload,
  AnnotateRendererErrorPayload,
  AnnotateSubmitPayload,
  AnnotateWindowData,
  AnnotateWindowMessage,
  ReviewCancelPayload,
  ReviewCopyTextPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewMode,
  ReviewRendererErrorPayload,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewTheme,
  ReviewWindowData,
  ReviewWindowMessage,
} from "./types.js";
import { buildAnnotateHtml, buildReviewHtml } from "./ui.js";

const execFile = promisify(execFileCallback);
const STORE_REF_PREFIX = "refs/pi-last-turn-review/sessions";
const SNAPSHOT_ENTRY_TYPE = "last-turn-review";
const UNDO_ENTRY_TYPE = "last-turn-review-undo";

interface TurnSnapshot {
  repoRoot: string;
  beforeTree: string;
  afterTree: string;
  prompt?: string;
  completedAt: string;
}

interface ActiveTurnBefore {
  repoRoot: string;
  tree: string;
  prompt?: string;
}

interface PersistedTurnSnapshot {
  v: 1;
  repoRoot: string;
  beforeCommit: string;
  afterCommit: string;
  prompt?: string;
  completedAt: string;
}

interface UndoChangedPath {
  status: string;
  oldPath: string | null;
  newPath: string | null;
}

interface ReviewSession {
  data: ReviewWindowData;
  promptHeader: string;
  promptScopeLabel: string;
  loadContents(file: ReviewFile): Promise<ReviewFileContents>;
}


function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isReviewCopyTextPayload(value: ReviewWindowMessage): value is ReviewCopyTextPayload {
  return value.type === "copy-text";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

function isRendererErrorPayload(value: ReviewWindowMessage): value is ReviewRendererErrorPayload {
  return value.type === "renderer-error";
}

function isAnnotateSubmitPayload(value: AnnotateWindowMessage): value is AnnotateSubmitPayload {
  return value.type === "submit";
}

function isAnnotateCancelPayload(value: AnnotateWindowMessage): value is AnnotateCancelPayload {
  return value.type === "cancel";
}

function isAnnotateRendererErrorPayload(value: AnnotateWindowMessage): value is AnnotateRendererErrorPayload {
  return value.type === "renderer-error";
}

function isAnnotateCopyTextPayload(value: AnnotateWindowMessage): value is AnnotateCopyTextPayload {
  return value.type === "copy-text";
}

type WaitingEditorResult = "escape" | "window-settled";

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

async function hasHead(repoRoot: string): Promise<boolean> {
  try {
    await execFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

function snapshotCommitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "pi-last-turn-review",
    GIT_AUTHOR_EMAIL: "pi-last-turn-review@local",
    GIT_COMMITTER_NAME: "pi-last-turn-review",
    GIT_COMMITTER_EMAIL: "pi-last-turn-review@local",
  };
}

async function execGitChecked(repoRoot: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFile("git", args, { cwd: repoRoot, env });
  const stdout = String(result.stdout).trim();
  return stdout;
}

async function execGitRaw(repoRoot: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFile("git", args, { cwd: repoRoot, env });
  return String(result.stdout);
}

async function writeClipboard(text: string): Promise<void> {
  const commands = process.platform === "darwin"
    ? [["pbcopy"]]
    : process.platform === "win32"
      ? [["clip.exe"]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];

  let lastError: unknown;
  for (const [command, ...args] of commands) {
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(command, args);
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolvePromise();
          } else {
            reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
          }
        });
        child.stdin.end(text);
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Clipboard copy failed: ${message}`);
}

async function gitCommitExists(repoRoot: string, commit: string): Promise<boolean> {
  try {
    await execGitChecked(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function gitPathExists(repoRoot: string, commit: string, path: string): Promise<boolean> {
  try {
    await execGitChecked(repoRoot, ["cat-file", "-e", `${commit}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

async function createSnapshotCommit(repoRoot: string, treeSha: string): Promise<string> {
  return execGitChecked(repoRoot, ["commit-tree", treeSha, "-m", "pi last-turn-review snapshot"], snapshotCommitEnv());
}

function sessionStoreRef(sessionId: string): string {
  return `${STORE_REF_PREFIX}/${sessionId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

async function getRefHead(repoRoot: string, ref: string): Promise<string | undefined> {
  try {
    return await execGitChecked(repoRoot, ["rev-parse", "--verify", ref]);
  } catch {
    return undefined;
  }
}

async function getCommitTree(repoRoot: string, commit: string): Promise<string> {
  return execGitChecked(repoRoot, ["show", "-s", "--format=%T", commit]);
}

async function keepLatestSnapshotPair(repoRoot: string, sessionId: string, beforeCommit: string, afterCommit: string): Promise<void> {
  const keepaliveTree = await getCommitTree(repoRoot, beforeCommit);
  const keepaliveCommit = await execGitChecked(repoRoot, [
    "commit-tree",
    keepaliveTree,
    "-p",
    beforeCommit,
    "-p",
    afterCommit,
    "-m",
    "pi last-turn-review store",
  ], snapshotCommitEnv());

  const ref = sessionStoreRef(sessionId);
  const oldHead = await getRefHead(repoRoot, ref);
  if (oldHead) {
    await execGitChecked(repoRoot, ["update-ref", ref, keepaliveCommit, oldHead]);
  } else {
    await execGitChecked(repoRoot, ["update-ref", ref, keepaliveCommit]);
  }
}

async function deleteLatestSnapshotPairRef(repoRoot: string, sessionId: string): Promise<void> {
  const ref = sessionStoreRef(sessionId);
  const oldHead = await getRefHead(repoRoot, ref);
  if (oldHead == null) return;
  await execGitChecked(repoRoot, ["update-ref", "-d", ref, oldHead]);
}

function isPersistedTurnSnapshot(value: unknown): value is PersistedTurnSnapshot {
  if (value == null || typeof value !== "object") return false;
  const data = value as Partial<PersistedTurnSnapshot>;
  return data.v === 1
    && typeof data.repoRoot === "string"
    && typeof data.beforeCommit === "string"
    && typeof data.afterCommit === "string"
    && typeof data.completedAt === "string"
    && (data.prompt === undefined || typeof data.prompt === "string");
}

function toTurnSnapshot(data: PersistedTurnSnapshot): TurnSnapshot {
  return {
    repoRoot: data.repoRoot,
    beforeTree: data.beforeCommit,
    afterTree: data.afterCommit,
    prompt: data.prompt,
    completedAt: data.completedAt,
  };
}

function parseUndoNameStatus(output: string): UndoChangedPath[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const changes: UndoChangedPath[] = [];

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? "";
    const code = status[0] ?? "";

    if (code === "R") {
      const oldPath = tokens[index++] ?? null;
      const newPath = tokens[index++] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status, oldPath, newPath });
      }
      continue;
    }

    const path = tokens[index++] ?? null;
    if (path == null) continue;

    changes.push({
      status,
      oldPath: code === "A" ? null : path,
      newPath: code === "D" ? null : path,
    });
  }

  return changes;
}

async function getUndoChangedPaths(repoRoot: string, beforeCommit: string, afterCommit: string): Promise<UndoChangedPath[]> {
  const output = await execGitRaw(repoRoot, ["diff", "--find-renames", "-M", "--name-status", "-z", beforeCommit, afterCommit, "--"]);
  return parseUndoNameStatus(output);
}

function sanitizeUndoPath(path: string): string {
  return path.replace(/[\r\n\t]/g, " ");
}

function formatUndoChange(change: UndoChangedPath): string {
  const code = change.status[0] ?? "?";
  if (code === "R") {
    return `R ${sanitizeUndoPath(change.oldPath ?? "(unknown)")} -> ${sanitizeUndoPath(change.newPath ?? "(unknown)")}`;
  }
  return `${code} ${sanitizeUndoPath(change.newPath ?? change.oldPath ?? "(unknown)")}`;
}

function formatUndoConfirmationMessage(changes: UndoChangedPath[]): string {
  const maxVisibleFiles = 12;
  const visibleFiles = changes.slice(0, maxVisibleFiles).map((change) => `  ${truncateToWidth(formatUndoChange(change), 120)}`);
  const remainingCount = changes.length - visibleFiles.length;
  if (remainingCount > 0) {
    visibleFiles.push(`  ... and ${remainingCount} more`);
  }

  return [
    "Restore the repository worktree to before the latest changed agent turn?",
    "",
    `This will revert ${changes.length} changed path(s):`,
    ...visibleFiles,
    "",
    "This cannot be undone by this command. Continue?",
  ].join("\n");
}

function resolveRepoPath(repoRoot: string, path: string): string {
  if (path.length === 0 || path.includes("\0") || path.startsWith("/")) {
    throw new Error(`Refusing unsafe Git path: ${path}`);
  }

  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedPath = resolve(resolvedRepoRoot, path);
  if (resolvedPath !== resolvedRepoRoot && !resolvedPath.startsWith(`${resolvedRepoRoot}${sep}`)) {
    throw new Error(`Refusing path outside repository: ${path}`);
  }

  return resolvedPath;
}

async function getStagedChangedPaths(repoRoot: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const output = await execGitRaw(
    repoRoot,
    ["diff", "--cached", "--name-only", "-z", "--", ...paths],
    { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
  );
  return output.split("\0").filter((path) => path.length > 0);
}

function hasDeletedAncestor(path: string, pathsToDelete: string[]): boolean {
  return pathsToDelete.some((deletedPath) => path === deletedPath || path.startsWith(`${deletedPath}/`));
}

async function assertNoUnmodeledRestoreTargets(
  repoRoot: string,
  afterCommit: string,
  pathsToRestore: string[],
  pathsToDelete: string[],
): Promise<void> {
  for (const path of pathsToRestore) {
    try {
      const stat = await lstat(resolveRepoPath(repoRoot, path));
      if (stat.isDirectory()) {
        throw new Error(`Cannot undo: refusing to restore over directory ${path}`);
      }
      if (!await gitPathExists(repoRoot, afterCommit, path)) {
        throw new Error(`Cannot undo: untracked or ignored file exists at restore target ${path}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "ENOTDIR" && hasDeletedAncestor(path, pathsToDelete)) continue;
      throw error;
    }
  }
}

async function removeModeledPath(repoRoot: string, path: string): Promise<void> {
  const absolutePath = resolveRepoPath(repoRoot, path);

  try {
    const stat = await lstat(absolutePath);
    if (stat.isDirectory()) {
      throw new Error(`Cannot undo: refusing to recursively delete directory ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  await rm(absolutePath, { force: true });
}

async function undoSnapshotWorktree(repoRoot: string, beforeCommit: string, afterCommit: string): Promise<number> {
  const currentTree = await captureWorktreeTree(repoRoot);
  const expectedAfterTree = await getCommitTree(repoRoot, afterCommit);
  if (currentTree !== expectedAfterTree) {
    throw new Error("Cannot undo: working tree changed since that agent turn.");
  }

  const changes = await getUndoChangedPaths(repoRoot, beforeCommit, afterCommit);
  for (const change of changes) {
    if (change.oldPath != null) resolveRepoPath(repoRoot, change.oldPath);
    if (change.newPath != null) resolveRepoPath(repoRoot, change.newPath);
  }

  const affectedPaths = [...new Set(changes.flatMap((change) => [change.oldPath, change.newPath]).filter((path): path is string => path != null))];
  const stagedChangedPaths = await getStagedChangedPaths(repoRoot, affectedPaths);
  if (stagedChangedPaths.length > 0) {
    throw new Error(`Cannot undo: staged index changes exist for ${stagedChangedPaths.length} affected path(s).`);
  }

  const pathsToDelete = changes
    .filter((change) => change.status[0] === "A" || change.status[0] === "R")
    .map((change) => change.newPath)
    .filter((path): path is string => path != null);
  const pathsToRestore = changes
    .map((change) => change.oldPath)
    .filter((path): path is string => path != null);

  await assertNoUnmodeledRestoreTargets(repoRoot, afterCommit, pathsToRestore, pathsToDelete);

  for (const path of pathsToDelete) {
    await removeModeledPath(repoRoot, path);
  }

  if (pathsToRestore.length > 0) {
    await execGitChecked(
      repoRoot,
      ["restore", `--source=${beforeCommit}`, "--worktree", "--", ...pathsToRestore],
      { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
    );
  }

  const restoredTree = await captureWorktreeTree(repoRoot);
  const expectedBeforeTree = await getCommitTree(repoRoot, beforeCommit);
  if (restoredTree !== expectedBeforeTree) {
    throw new Error("Undo did not restore the expected pre-turn snapshot.");
  }

  return changes.length;
}

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
    return String(stdout).trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

const ANSI_256_COLORS = [
  "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

for (const r of [0, 95, 135, 175, 215, 255]) {
  for (const g of [0, 95, 135, 175, 215, 255]) {
    for (const b of [0, 95, 135, 175, 215, 255]) {
      ANSI_256_COLORS.push(`#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`);
    }
  }
}

for (let i = 0; i < 24; i += 1) {
  const value = 8 + i * 10;
  const hex = value.toString(16).padStart(2, "0");
  ANSI_256_COLORS.push(`#${hex}${hex}${hex}`);
}

function ansiToHex(ansi: string, fallback: string): string {
  const trueColor = ansi.match(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
  if (trueColor) {
    const [, r, g, b] = trueColor;
    return `#${Number(r).toString(16).padStart(2, "0")}${Number(g).toString(16).padStart(2, "0")}${Number(b).toString(16).padStart(2, "0")}`;
  }

  const indexed = ansi.match(/\x1b\[(?:38|48);5;(\d+)m/);
  if (indexed) {
    return ANSI_256_COLORS[Number(indexed[1])] ?? fallback;
  }

  return fallback;
}

const DARK_REVIEW_THEME: ReviewTheme = {
  appearance: "dark",
  bg: "#0b1020",
  panel: "#111827",
  hover: "#1f2937",
  active: "#243044",
  badge: "#1e293b",
  border: "#263244",
  text: "#e5e7eb",
  strong: "#f8fafc",
  muted: "#9ca3af",
  dim: "#6b7280",
  accent: "#60a5fa",
  success: "#34d399",
  error: "#fb7185",
  warning: "#fbbf24",
  diffAdded: "#22c55e",
  diffRemoved: "#ef4444",
};

const LIGHT_REVIEW_THEME: ReviewTheme = {
  appearance: "light",
  bg: "#f8fafc",
  panel: "#ffffff",
  hover: "#eef2f7",
  active: "#dbeafe",
  badge: "#e2e8f0",
  border: "#d7dde8",
  text: "#334155",
  strong: "#0f172a",
  muted: "#64748b",
  dim: "#94a3b8",
  accent: "#2563eb",
  success: "#059669",
  error: "#dc2626",
  warning: "#d97706",
  diffAdded: "#16a34a",
  diffRemoved: "#dc2626",
};

function relativeLuminance(hex: string): number {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (!match) return 0;

  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function buildReviewTheme(theme: ExtensionContext["ui"]["theme"]): ReviewTheme {
  const piBackground = ansiToHex(theme.getBgAnsi("customMessageBg"), DARK_REVIEW_THEME.bg);
  return relativeLuminance(piBackground) > 0.45 ? LIGHT_REVIEW_THEME : DARK_REVIEW_THEME;
}

function createAnnotateWindowData(text: string, theme: ReviewTheme): AnnotateWindowData {
  return {
    title: "Annotate turn",
    sourceLabel: "latest response",
    sourceHint: "Annotate the final assistant response from the latest agent turn. Hover or click line numbers in the gutter to add an inline comment.",
    text,
    theme,
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === "object" && block != null && "type" in block && "text" in block
        && block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function getFinalAssistantResponseFromBranch(branch: unknown[]): string | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (typeof entry !== "object" || entry == null || !("type" in entry) || entry.type !== "message" || !("message" in entry)) continue;

    const message = entry.message;
    if (typeof message !== "object" || message == null || !("role" in message) || message.role !== "assistant") continue;

    const text = extractTextContent("content" in message ? message.content : undefined);
    if (text.length > 0) return text;
  }

  return null;
}

function composeAnnotatePrompt(sourceText: string, payload: AnnotateSubmitPayload): string {
  const sourceLines = sourceText.split("\n");
  const comments = [...payload.comments].sort((a, b) => a.line - b.line);
  const lines: string[] = ["Address this feedback:", ""];

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push(`Overall: ${overallComment}`);
  }

  comments.forEach((comment) => {
    const sourceLine = sourceLines[comment.line - 1]?.trim();
    if (sourceLine != null && sourceLine.length > 0) {
      lines.push(`"${sourceLine}"`);
    } else {
      lines.push(`Line ${comment.line}`);
    }
    lines.push(`- ${comment.body.trim()}`);
  });

  return lines.join("\n").trim();
}

function shouldUseTopmostNativeWindow(): boolean {
  return process.platform === "win32";
}

function createReviewWindowData(
  mode: ReviewMode,
  repoRoot: string,
  files: ReviewFile[],
  theme: ReviewTheme,
): ReviewWindowData {
  if (mode === "last-turn") {
    return {
      title: "Diff turn",
      repoRoot,
      mode,
      scopeLabel: "turn diff",
      scopeHint: "Review the latest agent turn diff. Hover or click line numbers in the gutter to add an inline comment.",
      theme,
      files,
    };
  }

  return {
    title: "Diff git",
    repoRoot,
    mode,
    scopeLabel: "git diff",
    scopeHint: "Review current Git working-tree changes against HEAD. Hover or click line numbers in the gutter to add an inline comment.",
    theme,
    files,
  };
}

export default function (pi: ExtensionAPI) {
  const activePromptTextBySession = new Map<string, string>();
  const activeTurnBeforeBySession = new Map<string, ActiveTurnBefore>();
  const latestChangedTurnBySession = new Map<string, TurnSnapshot>();
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return { promise, dismiss };
  }

  async function openReviewWindow(ctx: ExtensionCommandContext, session: ReviewSession): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Review window requires interactive UI.", "warning");
      return;
    }

    if (activeWindow != null) {
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    if (session.data.files.length === 0) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    try {
      const html = buildReviewHtml(session.data);
      const window = open(html, {
        width: 1680,
        height: 1020,
        title: session.data.title,
        ...(shouldUseTopmostNativeWindow() ? { floating: true } : {}),
      });
      activeWindow = window;

      const waitingUI = showWaitingUI(ctx);
      const fileMap = new Map(session.data.files.map((file) => [file.id, file]));
      const contentCache = new Map<string, Promise<ReviewFileContents>>();

      const sendWindowMessage = (message: ReviewHostMessage): void => {
        if (activeWindow !== window) return;
        const payload = escapeForInlineScript(JSON.stringify(message));
        window.send(`window.__reviewReceive(${payload});`);
      };

      const loadContents = (file: ReviewFile): Promise<ReviewFileContents> => {
        const cached = contentCache.get(file.id);
        if (cached != null) return cached;

        const pending = session.loadContents(file);
        contentCache.set(file.id, pending);
        return pending;
      };

      ctx.ui.notify("Opened native review window.", "info");
      const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (clearActiveWindow: boolean): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (clearActiveWindow && activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
          if (settled) return;
          settled = true;
          cleanup(false);
          resolve(value);
        };

        const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
          const file = fileMap.get(message.fileId);
          if (file == null) {
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              message: "Unknown file requested.",
            });
            return;
          }

          try {
            const contents = await loadContents(file);
            sendWindowMessage({
              type: "file-data",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              originalContent: contents.originalContent,
              modifiedContent: contents.modifiedContent,
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              message: messageText,
            });
          }
        };

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;
          if (isRendererErrorPayload(message)) {
            if (settled) return;
            settled = true;
            cleanup(false);
            reject(new Error(message.message || "Review renderer failed."));
            return;
          }
          if (isRequestFilePayload(message)) {
            void handleRequestFile(message);
            return;
          }
          if (isReviewCopyTextPayload(message)) {
            void writeClipboard(message.text).catch((error) => {
              const errorMessage = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(errorMessage, "warning");
            });
            return;
          }
          if (isSubmitPayload(message) || isCancelPayload(message)) {
            settle(message);
          }
        };

        const onClosed = (): void => {
          if (settled) return;
          settled = true;
          cleanup(true);
          resolve(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup(false);
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(session.data.files, message, session.promptHeader, session.promptScopeLabel);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  async function openAnnotateWindow(ctx: ExtensionCommandContext, data: AnnotateWindowData): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Annotation window requires interactive UI.", "warning");
      return;
    }

    if (activeWindow != null) {
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    try {
      const html = buildAnnotateHtml(data);
      const window = open(html, {
        width: 1320,
        height: 920,
        title: data.title,
        ...(shouldUseTopmostNativeWindow() ? { floating: true } : {}),
      });
      activeWindow = window;

      const waitingUI = showWaitingUI(ctx);
      const terminalMessagePromise = new Promise<AnnotateSubmitPayload | AnnotateCancelPayload | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (clearActiveWindow: boolean): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (clearActiveWindow && activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: AnnotateSubmitPayload | AnnotateCancelPayload | null): void => {
          if (settled) return;
          settled = true;
          cleanup(false);
          resolve(value);
        };

        const onMessage = (data: unknown): void => {
          const message = data as AnnotateWindowMessage;
          if (isAnnotateRendererErrorPayload(message)) {
            cleanup(true);
            reject(new Error(message.message || "Annotation renderer failed."));
            return;
          }

          if (isAnnotateCopyTextPayload(message)) {
            void writeClipboard(message.text).catch((error) => {
              const errorMessage = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(errorMessage, "warning");
            });
            return;
          }

          if (isAnnotateSubmitPayload(message) || isAnnotateCancelPayload(message)) {
            settle(message);
          }
        };

        const onClosed = (): void => settle(null);
        const onError = (error: Error): void => {
          cleanup(true);
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      ctx.ui.notify("Opened native annotation window.", "info");
      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Annotation cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Annotation cancelled.", "info");
        return;
      }

      const prompt = composeAnnotatePrompt(data.text, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted annotation feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Annotation failed: ${message}`, "error");
    }
  }

  function toPersistedSnapshot(snapshot: TurnSnapshot): PersistedTurnSnapshot {
    return {
      v: 1,
      repoRoot: snapshot.repoRoot,
      beforeCommit: snapshot.beforeTree,
      afterCommit: snapshot.afterTree,
      prompt: snapshot.prompt,
      completedAt: snapshot.completedAt,
    };
  }

  function appendSnapshotEntry(snapshot: TurnSnapshot): void {
    pi.appendEntry(SNAPSHOT_ENTRY_TYPE, toPersistedSnapshot(snapshot));
  }

  async function restoreLatestChangedTurn(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    latestChangedTurnBySession.delete(sessionId);

    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type !== "custom") continue;
      if (entry.customType === UNDO_ENTRY_TYPE) break;
      if (entry.customType !== SNAPSHOT_ENTRY_TYPE || !isPersistedTurnSnapshot(entry.data)) {
        continue;
      }

      if (await gitCommitExists(entry.data.repoRoot, entry.data.beforeCommit) && await gitCommitExists(entry.data.repoRoot, entry.data.afterCommit)) {
        await keepLatestSnapshotPair(entry.data.repoRoot, sessionId, entry.data.beforeCommit, entry.data.afterCommit);
        latestChangedTurnBySession.set(sessionId, toTurnSnapshot(entry.data));
        break;
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await restoreLatestChangedTurn(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreLatestChangedTurn(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    activePromptTextBySession.set(ctx.sessionManager.getSessionId(), event.prompt);
  });

  pi.on("turn_start", async (event, ctx) => {
    if (event.turnIndex !== 0) return;

    const sessionId = ctx.sessionManager.getSessionId();
    activeTurnBeforeBySession.delete(sessionId);

    try {
      const repoRoot = await getRepoRoot(pi, ctx.cwd);
      const tree = await captureWorktreeTree(repoRoot);
      activeTurnBeforeBySession.set(sessionId, {
        repoRoot,
        tree,
        prompt: activePromptTextBySession.get(sessionId),
      });
    } catch {
      activeTurnBeforeBySession.delete(sessionId);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const activeTurnBefore = activeTurnBeforeBySession.get(sessionId);
    if (activeTurnBefore == null) {
      activePromptTextBySession.delete(sessionId);
      return;
    }

    try {
      const afterTree = await captureWorktreeTree(activeTurnBefore.repoRoot);
      if (activeTurnBefore.tree !== afterTree) {
        const files = await getLastTurnReviewFiles(pi, activeTurnBefore.repoRoot, activeTurnBefore.tree, afterTree);
        if (files.length > 0) {
          const beforeCommit = await createSnapshotCommit(activeTurnBefore.repoRoot, activeTurnBefore.tree);
          const afterCommit = await createSnapshotCommit(activeTurnBefore.repoRoot, afterTree);
          await keepLatestSnapshotPair(activeTurnBefore.repoRoot, sessionId, beforeCommit, afterCommit);

          const data: PersistedTurnSnapshot = {
            v: 1,
            repoRoot: activeTurnBefore.repoRoot,
            beforeCommit,
            afterCommit,
            prompt: activeTurnBefore.prompt,
            completedAt: new Date().toISOString(),
          };

          const snapshot = toTurnSnapshot(data);
          latestChangedTurnBySession.set(sessionId, snapshot);
          appendSnapshotEntry(snapshot);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to persist last-turn review snapshot: ${message}`, "warning");
    } finally {
      activeTurnBeforeBySession.delete(sessionId);
      activePromptTextBySession.delete(sessionId);
    }
  });

  pi.registerCommand("diff-turn", {
    description: "Open the Glimpse diff review window for the latest agent turn",
    handler: async (_args, ctx) => {
      if (activeWindow != null) {
        ctx.ui.notify("A review window is already open.", "warning");
        return;
      }

      const snapshot = latestChangedTurnBySession.get(ctx.sessionManager.getSessionId()) ?? null;
      if (snapshot == null) {
        ctx.ui.notify("No changed last-turn Git snapshot is available.", "info");
        return;
      }

      let currentRepoRoot: string;
      try {
        currentRepoRoot = await getRepoRoot(pi, ctx.cwd);
      } catch {
        ctx.ui.notify("Current cwd is not inside the last-turn snapshot repository.", "warning");
        return;
      }

      if (currentRepoRoot !== snapshot.repoRoot) {
        ctx.ui.notify("Last-turn snapshot belongs to a different Git repository.", "warning");
        return;
      }

      let files: ReviewFile[];
      try {
        files = await getLastTurnReviewFiles(
          pi,
          snapshot.repoRoot,
          snapshot.beforeTree,
          snapshot.afterTree,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Review failed: ${message}`, "error");
        return;
      }

      if (files.length === 0) {
        ctx.ui.notify("The latest changed turn no longer has reviewable files.", "info");
        return;
      }

      await openReviewWindow(ctx, {
        data: createReviewWindowData("last-turn", snapshot.repoRoot, files, buildReviewTheme(ctx.ui.theme)),
        promptHeader: "Please address the following feedback on the changes from the latest agent turn with reviewable changes",
        promptScopeLabel: "latest changed turn",
        loadContents: (file) => loadLastTurnFileContents(
          pi,
          snapshot.repoRoot,
          snapshot.beforeTree,
          snapshot.afterTree,
          file,
        ),
      });
    },
  });

  pi.registerCommand("annotate-turn", {
    description: "Open the Glimpse annotation window for the latest assistant response",
    handler: async (_args, ctx) => {
      if (activeWindow != null) {
        ctx.ui.notify("A review window is already open.", "warning");
        return;
      }

      const latestAssistantResponse = getFinalAssistantResponseFromBranch(ctx.sessionManager.getBranch());
      if (latestAssistantResponse == null) {
        ctx.ui.notify("No latest assistant response is available to annotate.", "info");
        return;
      }

      await openAnnotateWindow(ctx, createAnnotateWindowData(latestAssistantResponse, buildReviewTheme(ctx.ui.theme)));
    },
  });

  pi.registerCommand("undo-turn", {
    description: "Undo the exact worktree changes from the latest agent turn with reviewable changes",
    handler: async (_args, ctx) => {
      await restoreLatestChangedTurn(ctx);

      const snapshot = latestChangedTurnBySession.get(ctx.sessionManager.getSessionId()) ?? null;
      if (snapshot == null) {
        ctx.ui.notify("No changed last-turn Git snapshot is available.", "info");
        return;
      }

      let currentRepoRoot: string;
      try {
        currentRepoRoot = await getRepoRoot(pi, ctx.cwd);
      } catch {
        ctx.ui.notify("Current cwd is not inside the last-turn snapshot repository.", "warning");
        return;
      }

      if (currentRepoRoot !== snapshot.repoRoot) {
        ctx.ui.notify("Last-turn snapshot belongs to a different Git repository.", "warning");
        return;
      }

      try {
        const currentTree = await captureWorktreeTree(snapshot.repoRoot);
        const expectedAfterTree = await getCommitTree(snapshot.repoRoot, snapshot.afterTree);
        if (currentTree !== expectedAfterTree) {
          ctx.ui.notify("Cannot undo: working tree changed since that agent turn.", "warning");
          return;
        }

        const changes = await getUndoChangedPaths(snapshot.repoRoot, snapshot.beforeTree, snapshot.afterTree);
        if (changes.length === 0) {
          ctx.ui.notify("The latest changed turn has no file changes to undo.", "info");
          return;
        }

        const confirmed = await ctx.ui.confirm(
          "Undo Last Turn",
          formatUndoConfirmationMessage(changes),
        );
        if (!confirmed) {
          ctx.ui.notify("Undo cancelled.", "info");
          return;
        }

        const undoneCount = await undoSnapshotWorktree(snapshot.repoRoot, snapshot.beforeTree, snapshot.afterTree);
        pi.appendEntry(UNDO_ENTRY_TYPE, {
          v: 1,
          repoRoot: snapshot.repoRoot,
          beforeCommit: snapshot.beforeTree,
          afterCommit: snapshot.afterTree,
          undoneAt: new Date().toISOString(),
        });
        latestChangedTurnBySession.delete(ctx.sessionManager.getSessionId());
        await deleteLatestSnapshotPairRef(snapshot.repoRoot, ctx.sessionManager.getSessionId()).catch(() => {});
        ctx.ui.notify(`Undid latest changed agent turn (${undoneCount} changed path(s)).`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Undo failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("diff-git", {
    description: "Open the Glimpse diff review window for current Git changes",
    handler: async (_args, ctx) => {
      if (activeWindow != null) {
        ctx.ui.notify("A review window is already open.", "warning");
        return;
      }

      let repoRoot: string;
      try {
        repoRoot = await getRepoRoot(pi, ctx.cwd);
      } catch {
        ctx.ui.notify("Not inside a Git repository.", "info");
        return;
      }

      let files: ReviewFile[];
      try {
        files = await getGitChangesReviewFiles(pi, repoRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Review failed: ${message}`, "error");
        return;
      }

      if (files.length === 0) {
        ctx.ui.notify("No current Git changes to review.", "info");
        return;
      }

      await openReviewWindow(ctx, {
        data: createReviewWindowData("git-changes", repoRoot, files, buildReviewTheme(ctx.ui.theme)),
        promptHeader: "Please address the following feedback on the current Git changes",
        promptScopeLabel: "current Git changes",
        loadContents: (file) => loadGitChangesFileContents(pi, repoRoot, file),
      });
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    activePromptTextBySession.delete(sessionId);
    activeTurnBeforeBySession.delete(sessionId);
    latestChangedTurnBySession.delete(sessionId);
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
