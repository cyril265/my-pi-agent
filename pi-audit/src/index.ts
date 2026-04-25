#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Scope = "global" | "project";
type SourceKind = "npm" | "git" | "local";
type Recommendation = "yes" | "no" | "maybe";
type PackageEntry = string | {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
};
type Settings = {
  npmCommand?: string[];
  packages?: PackageEntry[];
};
type ParsedSource =
  | { kind: "npm"; source: string; spec: string; name: string; pinned: boolean }
  | { kind: "git"; source: string; repo: string; host: string; path: string; ref?: string; pinned: boolean }
  | { kind: "local"; source: string; path: string; pinned: false };
type AuditResult = { recommendation: Recommendation; report: string };
type FetchedSource = { auditPath: string; version?: string; gitHead?: string };
type Manifest = {
  source: string;
  kind: SourceKind;
  identity: string;
  installedAt: string;
  audit: AuditResult;
  version?: string;
  gitHead?: string;
};
type ConfiguredEntry = {
  scope: Scope;
  entry: PackageEntry;
  source: string;
};
type ManagedEntry = ConfiguredEntry & {
  settingsPath: string;
  baseDir: string;
  snapshotPath: string;
  manifest: Manifest;
};

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command || command === "-h" || command === "--help") {
  usage();
  process.exit(command ? 0 : 1);
}

