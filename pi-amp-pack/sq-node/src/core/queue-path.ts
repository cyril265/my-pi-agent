import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_QUEUE_RELATIVE_PATH = path.join(".sift", "issues.jsonl");

export interface ResolveQueuePathOptions {
  cwd?: string;
  queuePathOverride?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveQueuePath(options: ResolveQueuePathOptions = {}): string {
  const env = options.env ?? process.env;

  let cwd: string;
  try {
    cwd = options.cwd ?? process.cwd();
  } catch {
    cwd = ".";
  }

  if (options.queuePathOverride?.trim()) {
    return path.isAbsolute(options.queuePathOverride)
      ? options.queuePathOverride
      : path.resolve(cwd, options.queuePathOverride);
  }

  if (env.SQ_QUEUE_PATH?.trim()) {
    return path.isAbsolute(env.SQ_QUEUE_PATH)
      ? env.SQ_QUEUE_PATH
      : path.resolve(cwd, env.SQ_QUEUE_PATH);
  }

  const git = gitContext(cwd);
  return resolveImplicitQueuePath(cwd, git);
}

interface GitContext {
  cwd: string;
  worktreeRoot: string;
  gitDir: string;
  gitCommonDir: string;
}

function resolveImplicitQueuePath(cwd: string, git?: GitContext): string {
  if (!git) {
    return path.join(cwd, DEFAULT_QUEUE_RELATIVE_PATH);
  }

  const existing = findExistingQueue(git.cwd, git.worktreeRoot);
  if (existing) {
    return existing;
  }

  const mainWorktreeRoot = linkedMainWorktreeRoot(git);
  if (mainWorktreeRoot) {
    const relativeCwd = path.relative(git.worktreeRoot, git.cwd);
    if (!relativeCwd.startsWith("..")) {
      const linked = findExistingQueue(path.join(mainWorktreeRoot, relativeCwd), mainWorktreeRoot);
      if (linked) {
        return linked;
      }
    }
  }

  return path.join(git.cwd, DEFAULT_QUEUE_RELATIVE_PATH);
}

function gitContext(cwd: string): GitContext | undefined {
  const canonicalCwd = safeRealpath(cwd);
  const worktreeRoot = gitRevParse(canonicalCwd, "--show-toplevel");
  const gitDir = gitRevParse(canonicalCwd, "--git-dir");
  const gitCommonDir = gitRevParse(canonicalCwd, "--git-common-dir");
  if (!worktreeRoot || !gitDir || !gitCommonDir) {
    return undefined;
  }

  return {
    cwd: canonicalCwd,
    worktreeRoot: resolveGitPath(canonicalCwd, worktreeRoot),
    gitDir: resolveGitPath(canonicalCwd, gitDir),
    gitCommonDir: resolveGitPath(canonicalCwd, gitCommonDir),
  };
}

function linkedMainWorktreeRoot(git: GitContext): string | undefined {
  if (git.gitDir === git.gitCommonDir) {
    return undefined;
  }
  return path.dirname(git.gitCommonDir);
}

function gitRevParse(cwd: string, arg: string): string | undefined {
  try {
    const stdout = execFileSync("git", ["rev-parse", arg], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0)?.trim();
    return line || undefined;
  } catch {
    return undefined;
  }
}

function resolveGitPath(cwd: string, raw: string): string {
  const absolute = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
  return safeRealpath(absolute);
}

function findExistingQueue(start: string, stop: string): string | undefined {
  let current = start;

  while (true) {
    const candidate = path.join(current, DEFAULT_QUEUE_RELATIVE_PATH);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }

    if (samePath(current, stop)) {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current || !isWithin(parent, stop)) {
      return undefined;
    }
    current = parent;
  }
}

function samePath(left: string, right: string): boolean {
  return safeRealpath(left) === safeRealpath(right);
}

function isWithin(candidate: string, stop: string): boolean {
  const relative = path.relative(stop, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealpath(input: string): string {
  try {
    return fs.realpathSync.native(input);
  } catch {
    return path.resolve(input);
  }
}
