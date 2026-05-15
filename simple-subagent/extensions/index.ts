import { spawn, spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

const SIMPLE_SUBAGENT_PROCESS_ENV = 'PI_SIMPLE_SUBAGENT'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

type PiJsonEvent = {
  type?: string
  message?: unknown
  toolName?: string
  args?: unknown
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: 'pi', args }
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function truncateLine(text: string, max = 80): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max)
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function getCwdLabel(cwd: string): string {
  const name = path.basename(cwd)
  return name || cwd
}

function wrapPreview(text: string, maxLineLength = 100, maxLines = 3): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length === 0) return ['...']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxLineLength) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = word
    if (lines.length === maxLines - 1) break
  }
  if (current && lines.length < maxLines) lines.push(current)
  const consumed = lines.join(' ').split(' ').filter(Boolean).length
  if (consumed < words.length && lines.length > 0)
    lines[lines.length - 1] = `${lines[lines.length - 1]}...`
  return lines
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type === 'text') return part.text
    }
  }
  return ''
}

type ToolDisplayItem = { name: string; args: Record<string, unknown> }

type LiveDisplayEvent = { type: 'tool'; agent: string; tool: ToolDisplayItem }

type SubagentStatus = 'queued' | 'running' | 'done' | 'failed'

type SubagentResultDetails = {
  liveEvents?: LiveDisplayEvent[]
  agents: Array<{
    name: string
    thinking: ThinkingLevel
    prompt?: string
    cwd?: string
    sessionKey?: string
    status?: SubagentStatus
    exitCode?: number
    outputPath?: string
    tools?: ToolDisplayItem[]
  }>
}

function asToolArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
}

function cloneToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(args)) as Record<string, unknown>
  } catch {
    return { ...args }
  }
}

function getToolDisplayItems(messages: Message[]): ToolDisplayItem[] {
  const items: ToolDisplayItem[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue
      const toolPart = part as { name?: string; arguments?: unknown }
      if (toolPart.name) items.push({ name: toolPart.name, args: asToolArgs(toolPart.arguments) })
    }
  }
  return items
}

function getEventToolDisplayItem(event: PiJsonEvent): ToolDisplayItem | undefined {
  if (event.type !== 'tool_execution_start' || !event.toolName) return undefined
  return { name: event.toolName, args: asToolArgs(event.args) }
}

function dedupeToolDisplayItems(items: ToolDisplayItem[]): ToolDisplayItem[] {
  const deduped: ToolDisplayItem[] = []
  let previous = ''
  for (const item of items) {
    const key = `${item.name}:${JSON.stringify(item.args)}`
    if (key === previous) continue
    previous = key
    deduped.push(item)
  }
  return deduped
}

function shortenPathForDisplay(filePath: string): string {
  const home = os.homedir()
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}

function getToolDisplayName(toolName: string): string {
  switch (toolName) {
    case 'bash':
      return 'Ran'
    case 'read':
      return 'Read'
    case 'write':
      return 'Wrote'
    case 'edit':
      return 'Edited'
    case 'web_search':
    case 'code_search':
      return 'Searched'
    case 'fetch_content':
      return 'Fetched'
    default:
      return toolName.replace(/_/g, ' ').replace(/^./, char => char.toUpperCase())
  }
}