try {
  if (command === "install") {
    await installCommand(args);
  } else if (command === "update") {
    if (args.length === 0) {
      await updateAllCommand(args);
    } else {
      await updateCommand(args);
    }
  } else if (command === "update-all") {
    await updateAllCommand(args);
  } else if (command === "migrate") {
    await migrateCommand(args);
  } else {
    usage();
    process.exit(1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  pi-audit install <source> [-l|--local]
  pi-audit update [package]
  pi-audit update-all
  pi-audit migrate

Sources match pi install: npm:, git:, raw git URLs, local paths.`);
}

async function installCommand(rawArgs: string[]) {
  const { source, local } = parseInstallArgs(rawArgs);
  const scope: Scope = local ? "project" : "global";
  const parsed = parseSource(source);
  const fetched = fetchSource(parsed);
  const audit = auditPackage(source, fetched.auditPath);
  printAudit(source, audit);

  if (!(await confirm("Install?"))) {
    console.log("Skipped.");
    return;
  }

  const snapshotPath = copyToStore(scope, fetched, source, audit, parsed);
  installSnapshotDependencies(snapshotPath);
  upsertSettingsEntry(scope, snapshotPath, identityForSource(parsed));
  console.log(`Installed audited snapshot: ${displayLocalSource(scope, snapshotPath)}`);
}

async function updateCommand(rawArgs: string[]) {
  if (rawArgs.length !== 1) {
    throw new Error("Usage: pi-audit update [package]");
  }

  const matches = findManagedEntries().filter((entry) => matchesPackage(rawArgs[0], entry.manifest));
  if (matches.length === 0) {
    throw new Error(`No managed package found for ${rawArgs[0]}`);
  }

  for (const entry of matches) {
    await updateManagedEntry(entry);
  }
}

async function updateAllCommand(rawArgs: string[]) {
  if (rawArgs.length !== 0) {
    throw new Error("Usage: pi-audit update-all");
  }

  const entries = findManagedEntries();
  if (entries.length === 0) {
    console.log("No managed packages found.");
    return;
  }

  let skipped = 0;
  let current = 0;
  const updatable: ManagedEntry[] = [];
  for (const entry of entries) {
    const parsed = parseSource(entry.manifest.source);
    if (parsed.kind === "local" || parsed.pinned) {
      skipped += 1;
      continue;
    }
    if (hasAvailableUpdate(entry, parsed)) {
      updatable.push(entry);
    } else {
      current += 1;
    }
  }

  console.log(`${entries.length} managed package(s), ${updatable.length} update(s) available, ${current} current, ${skipped} skipped.`);
  for (const entry of updatable) {
    await updateManagedEntry(entry, true);
  }
}

async function migrateCommand(rawArgs: string[]) {
  if (rawArgs.length !== 0) {
    throw new Error("Usage: pi-audit migrate");
  }

  const entries = findMigratableEntries();
  if (entries.length === 0) {
    console.log("No npm/git packages to migrate.");
    return;
  }

  console.log(`${entries.length} package(s) to migrate.`);
  for (const entry of entries) {
    await migrateEntry(entry);
  }
}

async function migrateEntry(entry: ConfiguredEntry) {
  const parsed = parseSource(entry.source) as Exclude<ParsedSource, { kind: "local" }>;
  const fetched = fetchSource(parsed);
  const audit = auditPackage(entry.source, fetched.auditPath);
  printAudit(entry.source, audit);

  if (!(await confirm("Migrate?"))) {
    console.log("Skipped.");
    return;
  }

  const snapshotPath = copyToStore(entry.scope, fetched, entry.source, audit, parsed);
  installSnapshotDependencies(snapshotPath);
  replaceSettingsSource(entry.scope, entry.source, snapshotPath);
  removeOriginalInstall(entry.scope, parsed);
  console.log(`Migrated audited snapshot: ${displayLocalSource(entry.scope, snapshotPath)}`);
}

async function updateManagedEntry(entry: ManagedEntry, updateAlreadyChecked = false) {
  const parsed = parseSource(entry.manifest.source);
  if (parsed.kind === "local" || parsed.pinned) {
    console.log(`${entry.manifest.source} pinned/local, skipped.`);
    return;
  }
  if (!updateAlreadyChecked && !hasAvailableUpdate(entry, parsed)) {
    console.log(`${entry.manifest.source} is current.`);
    return;
  }

  const fetched = fetchSource(parsed);
  const audit = auditPackage(entry.manifest.source, fetched.auditPath);
  printAudit(entry.manifest.source, audit);

  if (!(await confirm("Update?"))) {
    console.log("Skipped.");
    return;
  }

  const nextSnapshotPath = copyToStore(entry.scope, fetched, entry.manifest.source, audit, parsed);
  installSnapshotDependencies(nextSnapshotPath);
  replaceSettingsSource(entry.scope, entry.source, nextSnapshotPath);
  console.log(`Updated audited snapshot: ${displayLocalSource(entry.scope, nextSnapshotPath)}`);
}

function parseInstallArgs(rawArgs: string[]) {
  let local = false;
  let source: string | undefined;
  for (const arg of rawArgs) {
    if (arg === "-l" || arg === "--local") {
      local = true;
    } else if (!source) {
      source = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!source) {
    throw new Error("Usage: pi-audit install <source> [-l|--local]");
  }
  return { source, local };
}

function fetchSource(source: ParsedSource) {
  const root = mkdtempSync(join(tmpdir(), "pi-audit-"));
  if (source.kind === "npm") {
    return fetchNpm(source, root);
  }
  if (source.kind === "git") {
    return fetchGit(source, root);
  }
  return fetchLocal(source, root);
}

function fetchNpm(source: Extract<ParsedSource, { kind: "npm" }>, root: string) {
  const commandParts = npmCommand();
  const executable = commandParts[0];
  if (!executable) {
    throw new Error("Invalid npmCommand: empty command");
  }
  run(executable, [...commandParts.slice(1), "pack", source.spec, "--pack-destination", root, "--json"], process.cwd());
  const tarball = readdirSync(root).find((file) => file.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(`npm pack did not produce tarball for ${source.source}`);
  }
  run("tar", ["-xzf", join(root, tarball), "-C", root], process.cwd());
  const auditPath = join(root, "package");
  if (!existsSync(auditPath)) {
    throw new Error(`npm tarball has no package directory: ${source.source}`);
  }
  return { auditPath, version: readNpmPackageVersion(auditPath) };
}

function fetchGit(source: Extract<ParsedSource, { kind: "git" }>, root: string) {
  const auditPath = join(root, "repo");
  run("git", ["clone", source.repo, auditPath], process.cwd(), { GIT_TERMINAL_PROMPT: "0" });
  if (source.ref) {
    run("git", ["checkout", source.ref], auditPath);
  }
  const gitHead = run("git", ["rev-parse", "HEAD"], auditPath).trim();
  return { auditPath, gitHead };
}

function fetchLocal(source: Extract<ParsedSource, { kind: "local" }>, root: string) {
  const resolved = resolveLocalSource(source.path, process.cwd());
  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  const stat = statSync(resolved);
  const auditPath = join(root, basename(resolved));
  if (stat.isDirectory()) {
    cpSync(resolved, auditPath, { recursive: true, dereference: false, filter: shouldCopyPath });
  } else {
    copyFileSync(resolved, auditPath);
  }
  return { auditPath };
}


function auditPackage(source: string, auditPath: string): AuditResult {
  console.log(`Auditing ${source}...`);
  const prompt = `You are auditing a Pi package before install.

Source: ${source}
Path: ${auditPath}

Use only read/search/list tools. Do not execute package code. Check extensions, skills, prompts, themes, package.json scripts, dependency risk, credential/network/file access, obfuscation, and install-time surprises.

Return ONLY compact JSON matching this schema:
{"recommendation":"yes|no|maybe","report":"max 200 chars"}`;

  const result = spawnSync("pi", [
    "-p",
    "--provider",
    "openai-codex",
    "--model",
    "gpt-5.5",
    "--thinking",
    "medium",
    "--no-session",
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    "read,grep,find,ls",
    prompt,
  ], { encoding: "utf-8", cwd: process.cwd() });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `pi audit failed with status ${result.status}`);
  }

  return parseAuditResult(result.stdout);
}

function parseAuditResult(outputText: string): AuditResult {
  const match = outputText.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Pi audit returned no JSON: ${outputText.trim()}`);
  }

  const parsed = JSON.parse(match[0]) as Partial<AuditResult>;
  if (parsed.recommendation !== "yes" && parsed.recommendation !== "no" && parsed.recommendation !== "maybe") {
    throw new Error("Pi audit JSON has invalid recommendation");
  }
  if (typeof parsed.report !== "string" || parsed.report.length === 0) {
    throw new Error("Pi audit JSON has invalid report");
  }

  return {
    recommendation: parsed.recommendation,
    report: parsed.report,
  };
}

