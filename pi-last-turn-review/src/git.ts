import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents } from './types.js'

interface ChangedPath {
  status: ChangeStatus
  oldPath: string | null
  newPath: string | null
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec('git', args, { cwd: repoRoot })
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`
    throw new Error(message)
  }
  return result.stdout
}

async function runGitAllowFailure(
  pi: ExtensionAPI,
  repoRoot: string,
  args: string[],
): Promise<string> {
  const result = await pi.exec('git', args, { cwd: repoRoot })
  if (result.code !== 0) return ''
  return result.stdout
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec('git', ['rev-parse', '--show-toplevel'], { cwd })
  if (result.code !== 0) {
    throw new Error('Not inside a Git repository.')
  }
  return result.stdout.trim()
}

export async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot })
  return result.code === 0
}

function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)

  const changes: ChangedPath[] = []

  for (const line of lines) {
    const parts = line.split('\t')
    const rawStatus = parts[0] ?? ''
    const code = rawStatus[0]

    if (code === 'R') {
      const oldPath = parts[1] ?? null
      const newPath = parts[2] ?? null
      if (oldPath != null && newPath != null) {
        changes.push({ status: 'renamed', oldPath, newPath })
      }
      continue
    }

    if (code === 'M') {
      const path = parts[1] ?? null
      if (path != null) {
        changes.push({ status: 'modified', oldPath: path, newPath: path })
      }
      continue
    }

    if (code === 'A') {
      const path = parts[1] ?? null
      if (path != null) {
        changes.push({ status: 'added', oldPath: null, newPath: path })
      }
      continue
    }

    if (code === 'D') {
      const path = parts[1] ?? null
      if (path != null) {
        changes.push({ status: 'deleted', oldPath: path, newPath: null })
      }
    }
  }

  return changes
}

function parsePathList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

function parseUntrackedPaths(output: string): ChangedPath[] {
  return parsePathList(output).map(path => ({
    status: 'added' as const,
    oldPath: null,
    newPath: path,
  }))
}

function mergeChangedPaths(primary: ChangedPath[], secondary: ChangedPath[]): ChangedPath[] {
  const seen = new Set(
    primary.map(change => `${change.status}:${change.oldPath ?? ''}:${change.newPath ?? ''}`),
  )
  const merged = [...primary]

  for (const change of secondary) {
    const key = `${change.status}:${change.oldPath ?? ''}:${change.newPath ?? ''}`
    if (seen.has(key)) continue
    merged.push(change)
    seen.add(key)
  }

  return merged
}

function isReviewableFilePath(path: string): boolean {
  const lowerPath = path.toLowerCase()
  const fileName = lowerPath.split('/').pop() ?? lowerPath
  const extension = extname(fileName)

  if (fileName.length === 0) return false

  const binaryExtensions = new Set([
    '.7z',
    '.a',
    '.avi',
    '.avif',
    '.bin',
    '.bmp',
    '.class',
    '.dll',
    '.dylib',
    '.eot',
    '.exe',
    '.gif',
    '.gz',
    '.ico',
    '.jar',
    '.jpeg',
    '.jpg',
    '.lockb',
    '.map',
    '.mov',
    '.mp3',
    '.mp4',
    '.o',
    '.otf',
    '.pdf',
    '.png',
    '.pyc',
    '.so',
    '.svgz',
    '.tar',
    '.ttf',
    '.wasm',
    '.webm',
    '.webp',
    '.woff',
    '.woff2',
    '.zip',
  ])

  if (binaryExtensions.has(extension)) return false
  if (fileName.endsWith('.min.js') || fileName.endsWith('.min.css')) return false

  return true
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === 'renamed') {
    return `${change.oldPath ?? ''} -> ${change.newPath ?? ''}`
  }
  return change.newPath ?? change.oldPath ?? '(unknown)'
}

function toComparison(change: ChangedPath): ReviewFileComparison {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
  }
}

function buildReviewFile(change: ChangedPath): ReviewFile {
  const comparison = toComparison(change)
  const path = change.newPath ?? change.oldPath ?? comparison.displayPath

  return {
    id: [path, comparison.displayPath, comparison.status].join('::'),
    path,
    comparison,
  }
}

function toReviewFiles(changes: ChangedPath[]): ReviewFile[] {
  return changes
    .filter(change => isReviewableFilePath(change.newPath ?? change.oldPath ?? ''))
    .map(buildReviewFile)
    .sort((a, b) => a.path.localeCompare(b.path))
}

export async function getLastTurnReviewFiles(
  pi: ExtensionAPI,
  repoRoot: string,
  beforeTree: string,
  afterTree: string,
): Promise<ReviewFile[]> {
  if (beforeTree === afterTree) return []

  const output = await runGit(pi, repoRoot, [
    'diff',
    '--find-renames',
    '-M',
    '--name-status',
    beforeTree,
    afterTree,
    '--',
  ])
  return toReviewFiles(parseNameStatus(output))
}

export async function getGitChangesReviewFiles(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<ReviewFile[]> {
  if (await hasHead(pi, repoRoot)) {
    const trackedOutput = await runGit(pi, repoRoot, [
      'diff',
      '--find-renames',
      '-M',
      '--name-status',
      'HEAD',
      '--',
    ])
    const untrackedOutput = await runGitAllowFailure(pi, repoRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
    ])
    return toReviewFiles(
      mergeChangedPaths(parseNameStatus(trackedOutput), parseUntrackedPaths(untrackedOutput)),
    )
  }

  const addedOutput = await runGitAllowFailure(pi, repoRoot, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
  return toReviewFiles(parseUntrackedPaths(addedOutput))
}

async function getRevisionContent(
  pi: ExtensionAPI,
  repoRoot: string,
  revision: string,
  path: string,
): Promise<string> {
  const result = await pi.exec('git', ['show', `${revision}:${path}`], { cwd: repoRoot })
  if (result.code !== 0) return ''
  return result.stdout
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), 'utf8')
  } catch {
    return ''
  }
}

export async function loadLastTurnFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  beforeTree: string,
  afterTree: string,
  file: ReviewFile,
): Promise<ReviewFileContents> {
  const comparison = file.comparison
  const originalContent =
    comparison.oldPath == null
      ? ''
      : await getRevisionContent(pi, repoRoot, beforeTree, comparison.oldPath)
  const modifiedContent =
    comparison.newPath == null
      ? ''
      : await getRevisionContent(pi, repoRoot, afterTree, comparison.newPath)

  return { originalContent, modifiedContent }
}

export async function loadGitChangesFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  file: ReviewFile,
): Promise<ReviewFileContents> {
  const comparison = file.comparison
  const originalContent =
    comparison.oldPath == null
      ? ''
      : await getRevisionContent(pi, repoRoot, 'HEAD', comparison.oldPath)
  const modifiedContent =
    comparison.newPath == null ? '' : await getWorkingTreeContent(repoRoot, comparison.newPath)

  return { originalContent, modifiedContent }
}