function formatToolTarget(toolName: string, args: Record<string, unknown>, theme: any): string {
  switch (toolName) {
    case 'bash': {
      const command = typeof args.command === 'string' ? args.command : '...'
      return theme.fg('toolOutput', truncateLine(command, 120))
    }
    case 'read':
    case 'write':
    case 'edit': {
      const rawPath =
        typeof args.path === 'string'
          ? args.path
          : typeof args.file_path === 'string'
            ? args.file_path
            : '...'
      let text = theme.fg('toolOutput', shortenPathForDisplay(rawPath))
      if (toolName === 'read') {
        const offset = typeof args.offset === 'number' ? args.offset : undefined
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        if (offset !== undefined || limit !== undefined) {
          const startLine = offset ?? 1
          const endLine = limit === undefined ? '' : startLine + limit - 1
          text += theme.fg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`)
        }
      }
      return text
    }
    case 'web_search':
    case 'code_search': {
      const query =
        typeof args.query === 'string'
          ? args.query
          : Array.isArray(args.queries) && typeof args.queries[0] === 'string'
            ? args.queries[0]
            : '...'
      return theme.fg('toolOutput', truncateLine(query, 120))
    }
    case 'fetch_content': {
      const url =
        typeof args.url === 'string'
          ? args.url
          : Array.isArray(args.urls) && typeof args.urls[0] === 'string'
            ? args.urls[0]
            : '...'
      return theme.fg('toolOutput', truncateLine(url, 120))
    }
    default:
      return theme.fg('dim', truncateLine(JSON.stringify(args), 120))
  }
}

type AgentDisplayInfo = {
  name: string
  thinking: ThinkingLevel
  prompt?: string
  cwd?: string
  sessionKey?: string
  status?: SubagentStatus
}

function renderAgentsOverview(agents: AgentDisplayInfo[], theme: any, showRuntime = false): string {
  const doneCount = agents.filter(agent => agent.status === 'done').length
  const runningCount = agents.filter(agent => agent.status === 'running').length
  const failedCount = agents.filter(agent => agent.status === 'failed').length
  let header = `${theme.fg('toolTitle', theme.bold('runSubAgents'))} ${theme.fg('accent', `${agents.length} agent${agents.length === 1 ? '' : 's'}`)}`
  if (showRuntime) {
    if (doneCount > 0) header += ` ${theme.fg('success', `${doneCount} done`)}`
    if (runningCount > 0) header += ` ${theme.fg('warning', `${runningCount} running`)}`
    if (failedCount > 0) header += ` ${theme.fg('error', `${failedCount} failed`)}`
  }

  const lines = [header]
  agents.forEach((agent, index) => {
    const status = agent.status || 'queued'
    const icon = showRuntime
      ? status === 'done'
        ? `${theme.fg('success', '✓')} `
        : status === 'failed'
          ? `${theme.fg('error', '✗')} `
          : status === 'running'
            ? `${theme.fg('warning', '●')} `
            : `${theme.fg('muted', '○')} `
      : ''
    const session = agent.sessionKey ? `session:${agent.sessionKey}` : 'ephemeral'
    const meta = showRuntime ? `${status} · ${session}` : session
    lines.push(
      '',
      `${theme.fg('muted', `${index + 1}.`)} ${icon}${theme.fg('toolTitle', theme.bold(agent.name))} ${theme.fg('warning', `[${agent.thinking}]`)} ${theme.fg('muted', meta)}`,
    )
    if (agent.cwd)
      lines.push(`   ${theme.fg('muted', 'cwd')} ${theme.fg('accent', getCwdLabel(agent.cwd))}`)
    if (agent.prompt) {
      lines.push(`   ${theme.fg('muted', 'task')}`)
      for (const line of wrapPreview(agent.prompt, 110, 3)) {
        lines.push(`     ${theme.fg('toolOutput', line)}`)
      }
    }
  })
  return lines.join('\n')
}

function renderLiveCompact(agents: AgentDisplayInfo[], theme: any): string {
  const doneCount = agents.filter(agent => agent.status === 'done').length
  const runningCount = agents.filter(agent => agent.status === 'running').length
  const failedCount = agents.filter(agent => agent.status === 'failed').length
  let text = `${theme.fg('toolTitle', theme.bold('runSubAgents'))} ${theme.fg('accent', `${agents.length} agent${agents.length === 1 ? '' : 's'}`)}`
  if (doneCount) text += ` ${theme.fg('success', `${doneCount} done`)}`
  if (runningCount) text += ` ${theme.fg('warning', `${runningCount} running`)}`
  if (failedCount) text += ` ${theme.fg('error', `${failedCount} failed`)}`
  text += `\n${agents
    .map(agent => {
      const status = agent.status || 'queued'
      const prefix =
        status === 'done'
          ? theme.fg('success', '✓')
          : status === 'failed'
            ? theme.fg('error', '✗')
            : status === 'running'
              ? theme.fg('warning', '●')
              : theme.fg('muted', '○')
      return `${prefix} ${theme.fg('toolTitle', agent.name)}`
    })
    .join(' ')}`
  return text
}

const idChars = 'abcdefghijklmnopqrstuvwxyz0123456789'

function getRandomId(): string {
  let id = ''
  for (let i = 0; i < 10; i++) id += idChars[randomInt(idChars.length)]
  return id
}

function createRunDirectory(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const runDirectory = path.join(os.tmpdir(), getRandomId())
    try {
      fs.mkdirSync(runDirectory)
      return runDirectory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Failed to create random subagent directory')
}

function sanitizeFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!sanitized) throw new Error('Agent name is empty after sanitizing')
  return sanitized
}

function getSubagentSessionPath(cwd: string, sessionKey: string): string {
  const sessionDirectory = path.join(cwd, '.pi', 'subagents')
  fs.mkdirSync(sessionDirectory, { recursive: true })
  return path.join(sessionDirectory, `${sanitizeFileName(sessionKey)}.jsonl`)
}

async function runPiJsonProcess(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onEvent: (event: PiJsonEvent) => void,
): Promise<{ exitCode: number; stderr: string; aborted: boolean }> {
  return await new Promise(resolve => {
    const invocation = getPiInvocation(args)
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, [SIMPLE_SUBAGENT_PROCESS_ENV]: '1' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    let buffer = ''
    let aborted = false
    let settled = false

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      resolve({ exitCode, stderr, aborted })
    }

    const processLine = (line: string) => {
      if (!line.trim()) return
      try {
        onEvent(JSON.parse(line) as PiJsonEvent)
      } catch {
        // ignore malformed lines
      }
    }

    const abortHandler = () => {
      aborted = true
      proc.kill('SIGTERM')
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL')
      }, 5000).unref()
    }

    proc.stdout.on('data', data => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) processLine(line)
    })

    proc.stderr.on('data', data => {
      stderr += data.toString()
    })

    proc.on('error', error => {
      stderr += `${stderr ? '\n' : ''}${error.message}`
      finish(1)
    })

    proc.on('close', code => {
      if (buffer.trim()) processLine(buffer)
      finish(code ?? 0)
    })

    if (signal) {
      if (signal.aborted) abortHandler()
      else signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
}

function getPromptArgument(prompt: string): string {
  return prompt.startsWith('-') ? `\n${prompt}` : prompt
}

function buildPiShellCommand(prompt: string, model: string, thinking: ThinkingLevel): string {
  return ['pi', '--model', model, '--thinking', thinking, getPromptArgument(prompt)]
    .map(shellQuote)
    .join(' ')
}

function openCmuxSplit(prompt: string, model: string, thinking: ThinkingLevel, cwd: string) {
  const splitResult = spawnSync('cmux', ['--json', 'new-split', 'right'], {
    cwd,
    encoding: 'utf-8',
  })
  if (splitResult.status !== 0) {
    throw new Error(
      splitResult.stderr.trim() || splitResult.stdout.trim() || 'cmux new-split failed',
    )
  }

  const splitOutput = splitResult.stdout.trim()
  const surfaceRef = splitOutput
    ? (JSON.parse(splitOutput) as { surface_ref?: string }).surface_ref
    : undefined
  if (!surfaceRef) {
    throw new Error('cmux new-split did not return surface_ref')
  }

  const command = `cd ${shellQuote(cwd)} && ${buildPiShellCommand(prompt, model, thinking)}`
  const sendResult = spawnSync('cmux', ['send', '--surface', surfaceRef, `${command}\n`], {
    cwd,
    encoding: 'utf-8',
  })
  if (sendResult.status !== 0) {
    throw new Error(sendResult.stderr.trim() || sendResult.stdout.trim() || 'cmux send failed')
  }
}

function openTmuxSplit(prompt: string, model: string, thinking: ThinkingLevel, cwd: string) {
  const command = buildPiShellCommand(prompt, model, thinking)
  const splitResult = spawnSync('tmux', ['split-window', '-h', '-c', cwd, command], {
    cwd,
    encoding: 'utf-8',
  })
  if (splitResult.status !== 0) {
    throw new Error(
      splitResult.stderr.trim() || splitResult.stdout.trim() || 'tmux split-window failed',
    )
  }
}

function isWarpTerminal() {
  return process.platform === 'darwin' && process.env.TERM_PROGRAM === 'WarpTerminal'
}

function appleScriptQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function openWarpSplit(prompt: string, model: string, thinking: ThinkingLevel, cwd: string) {
  const command = `cd ${shellQuote(cwd)} && ${buildPiShellCommand(prompt, model, thinking)}`
  const encodedCommand = Buffer.from(command, 'utf-8').toString('base64')
  const script = `
set encodedCommand to ${appleScriptQuote(encodedCommand)}
set subagentCommand to do shell script "printf %s " & quoted form of encodedCommand & " | /usr/bin/base64 -D"
set previousClipboard to the clipboard

try
  tell application "Warp" to activate
  delay 0.2

  tell application "System Events"
    tell process "Warp"
      keystroke "d" using command down
      delay 0.3
      set the clipboard to subagentCommand
      keystroke "v" using command down
      delay 0.5
      key code 36
    end tell
  end tell

  delay 0.2
  set the clipboard to previousClipboard
on error errorMessage number errorNumber
  set the clipboard to previousClipboard
  error errorMessage number errorNumber
end try
`

  const result = spawnSync('osascript', ['-e', script], {
    cwd,
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        'Warp split failed. Grant Accessibility permission to terminal app running pi.',
    )
  }
}

function openMuxSplit(prompt: string, model: string, thinking: ThinkingLevel, cwd: string) {
  if (process.env.CMUX_WORKSPACE_ID || process.env.CMUX_SURFACE_ID) {
    openCmuxSplit(prompt, model, thinking, cwd)
    return
  }
  if (process.env.TMUX) {
    openTmuxSplit(prompt, model, thinking, cwd)
    return
  }
  if (isWarpTerminal()) {
    openWarpSplit(prompt, model, thinking, cwd)
    return
  }

  throw new Error('Not inside cmux, tmux, or Warp')
}

async function runSubAgent(
  model: string,
  thinking: ThinkingLevel,
  prompt: string,
  cwd: string,
  sessionKey: string | undefined,
  signal: AbortSignal | undefined,
  onTool: ((tool: ToolDisplayItem) => void) | undefined,
): Promise<{ text: string; exitCode: number; tools: ToolDisplayItem[] }> {
  const messages: Message[] = []
  const tools: ToolDisplayItem[] = []
  const sessionArgs = sessionKey
    ? ['--session', getSubagentSessionPath(cwd, sessionKey)]
    : ['--no-session']
  const args = [
    '--mode',
    'json',
    '-p',
    ...sessionArgs,
    '--model',
    model,
    '--thinking',
    thinking,
    getPromptArgument(prompt),
  ]

  const result = await runPiJsonProcess(args, cwd, signal, event => {
    const tool = getEventToolDisplayItem(event)
    if (tool) {
      tools.push(tool)
      onTool?.(tool)
    }

    if (event.type !== 'message_end' || !event.message) return
    const message = event.message as Message
    messages.push(message)
  })

  if (result.aborted) {
    throw new Error('Subagent was aborted')
  }

  const finalOutput = getFinalOutput(messages).trim()

  return {
    text: finalOutput || result.stderr.trim() || '(no output)',
    exitCode: result.exitCode,
    tools: dedupeToolDisplayItems([...tools, ...getToolDisplayItems(messages)]),
  }
}

export default function (pi: ExtensionAPI) {
  if (process.env[SIMPLE_SUBAGENT_PROCESS_ENV] === '1') return

  pi.registerCommand('runSubAgent', {
    description: 'Open subagent in cmux, tmux, or Warp split.',
    handler: async (args, ctx) => {
      const prompt = args.trim()
      if (!prompt) {
        ctx.ui.notify('Usage: /runSubAgent <prompt>', 'warning')
        return
      }
      if (
        !(
          process.env.CMUX_WORKSPACE_ID ||
          process.env.CMUX_SURFACE_ID ||
          process.env.TMUX ||
          isWarpTerminal()
        )
      ) {
        ctx.ui.notify('Not inside cmux, tmux, or Warp', 'error')
        return
      }
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined
      if (!model) {
        ctx.ui.notify('No caller model', 'error')
        return
      }

      try {
        openMuxSplit(prompt, model, pi.getThinkingLevel() as ThinkingLevel, ctx.cwd)
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  pi.registerTool({
    name: 'runSubAgents',
    description:
      'Run subagents. sessionKey reuses context. Returns result file paths. Valid thinking values: low|medium|high|xhigh',
    parameters: Type.Object({
      agents: Type.Array(
        Type.Object({
          thinking: Type.Union([
            Type.Literal('low'),
            Type.Literal('medium'),
            Type.Literal('high'),
            Type.Literal('xhigh'),
          ]),
          name: Type.String(),
          prompt: Type.String(),
          cwd: Type.String(),
          sessionKey: Type.Optional(Type.String()),
        }),
      ),
    }),
    renderCall(args, theme) {
      return new Text(renderAgentsOverview(args.agents, theme), 0, 0)
    },
    renderResult(result, { expanded }, theme) {
      const content = result.content[0]
      const text = content?.type === 'text' ? content.text : '(no output)'
      const details = result.details as SubagentResultDetails | undefined

      if (details?.liveEvents?.length) {
        const eventLimit = expanded ? undefined : 30
        const liveEvents = details.liveEvents || []
        const events = eventLimit ? liveEvents.slice(-eventLimit) : liveEvents
        const lines: string[] = []
        const header = renderLiveCompact(details.agents, theme)
        if (header) lines.push(header)

        if (events.length > 0) {
          lines.push('')
          if (eventLimit && liveEvents.length > eventLimit) {
            lines.push(
              theme.fg('muted', `... ${liveEvents.length - eventLimit} earlier tool calls`),
            )
          }
        }
        let previousAgent = ''
        let toolGroup: { agent: string; name: string; tools: ToolDisplayItem[] } | undefined
        const flushToolGroup = () => {
          if (!toolGroup) return
          const displayName = getToolDisplayName(toolGroup.name)
          if (toolGroup.tools.length === 1) {
            const tool = toolGroup.tools[0]
            lines.push(
              `  ${theme.fg('muted', '└')} ${theme.fg('muted', displayName)} ${formatToolTarget(tool.name, tool.args, theme)}`,
            )
          } else {
            lines.push(`  ${theme.fg('muted', '└')} ${theme.fg('muted', displayName)}`)
            for (const tool of toolGroup.tools) {
              lines.push(
                `    ${theme.fg('muted', '-')} ${formatToolTarget(tool.name, tool.args, theme)}`,
              )
            }
          }
          toolGroup = undefined
        }

        for (const event of events) {
          if (event.agent !== previousAgent) {
            flushToolGroup()
            if (previousAgent) lines.push('')
            lines.push(theme.fg('toolTitle', theme.bold(event.agent)))
            previousAgent = event.agent
          }
          if (toolGroup && toolGroup.agent === event.agent && toolGroup.name === event.tool.name) {
            toolGroup.tools.push(event.tool)
          } else {
            flushToolGroup()
            toolGroup = { agent: event.agent, name: event.tool.name, tools: [event.tool] }
          }
        }
        flushToolGroup()
        return new Text(lines.join('\n'), 0, 0)
      }

      if (details?.agents?.length) {
        return new Text(renderLiveCompact(details.agents, theme), 0, 0)
      }

      return new Text(`\n${theme.fg('muted', 'results:')}\n${text}`, 0, 0)
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined
      if (!model) throw new Error('No caller model')
      if (params.agents.length === 0) throw new Error('No agents')

      const liveEvents: LiveDisplayEvent[] = []
      const liveAgents: SubagentResultDetails['agents'] = params.agents.map(agent => ({
        name: agent.name,
        thinking: agent.thinking,
        prompt: agent.prompt,
        cwd: agent.cwd,
        sessionKey: agent.sessionKey,
        status: 'queued',
        tools: [],
      }))
      let updatesEnabled = true
      signal?.addEventListener(
        'abort',
        () => {
          updatesEnabled = false
        },
        { once: true },
      )
      const emitLiveUpdate = () => {
        if (!updatesEnabled || signal?.aborted) return
        const details: SubagentResultDetails = {
          liveEvents: liveEvents.map(event => ({
            type: 'tool',
            agent: event.agent,
            tool: { name: event.tool.name, args: cloneToolArgs(event.tool.args) },
          })),
          agents: liveAgents.map(agent => ({
            ...agent,
            tools: agent.tools?.map(tool => ({ name: tool.name, args: cloneToolArgs(tool.args) })),
          })),
        }
        try {
          onUpdate?.({
            content: [{ type: 'text', text: '(running...)' }],
            details,
          })
        } catch (error) {
          if (error instanceof Error && error.message.includes('outside active run')) {
            updatesEnabled = false
            return
          }
          throw error
        }
      }
      const emitAgentTool = (index: number, tool: ToolDisplayItem) => {
        liveAgents[index].tools ??= []
        liveAgents[index].tools.push(tool)
        liveEvents.push({ type: 'tool', agent: liveAgents[index].name, tool })
        emitLiveUpdate()
      }

      emitLiveUpdate()

      const runDirectory = createRunDirectory()
      const sessionPaths = params.agents.flatMap(agent =>
        agent.sessionKey ? [getSubagentSessionPath(agent.cwd, agent.sessionKey)] : [],
      )
      if (new Set(sessionPaths).size !== sessionPaths.length) {
        throw new Error('Duplicate subagent sessionKey for same cwd in one parallel run')
      }

      const results = await Promise.all(
        params.agents.map(async (agent, index) => {
          liveAgents[index].status = 'running'
          emitLiveUpdate()
          try {
            const result = await runSubAgent(
              model,
              agent.thinking,
              agent.prompt,
              agent.cwd,
              agent.sessionKey,
              signal,
              tool => {
                emitAgentTool(index, tool)
              },
            )
            const outputPath = path.join(runDirectory, `${sanitizeFileName(agent.name)}-result.md`)
            fs.writeFileSync(outputPath, result.text)
            liveAgents[index].status = result.exitCode === 0 ? 'done' : 'failed'
            liveAgents[index].exitCode = result.exitCode
            liveAgents[index].outputPath = outputPath
            emitLiveUpdate()
            return { index, outputPath, result }
          } catch (error) {
            liveAgents[index].status = 'failed'
            if (!signal?.aborted) emitLiveUpdate()
            throw error
          }
        }),
      )

      const text = results
        .sort((a, b) => a.index - b.index)
        .map(
          ({ index, outputPath, result }) =>
            `${params.agents[index].name} (${params.agents[index].thinking}, exit ${result.exitCode}): ${outputPath}`,
        )
        .join('\n')

      return {
        content: [{ type: 'text', text }],
        isError: results.some(({ result }) => result.exitCode !== 0),
      }
    },
  })
}