function copyToStore(scope: Scope, fetched: FetchedSource, source: string, audit: AuditResult, parsed: ParsedSource) {
  const auditPath = fetched.auditPath;
  const storeRoot = getStoreRoot(scope);
  mkdirSync(storeRoot, { recursive: true });

  const snapshotPath = getSnapshotPath(scope, parsed, auditPath);
  mkdirSync(dirname(snapshotPath), { recursive: true });
  if (existsSync(snapshotPath)) {
    rmSync(snapshotPath, { recursive: true, force: true });
  }

  const stat = statSync(auditPath);
  if (stat.isDirectory()) {
    cpSync(auditPath, snapshotPath, { recursive: true, dereference: false, filter: shouldCopyPath });
  } else {
    copyFileSync(auditPath, snapshotPath);
  }

  const manifest: Manifest = {
    source,
    kind: parsed.kind,
    identity: identityForSource(parsed),
    installedAt: new Date().toISOString(),
    audit,
    version: fetched.version,
    gitHead: fetched.gitHead,
  };
  const manifestPath = stat.isDirectory()
    ? join(snapshotPath, ".pi-audit.json")
    : `${snapshotPath}.pi-audit.json`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return snapshotPath;
}

function installSnapshotDependencies(snapshotPath: string) {
  if (!statSync(snapshotPath).isDirectory() || !existsSync(join(snapshotPath, "package.json"))) {
    return;
  }

  const commandParts = npmCommand();
  const executable = commandParts[0];
  if (!executable) {
    throw new Error("Invalid npmCommand: empty command");
  }
  console.log(`Installing dependencies in ${snapshotPath}...`);
  run(executable, [...commandParts.slice(1), "install", "--omit=dev", "--ignore-scripts"], snapshotPath);
}

function upsertSettingsEntry(scope: Scope, snapshotPath: string, identity: string) {
  const settings = readSettings(scope);
  const packages = settings.packages ?? [];
  const localSource = displayLocalSource(scope, snapshotPath);
  let replaced = false;

  settings.packages = packages.map((entry) => {
    const source = entrySource(entry);
    const existingManifest = readManifest(resolveLocalSource(source, getSettingsBaseDir(scope)));
    if (existingManifest?.identity !== identity) {
      return entry;
    }

    replaced = true;
    if (typeof entry === "string") {
      return localSource;
    }
    return { ...entry, source: localSource };
  });

  if (!replaced) {
    settings.packages = [...settings.packages, localSource];
  }

  writeSettings(scope, settings);
}

function replaceSettingsSource(scope: Scope, currentSource: string, nextSnapshotPath: string) {
  const settings = readSettings(scope);
  const packages = settings.packages ?? [];
  const nextSource = displayLocalSource(scope, nextSnapshotPath);
  let replaced = false;
  settings.packages = packages.map((entry) => {
    const source = entrySource(entry);
    if (source !== currentSource) {
      return entry;
    }
    replaced = true;
    if (typeof entry === "string") {
      return nextSource;
    }
    return { ...entry, source: nextSource };
  });
  if (!replaced) {
    throw new Error(`Settings entry disappeared: ${currentSource}`);
  }
  writeSettings(scope, settings);
}

function findConfiguredEntries(): ConfiguredEntry[] {
  return ["project", "global"].flatMap((scope) => {
    const typedScope = scope as Scope;
    const settings = readSettings(typedScope);
    return (settings.packages ?? []).map((entry) => ({
      scope: typedScope,
      entry,
      source: entrySource(entry),
    }));
  });
}

function findMigratableEntries() {
  return findConfiguredEntries().filter((entry) => {
    const parsed = parseSource(entry.source);
    if (parsed.kind === "local") {
      return false;
    }
    if (parsed.kind === "npm" && isPiAiPackage(parsed.name)) {
      return false;
    }
    return true;
  });
}

function findManagedEntries(): ManagedEntry[] {
  return ["project", "global"].flatMap((scope) => findManagedEntriesInScope(scope as Scope));
}

function findManagedEntriesInScope(scope: Scope): ManagedEntry[] {
  const settingsPath = getSettingsPath(scope);
  const baseDir = getSettingsBaseDir(scope);
  const settings = readSettings(scope);
  const packages = settings.packages ?? [];
  const managed: ManagedEntry[] = [];

  for (const entry of packages) {
    const source = entrySource(entry);
    const snapshotPath = resolveLocalSource(source, baseDir);
    const manifest = readManifest(snapshotPath);
    if (!manifest) {
      continue;
    }
    managed.push({ scope, entry, source, settingsPath, baseDir, snapshotPath, manifest });
  }

  return managed;
}

function readManifest(snapshotPath: string): Manifest | undefined {
  const stat = statSyncIfExists(snapshotPath);
  const manifestPaths = stat?.isDirectory()
    ? [join(snapshotPath, ".pi-audit.json"), join(snapshotPath, ".pi-audit-install.json")]
    : [`${snapshotPath}.pi-audit.json`, `${snapshotPath}.pi-audit-install.json`];
  const manifestPath = manifestPaths.find((path) => existsSync(path));
  if (!manifestPath) {
    return undefined;
  }
  return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
}

function hasAvailableUpdate(entry: ManagedEntry, parsed: Exclude<ParsedSource, { kind: "local" }>) {
  if (parsed.kind === "npm") {
    const installedVersion = entry.manifest.version ?? readNpmPackageVersion(entry.snapshotPath);
    if (!installedVersion) {
      return true;
    }
    return getLatestNpmVersion(parsed.name) !== installedVersion;
  }

  const installedHead = entry.manifest.gitHead;
  if (!installedHead) {
    return true;
  }
  return getRemoteGitHead(parsed) !== installedHead;
}

function readNpmPackageVersion(packagePath: string) {
  const packageJsonPath = join(packagePath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: string };
  return packageJson.version;
}

function getLatestNpmVersion(packageName: string) {
  const commandParts = npmCommand();
  const executable = commandParts[0];
  if (!executable) {
    throw new Error("Invalid npmCommand: empty command");
  }
  const stdout = run(executable, [...commandParts.slice(1), "view", packageName, "version", "--json"], process.cwd());
  const raw = stdout.trim();
  if (!raw) {
    throw new Error(`Empty npm view response for ${packageName}`);
  }
  const version = JSON.parse(raw) as unknown;
  if (typeof version !== "string") {
    throw new Error(`Invalid npm view response for ${packageName}`);
  }
  return version;
}

function getRemoteGitHead(source: Extract<ParsedSource, { kind: "git" }>) {
  const stdout = run("git", ["ls-remote", source.repo, "HEAD"], process.cwd(), { GIT_TERMINAL_PROMPT: "0" });
  const match = stdout.match(/^([0-9a-f]{40})\s+HEAD$/m);
  if (!match?.[1]) {
    throw new Error(`Failed to determine remote HEAD for ${source.source}`);
  }
  return match[1];
}

function parseSource(source: string): ParsedSource {
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    const parsed = parseNpmSpec(spec);
    return { kind: "npm", source, spec, name: parsed.name, pinned: Boolean(parsed.version) };
  }

  const git = parseGitSource(source);
  if (git) {
    return { kind: "git", source, ...git, pinned: Boolean(git.ref) };
  }

  return { kind: "local", source, path: source, pinned: false };
}

function parseNpmSpec(spec: string) {
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  if (!match) {
    return { name: spec, version: undefined };
  }
  return { name: match[1] ?? spec, version: match[2] };
}

function parseGitSource(source: string): { repo: string; host: string; path: string; ref?: string } | undefined {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  const raw = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;
  if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(raw)) {
    return undefined;
  }

  const { repo, ref } = splitGitRef(raw);
  const normalizedRepo = normalizeGitRepo(repo, hasGitPrefix);
  const hostAndPath = gitHostAndPath(normalizedRepo);
  if (!hostAndPath) {
    return undefined;
  }
  return { repo: normalizedRepo, host: hostAndPath.host, path: hostAndPath.path, ref };
}

function splitGitRef(value: string) {
  const scpLike = value.match(/^git@([^:]+):(.+)$/);
  if (scpLike) {
    const path = scpLike[2] ?? "";
    const index = path.indexOf("@");
    if (index < 0) {
      return { repo: value, ref: undefined };
    }
    return { repo: `git@${scpLike[1]}:${path.slice(0, index)}`, ref: path.slice(index + 1) || undefined };
  }

  if (value.includes("://")) {
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/^\/+/, "");
    const index = path.indexOf("@");
    if (index < 0) {
      return { repo: value, ref: undefined };
    }
    parsed.pathname = `/${path.slice(0, index)}`;
    return { repo: parsed.toString().replace(/\/$/, ""), ref: path.slice(index + 1) || undefined };
  }

  const slash = value.indexOf("/");
  if (slash < 0) {
    return { repo: value, ref: undefined };
  }
  const host = value.slice(0, slash);
  const path = value.slice(slash + 1);
  const index = path.indexOf("@");
  if (index < 0) {
    return { repo: value, ref: undefined };
  }
  return { repo: `${host}/${path.slice(0, index)}`, ref: path.slice(index + 1) || undefined };
}

function normalizeGitRepo(repo: string, hasGitPrefix: boolean) {
  if (/^(https?|ssh|git):\/\//i.test(repo) || repo.startsWith("git@")) {
    return repo;
  }
  if (hasGitPrefix) {
    return `https://${repo}`;
  }
  return repo;
}

function gitHostAndPath(repo: string) {
  const scpLike = repo.match(/^git@([^:]+):(.+)$/);
  if (scpLike) {
    return cleanGitPath(scpLike[1] ?? "", scpLike[2] ?? "");
  }
  if (/^(https?|ssh|git):\/\//i.test(repo)) {
    const parsed = new URL(repo);
    return cleanGitPath(parsed.hostname, parsed.pathname.replace(/^\/+/, ""));
  }
  return undefined;
}

function cleanGitPath(host: string, rawPath: string) {
  const path = rawPath.replace(/\.git$/, "").replace(/^\/+/, "");
  if (!host || path.split("/").length < 2) {
    return undefined;
  }
  return { host, path };
}

function identityForSource(source: ParsedSource) {
  if (source.kind === "npm") {
    return `npm:${source.name}`;
  }
  if (source.kind === "git") {
    return `git:${source.host}/${source.path}`;
  }
  return `local:${resolveLocalSource(source.path, process.cwd())}`;
}

function matchesPackage(inputValue: string, manifest: Manifest) {
  const parsed = parseSource(inputValue);
  const inputIdentity = identityForSource(parsed);
  if (inputIdentity === manifest.identity) {
    return true;
  }
  if (manifest.identity.startsWith("npm:") && inputValue === manifest.identity.slice(4)) {
    return true;
  }
  if (manifest.identity.startsWith("git:")) {
    const shorthand = manifest.identity.slice(4);
    return inputValue === shorthand || inputValue === shorthand.split("/").slice(1).join("/");
  }
  return false;
}

function isPiAiPackage(packageName: string) {
  return packageName === "pi-ai" || packageName === "@mariozechner/pi-ai" || packageName.endsWith("/pi-ai");
}

function removeOriginalInstall(scope: Scope, source: Exclude<ParsedSource, { kind: "local" }>) {
  if (source.kind === "npm") {
    const commandParts = npmCommand();
    const executable = commandParts[0];
    if (!executable) {
      throw new Error("Invalid npmCommand: empty command");
    }
    if (scope === "global") {
      run(executable, [...commandParts.slice(1), "uninstall", "-g", source.name], process.cwd());
      return;
    }
    const installRoot = join(process.cwd(), ".pi", "npm");
    if (existsSync(installRoot)) {
      run(executable, [...commandParts.slice(1), "uninstall", source.name, "--prefix", installRoot], process.cwd());
    }
    return;
  }

  const installRoot = scope === "project"
    ? join(process.cwd(), ".pi", "git")
    : join(getAgentDir(), "git");
  const target = join(installRoot, source.host, source.path);
  if (!isInside(target, installRoot)) {
    throw new Error(`Refusing to remove path outside git install root: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function readSettings(scope: Scope): Settings {
  const path = getSettingsPath(scope);
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Settings;
}

function writeSettings(scope: Scope, settings: Settings) {
  const path = getSettingsPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function npmCommand() {
  const project = readSettings("project").npmCommand;
  if (project && project.length > 0) {
    return project;
  }
  const global = readSettings("global").npmCommand;
  if (global && global.length > 0) {
    return global;
  }
  return ["npm"];
}

function getSettingsPath(scope: Scope) {
  return scope === "project" ? join(process.cwd(), ".pi", "settings.json") : join(getAgentDir(), "settings.json");
}

function getSettingsBaseDir(scope: Scope) {
  return scope === "project" ? join(process.cwd(), ".pi") : getAgentDir();
}

function getSnapshotPath(scope: Scope, source: ParsedSource, auditPath: string) {
  return join(getStoreRoot(scope), packageStorePath(source, auditPath));
}

function getStoreRoot(scope: Scope) {
  return join(getSettingsBaseDir(scope), "audited-packages");
}

function getAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return expandHome(envDir);
  }
  return join(homedir(), ".pi", "agent");
}

function displayLocalSource(scope: Scope, snapshotPath: string) {
  const rel = relative(getSettingsBaseDir(scope), snapshotPath);
  return rel || ".";
}

function isInside(path: string, parent: string) {
  const rel = relative(resolve(parent), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveLocalSource(source: string, baseDir: string) {
  const expanded = expandHome(source.trim());
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolve(baseDir, expanded);
}

function expandHome(path: string) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function entrySource(entry: PackageEntry) {
  return typeof entry === "string" ? entry : entry.source;
}

function packageStorePath(source: ParsedSource, auditPath: string) {
  if (source.kind === "npm") {
    return join("npm", ...source.name.split("/"));
  }
  if (source.kind === "git") {
    return join("git", source.host, ...source.path.split("/"));
  }
  return join("local", safePathSegment(basename(source.path)));
}

function safePathSegment(value: string) {
  const safe = value.replace(/[^a-zA-Z0-9._@-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "package";
}

function printAudit(source: string, audit: AuditResult) {
  console.log(`${source} → ${audit.recommendation} — ${audit.report}`);
}

async function confirm(question: string) {
  const rl = createInterface({ input, output });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

function run(commandName: string, commandArgs: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(commandName, commandArgs, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${commandName} ${commandArgs.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

function shouldCopyPath(path: string) {
  return !path.split(/[\\/]/).includes(".git");
}

function statSyncIfExists(path: string) {
  if (!existsSync(path)) {
    return undefined;
  }
  return statSync(path);
}
