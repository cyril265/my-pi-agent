/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Preferred API:
 *   - { items: [{ agent, task }] } -> single mode
 *   - { items: [{ agent, task }, ...] } -> parallel mode
 *   - { mode: "chain", items: [{ agent, task: "... {previous} ..." }, ...] }
 *
 * `agent` can be a saved agent name or an inline generic agent object.
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentDiscoveryResult, type AgentThinkingLevel, discoverAgents } from "./agents.js";
import { SqTodoTracker, extractSummaryLines, getResultSummaryText, type TodoTrackingOptions, withTodoTrackingNote } from "./todo-tracking.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_CHAIN_PREVIOUS_CHARS = 12000;
const AMP_SUBAGENT_PROCESS_ENV = "PI_AMP_SUBAGENT";
const AMP_ROUTING_GUIDANCE_STATE = "amp-routing-guidance-state";

const AMP_ROUTING_GUIDANCE = fs.readFileSync(new URL("./routing-guidance.md", import.meta.url), "utf-8").trim();

type EffectiveThinkingLevel = Exclude<AgentThinkingLevel, "inherit">;
const ThinkingLevelSchema = StringEnum(["low", "medium", "high", "xhigh", "inherit"] as const, {
	description:
		'Subagent thinking level. Use "inherit" to use the caller session\'s current thinking level. Levels: low, medium, high, xhigh.',
});

function isEffectiveThinkingLevel(value: string | undefined): value is EffectiveThinkingLevel {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function resolveThinkingLevel(
	override: AgentThinkingLevel | undefined,
	agentDefault: AgentThinkingLevel | undefined,
	callerThinking: string | undefined,
): EffectiveThinkingLevel | undefined {
	const candidate = override ?? agentDefault;
	if (candidate === "inherit") {
		return isEffectiveThinkingLevel(callerThinking) ? callerThinking : undefined;
	}
	if (isEffectiveThinkingLevel(candidate)) return candidate;
	if (isEffectiveThinkingLevel(callerThinking)) return callerThinking;
	return undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinkingLevel?: EffectiveThinkingLevel,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	if (thinkingLevel) parts.push(`thinking:${thinkingLevel}`);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: AgentSource;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinkingLevel?: EffectiveThinkingLevel;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
	blocked?: boolean;
	reason?: string;
}

type ProgressState = "queued" | "running" | "done" | "failed";

interface ProgressItem {
	key: string;
	agent: string;
	label: string;
	state: ProgressState;
	step?: number;
}

class RunProgressTracker {
	private readonly mode: "single" | "parallel" | "chain";
	private readonly items = new Map<string, ProgressItem>();
	private readonly order: string[] = [];

	constructor(mode: "single" | "parallel" | "chain", planned: Array<{ key: string; agent: string; task: string; step?: number }>) {
		this.mode = mode;
		for (const item of planned) {
			this.items.set(item.key, {
				key: item.key,
				agent: item.agent,
				label: summarizeTaskLabel(item.agent, item.task),
				state: "queued",
				step: item.step,
			});
			this.order.push(item.key);
		}
	}

	startTask(key: string, agent: string, task: string, step?: number) {
		const existing = this.items.get(key);
		const next: ProgressItem = {
			key,
			agent,
			label: summarizeTaskLabel(agent, task),
			state: "running",
			step,
		};
		this.items.set(key, existing ? { ...existing, ...next } : next);
		if (!existing) this.order.push(key);
	}

	finishTask(key: string, ok: boolean) {
		const existing = this.items.get(key);
		if (!existing) return;
		existing.state = ok ? "done" : "failed";
	}

	renderSummary(): string {
		const ordered = this.order.map((key) => this.items.get(key)).filter((item): item is ProgressItem => Boolean(item));
		const total = ordered.length;
		const done = ordered.filter((item) => item.state === "done").length;
		const running = ordered.filter((item) => item.state === "running");
		const queued = ordered.filter((item) => item.state === "queued");
		const failed = ordered.filter((item) => item.state === "failed");
		const parts: string[] = [];

		if (this.mode === "chain") {
			const current = running[0];
			const next = queued[0];
			parts.push(`Plan: ${total}-step chain`);
			parts.push(`Done: ${done}/${total}`);
			if (current) parts.push(`Now: ${current.label}`);
			if (next) parts.push(`Next: ${next.label}`);
			if (failed.length > 0) parts.push(`Failed: ${failed[0].label}${failed.length > 1 ? ` (+${failed.length - 1})` : ""}`);
			return parts.join("\n");
		}

		if (this.mode === "parallel") {
			parts.push(`Plan: ${total} parallel task${total === 1 ? "" : "s"}`);
			parts.push(`Done: ${done}/${total}`);
			if (running.length > 0) parts.push(`Running: ${running.slice(0, 3).map((item) => item.agent).join(", ")}`);
			if (queued.length > 0) parts.push(`Queued: ${queued.slice(0, 3).map((item) => item.agent).join(", ")}`);
			if (failed.length > 0) parts.push(`Failed: ${failed.slice(0, 2).map((item) => item.agent).join(", ")}`);
			return parts.join("\n");
		}

		const current = running[0] ?? ordered[0];
		parts.push("Plan: 1 task");
		if (current) parts.push(`Now: ${current.label}`);
		parts.push(`Done: ${done}/${total || 1}`);
		if (failed.length > 0) parts.push("Status: failed");
		return parts.join("\n");
	}
}

function summarizeTaskLabel(agent: string, task: string): string {
	const cleaned = task
		.replace(/\{previous\}/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(please|kindly|can you|could you|would you)\s+/i, "");
	const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
	const preview = sentence.length > 56 ? `${sentence.slice(0, 56).trim()}...` : sentence;
	return `${agent} — ${preview || "(no task)"}`;
}

function attachProgressSummary(partial: AgentToolResult<SubagentDetails>, progress: RunProgressTracker): AgentToolResult<SubagentDetails> {
	const summary = progress.renderSummary();
	const content = [...partial.content];
	const firstTextIndex = content.findIndex((part) => part.type === "text");
	if (firstTextIndex >= 0) {
		const current = content[firstTextIndex];
		if (current.type === "text") content[firstTextIndex] = { ...current, text: `${summary}\n\n${current.text}` };
	} else {
		content.unshift({ type: "text", text: summary });
	}
	return { ...partial, content };
}

function wrapTaskPreview(task: string, maxLineLength = 96, maxLines = 3): string {
	const words = task.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0) return "...";
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const next = current ? `${current} ${word}` : word;
		if (next.length <= maxLineLength) {
			current = next;
			continue;
		}
		if (current) lines.push(current);
		current = word;
		if (lines.length === maxLines - 1) break;
	}
	if (current && lines.length < maxLines) lines.push(current);
	const consumedWords = lines.join(" ").split(" ").filter(Boolean).length;
	if (consumedWords < words.length && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]}...`;
	return lines.join("\n    ");
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getResultErrorText(result: SingleResult): string {
	return truncateText(result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)", 4000);
}

function getResultDisplayText(result: SingleResult): string {
	return getFinalOutput(result.messages) || (result.exitCode !== 0 ? getResultErrorText(result) : "");
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function buildChainContext(previousOutput: string): string {
	if (previousOutput.length <= MAX_CHAIN_PREVIOUS_CHARS) return previousOutput;
	const trimmed = previousOutput.slice(0, MAX_CHAIN_PREVIOUS_CHARS);
	const omitted = previousOutput.length - trimmed.length;
	return `${trimmed}\n\n[Previous output truncated: omitted ${omitted} characters to keep chain context bounded.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

type AgentSource = "user" | "project" | "inline" | "unknown";

interface GenericAgentSpec {
	type?: "generic";
	name?: string;
	description?: string;
	tools?: string[];
	model?: string;
	thinking?: AgentThinkingLevel;
	systemPrompt: string;
}

type RequestedAgent = string | GenericAgentSpec;

interface NormalizedTaskItem {
	agent: RequestedAgent;
	task: string;
	thinking?: AgentThinkingLevel;
	cwd?: string;
}

interface NormalizedSubagentRequest {
	mode: "single" | "parallel" | "chain";
	items: NormalizedTaskItem[];
	todo?: TodoTrackingOptions;
}

interface ResolvedAgentConfig {
	name: string;
	source: AgentSource;
	tools?: string[];
	model?: string;
	thinking?: AgentThinkingLevel;
	systemPrompt: string;
}

function isGenericAgentSpec(value: RequestedAgent): value is GenericAgentSpec {
	return typeof value !== "string";
}

function getAgentDisplayName(agent: RequestedAgent): string {
	if (typeof agent === "string") return agent;
	return agent.name?.trim() || "generic";
}

function buildResolvedAgent(
	agents: AgentConfig[],
	requestedAgent: RequestedAgent,
): { config?: ResolvedAgentConfig; unknownAgentName?: string } {
	if (isGenericAgentSpec(requestedAgent)) {
		return {
			config: {
				name: getAgentDisplayName(requestedAgent),
				source: "inline",
				tools: requestedAgent.tools,
				model: requestedAgent.model,
				thinking: requestedAgent.thinking,
				systemPrompt: requestedAgent.systemPrompt,
			},
		};
	}

	const agent = agents.find((a) => a.name === requestedAgent);
	if (!agent) {
		return { unknownAgentName: requestedAgent };
	}

	return {
		config: {
			name: agent.name,
			source: agent.source,
			tools: agent.tools,
			model: agent.model,
			thinking: agent.thinking,
			systemPrompt: agent.systemPrompt,
		},
	};
}

function getRequestedAgentHeaderMeta(agents: AgentConfig[], requestedAgent: RequestedAgent): { name: string; model?: string; thinking?: AgentThinkingLevel } {
	const resolved = buildResolvedAgent(agents, requestedAgent);
	return {
		name: resolved.config?.name ?? getAgentDisplayName(requestedAgent),
		model: resolved.config?.model,
		thinking: resolved.config?.thinking,
	};
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	requestedAgent: RequestedAgent,
	task: string,
	thinkingOverride: AgentThinkingLevel | undefined,
	callerThinking: string | undefined,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const resolved = buildResolvedAgent(agents, requestedAgent);
	const displayName = getAgentDisplayName(requestedAgent);

	if (!resolved.config) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: resolved.unknownAgentName ?? displayName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${resolved.unknownAgentName ?? displayName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const agent = resolved.config;
	const effectiveThinking = resolveThinkingLevel(thinkingOverride, agent.thinking, callerThinking);
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (effectiveThinking) args.push("--thinking", effectiveThinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		thinkingLevel: effectiveThinking,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				env: { ...process.env, [AMP_SUBAGENT_PROCESS_ENV]: "1" },
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				currentResult.errorMessage = error.message;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const GenericAgentSchema = Type.Object(
	{
		type: Type.Optional(Type.Literal("generic")),
		name: Type.Optional(Type.String({ description: "Optional display name for an inline generic agent" })),
		description: Type.Optional(Type.String({ description: "Optional description for the inline generic agent" })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist for the inline generic agent" })),
		model: Type.Optional(Type.String({ description: "Optional model override for the inline generic agent" })),
		thinking: Type.Optional(ThinkingLevelSchema),
		systemPrompt: Type.String({ description: "System prompt to use for the inline generic agent" }),
	},
	{ additionalProperties: false },
);

const AgentTargetSchema = Type.Union([
	Type.String({ description: "Name of the saved agent to invoke" }),
	GenericAgentSchema,
]);

function createDelegatedTaskSchema(taskDescription: string) {
	return Type.Object({
		agent: AgentTargetSchema,
		task: Type.String({ description: taskDescription }),
		thinking: Type.Optional(ThinkingLevelSchema),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	});
}

const TaskItem = createDelegatedTaskSchema("Task to delegate to the agent. In chain mode, supports {previous} placeholder for prior output.");

const TodoOptionsSchema = Type.Object(
	{
		enabled: Type.Optional(
			Type.Boolean({ description: "Enable or disable sq todo tracking for this subagent run. Default: true." }),
		),
		queuePath: Type.Optional(Type.String({ description: "Optional sq queue path override (issues.jsonl)." })),
		runTitle: Type.Optional(Type.String({ description: "Optional sq run title for the parent tracking item." })),
	},
	{ additionalProperties: false },
);

const ExecutionModeSchema = StringEnum(["single", "parallel", "chain"] as const, {
	description: "Execution mode. Defaults to single for one item and parallel for multiple items.",
});

const SubagentParams = Type.Object(
	{
		mode: Type.Optional(ExecutionModeSchema),
		items: Type.Array(TaskItem, { minItems: 1, description: "List of delegated agent runs." }),
		thinking: Type.Optional(ThinkingLevelSchema),
		todo: Type.Optional(TodoOptionsSchema),
		cwd: Type.Optional(Type.String({ description: "Default working directory for delegated agent processes" })),
	},
	{ additionalProperties: false },
);

function normalizeSubagentRequest(params: { mode?: "single" | "parallel" | "chain"; items: NormalizedTaskItem[]; todo?: TodoTrackingOptions; cwd?: string }): { request?: NormalizedSubagentRequest; error?: string } {
	const items = params.items;
	if (!Array.isArray(items) || items.length === 0) {
		return { error: "No items provided. Add at least one entry to `items`." };
	}

	const mode = params.mode ?? (items.length === 1 ? "single" : "parallel");
	if (mode === "single" && items.length !== 1) {
		return { error: "Single mode requires exactly one item." };
	}
	if (mode !== "single" && items.length < 2) {
		return { error: `${mode[0].toUpperCase()}${mode.slice(1)} mode requires at least two items.` };
	}

	return {
		request: {
			mode,
			items: items.map((item) => ({ ...item, cwd: item.cwd ?? params.cwd })),
			todo: params.todo,
		},
	};
}

function resolveAvailableAgents(cwd: string, items: NormalizedTaskItem[]): AgentDiscoveryResult {
	const discoveries = new Map<string, AgentConfig>();
	let projectAgentsDir: string | null = null;
	for (const item of items) {
		const taskCwd = item.cwd ?? cwd;
		const discovery = discoverAgents(taskCwd, "user");
		projectAgentsDir ??= discovery.projectAgentsDir;
		for (const agent of discovery.agents) discoveries.set(agent.name, agent);
	}
	return { agents: Array.from(discoveries.values()), projectAgentsDir };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (process.env[AMP_SUBAGENT_PROCESS_ENV] === "1") return;
		const hasRoutingGuidanceState = ctx
			.sessionManager
			.getEntries()
			.some((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === AMP_ROUTING_GUIDANCE_STATE);
		if (hasRoutingGuidanceState) return;
		pi.appendEntry(AMP_ROUTING_GUIDANCE_STATE, { injected: true });
		pi.sendMessage({
			customType: "amp-routing-guidance",
			content: AMP_ROUTING_GUIDANCE,
			display: false,
		});
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"API: { mode?, items:[{ agent, task, thinking?, cwd? }] } with mode defaulting to single for one item and parallel for multiple items.",
			"Chain mode runs sequentially and supports {previous} placeholders.",
			"agent can be a saved agent name or an inline generic agent object with systemPrompt, tools, model, and thinking.",
			'Use thinking: "inherit" to use the caller\'s current thinking level.',
			"Todo tracking is enabled by default; set todo.enabled:false to disable tracking for a call.",
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const callerThinking = pi.getThinkingLevel();
			const normalized = normalizeSubagentRequest(params);
			const makeDetails =
				(detailsMode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode: detailsMode,
					results,
				});

			if (!normalized.request) {
				const baseDiscovery = discoverAgents(ctx.cwd, "user");
				const available = baseDiscovery.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `${normalized.error ?? "Invalid parameters."}\nAvailable agents: ${available}` }],
					details: makeDetails("single")([]),
				};
			}

			const request = normalized.request;
			const availableAgents = resolveAvailableAgents(ctx.cwd, request.items);
			const plannedTasks = request.items.map((item, index) => ({
				key: `${request.mode === "chain" ? "chain" : request.mode === "parallel" ? "parallel" : "single"}:${index}`,
				agent: getAgentDisplayName(item.agent),
				task: item.task,
				step: request.mode === "chain" ? index + 1 : undefined,
			}));
			const progressTracker = new RunProgressTracker(request.mode, plannedTasks);
			const emitProgressUpdate = (partial: AgentToolResult<SubagentDetails>) => onUpdate?.(attachProgressSummary(partial, progressTracker));
			emitProgressUpdate({ content: [{ type: "text", text: "(starting...)" }], details: makeDetails(request.mode)([]) });

			const todoTracker = await SqTodoTracker.create(ctx.cwd, request.mode, toolCallId, request.todo ?? {});
			const finalizeAndReturn = async (result: AgentToolResult<SubagentDetails>) => {
				const withProgress = attachProgressSummary(result, progressTracker);
				await todoTracker?.finalize(!result.isError, getResultSummaryText(withProgress));
				return withTodoTrackingNote(withProgress, todoTracker?.statusNote());
			};

			try {
				if (request.mode === "chain") {
					const results: SingleResult[] = [];
					let previousOutput = "";

					for (let i = 0; i < request.items.length; i++) {
						const step = request.items[i];
						const taskKey = `chain:${i}`;
						const previousTaskId = i > 0 ? todoTracker?.getTaskId(`chain:${i - 1}`) : undefined;
						const taskCwd = step.cwd ?? ctx.cwd;
						const boundedPrevious = buildChainContext(previousOutput);
						const taskWithContext = step.task.replace(/\{previous\}/g, boundedPrevious);
						const agentName = getAgentDisplayName(step.agent);

						await todoTracker?.startTask(taskKey, agentName, taskWithContext, taskCwd, i + 1, previousTaskId ? [previousTaskId] : []);
						progressTracker.startTask(taskKey, agentName, taskWithContext, i + 1);
						emitProgressUpdate({ content: [{ type: "text", text: "(running...)" }], details: makeDetails("chain")(results) });

						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									emitProgressUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
							: undefined;

						try {
							const result = await runSingleAgent(
								ctx.cwd,
								availableAgents.agents,
								step.agent,
								taskWithContext,
								step.thinking ?? params.thinking,
								callerThinking,
								taskCwd,
								i + 1,
								signal,
								chainUpdate,
								makeDetails("chain"),
							);
							results.push(result);
							await todoTracker?.finishTask(taskKey, result);
							progressTracker.finishTask(taskKey, !(result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"));
							emitProgressUpdate({ content: [{ type: "text", text: getFinalOutput(result.messages) || "(step complete)" }], details: makeDetails("chain")(results) });

							const isError =
								result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
							if (isError) {
								const errorMsg = getResultErrorText(result);
								return await finalizeAndReturn({
									content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${agentName}): ${errorMsg}` }],
									details: makeDetails("chain")(results),
									isError: true,
								});
							}

							previousOutput = getFinalOutput(result.messages);
						} catch (error) {
							await todoTracker?.finishTaskWithError(taskKey, error);
							progressTracker.finishTask(taskKey, false);
							emitProgressUpdate({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: makeDetails("chain")(results) });
							throw error;
						}
					}

					return await finalizeAndReturn({
						content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
						details: makeDetails("chain")(results),
					});
				}

				if (request.mode === "parallel") {
					if (request.items.length > MAX_PARALLEL_TASKS) {
						return await finalizeAndReturn({
							content: [
								{ type: "text", text: `Too many parallel tasks (${request.items.length}). Max is ${MAX_PARALLEL_TASKS}.` },
							],
							details: makeDetails("parallel")([]),
							isError: true,
						});
					}

					const allResults: SingleResult[] = new Array(request.items.length);
					for (let i = 0; i < request.items.length; i++) {
						allResults[i] = {
							agent: getAgentDisplayName(request.items[i].agent),
							agentSource: "unknown",
							task: request.items[i].task,
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							thinkingLevel: resolveThinkingLevel(request.items[i].thinking ?? params.thinking, isGenericAgentSpec(request.items[i].agent) ? request.items[i].agent.thinking : undefined, callerThinking),
						};
					}

					const emitParallelUpdate = (message = "(running...)") => {
						emitProgressUpdate({
							content: [{ type: "text", text: message }],
							details: makeDetails("parallel")([...allResults]),
						});
					};

					const results = await mapWithConcurrencyLimit(request.items, MAX_CONCURRENCY, async (t, index) => {
						const taskKey = `parallel:${index}`;
						const taskCwd = t.cwd ?? ctx.cwd;
						const agentName = getAgentDisplayName(t.agent);
						await todoTracker?.startTask(taskKey, agentName, t.task, taskCwd, undefined, []);
						progressTracker.startTask(taskKey, agentName, t.task);
						emitParallelUpdate();
						try {
							const result = await runSingleAgent(
								ctx.cwd,
								availableAgents.agents,
								t.agent,
								t.task,
								t.thinking ?? params.thinking,
								callerThinking,
								taskCwd,
								undefined,
								signal,
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
							);
							allResults[index] = result;
							progressTracker.finishTask(taskKey, !(result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"));
							emitParallelUpdate(getFinalOutput(result.messages) || "(task complete)");
							await todoTracker?.finishTask(taskKey, result);
							return result;
						} catch (error) {
							await todoTracker?.finishTaskWithError(taskKey, error);
							progressTracker.finishTask(taskKey, false);
							emitParallelUpdate(error instanceof Error ? error.message : String(error));
							throw error;
						}
					});

					const failedResults = results.filter(
						(r) => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted",
					);
					const successCount = results.length - failedResults.length;
					const failCount = failedResults.length;
					const summaries = results.map((r) => {
						const failed = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
						const output = failed ? getResultErrorText(r) : getResultDisplayText(r);
						const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
						return `[${r.agent}] ${failed ? "failed" : "completed"}: ${preview || "(no output)"}`;
					});

					return await finalizeAndReturn({
						content: [
							{
								type: "text",
								text: `Parallel: ${successCount}/${results.length} succeeded${failCount > 0 ? `, ${failCount} failed` : ""}\n\n${summaries.join("\n\n")}`,
							},
						],
						details: makeDetails("parallel")(results),
						isError: failCount > 0,
					});
				}

				if (request.mode === "single") {
					const singleItem = request.items[0];
					const taskKey = "single:0";
					const taskCwd = singleItem.cwd ?? ctx.cwd;
					const agentName = getAgentDisplayName(singleItem.agent);
					await todoTracker?.startTask(taskKey, agentName, singleItem.task, taskCwd, undefined, []);
					progressTracker.startTask(taskKey, agentName, singleItem.task);
					emitProgressUpdate({ content: [{ type: "text", text: "(running...)" }], details: makeDetails("single")([]) });
					try {
						const result = await runSingleAgent(
							ctx.cwd,
							availableAgents.agents,
							singleItem.agent,
							singleItem.task,
							singleItem.thinking ?? params.thinking,
							callerThinking,
							taskCwd,
							undefined,
							signal,
							emitProgressUpdate,
							makeDetails("single"),
						);

						await todoTracker?.finishTask(taskKey, result);
						progressTracker.finishTask(taskKey, !(result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"));
						const isError =
							result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
						if (isError) {
							const errorMsg = getResultErrorText(result);
							return await finalizeAndReturn({
								content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
								details: makeDetails("single")([result]),
								isError: true,
							});
						}

						return await finalizeAndReturn({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
							details: makeDetails("single")([result]),
						});
					} catch (error) {
						await todoTracker?.finishTaskWithError(taskKey, error);
						progressTracker.finishTask(taskKey, false);
						emitProgressUpdate({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: makeDetails("single")([]) });
						throw error;
					}
				}

				return await finalizeAndReturn({
					content: [{ type: "text", text: "Invalid parameters." }],
					details: makeDetails("single")([]),
					isError: true,
				});
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				return await finalizeAndReturn({
					content: [{ type: "text", text: `Subagent execution failed: ${errorMessage}` }],
					details: makeDetails(request.mode)([]),
					isError: true,
				});
			}
		},

		renderCall(args, theme) {
			const metaText = (model?: string, thinking?: AgentThinkingLevel | "mixed") => {
				const parts: string[] = [];
				if (model) parts.push(theme.fg("accent", `[model:${model}]`));
				if (thinking) parts.push(theme.fg("warning", `[thinking:${thinking}]`));
				return parts.length > 0 ? ` ${parts.join(" ")}` : "";
			};
			const summarizeValues = <T,>(values: Array<T | undefined>): T | "mixed" | undefined => {
				const defined = values.filter((value): value is T => value !== undefined);
				if (defined.length === 0) return undefined;
				return defined.every((value) => value === defined[0]) ? defined[0] : "mixed";
			};
			const normalized = normalizeSubagentRequest(args);
			if (!normalized.request) {
				return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("error", normalized.error ?? "invalid"), 0, 0);
			}
			const request = normalized.request;
			const discoveredAgents = resolveAvailableAgents(process.cwd(), request.items).agents;
			const itemMetas = request.items.map((item) => {
				const agentMeta = getRequestedAgentHeaderMeta(discoveredAgents, item.agent);
				return {
					...agentMeta,
					thinking: (item.thinking ?? agentMeta.thinking ?? args.thinking) as AgentThinkingLevel | undefined,
				};
			});
			const title = request.mode === "chain"
				? `chain (${request.items.length} steps)`
				: request.mode === "parallel"
					? `parallel (${request.items.length} tasks)`
					: itemMetas[0]?.name ?? getAgentDisplayName(request.items[0]?.agent ?? "...");
			const topMeta = request.mode === "single"
				? { model: itemMetas[0]?.model, thinking: itemMetas[0]?.thinking }
				: {
					model: summarizeValues(itemMetas.map((meta) => meta.model)),
					thinking: summarizeValues(itemMetas.map((meta) => meta.thinking)),
				};
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", title) + metaText(topMeta.model, topMeta.thinking);
			for (let i = 0; i < Math.min(request.items.length, request.mode === "single" ? 1 : 3); i++) {
				const item = request.items[i];
				const cleanTask = request.mode === "chain" ? item.task.replace(/\{previous\}/g, "").trim() : item.task;
				const preview = wrapTaskPreview(cleanTask, request.mode === "single" ? 108 : 72, request.mode === "single" ? 4 : 3);
				const itemMeta = itemMetas[i];
				if (request.mode === "single") {
					text += `\n  ${theme.fg("dim", preview)}`;
					continue;
				}
				text += `\n  ${request.mode === "chain" ? `${theme.fg("muted", `${i + 1}.`)} ` : ""}${theme.fg("accent", itemMeta.name)}${metaText(itemMeta.model, itemMeta.thinking)}${theme.fg("dim", ` ${preview}`)}`;
			}
			if (request.mode !== "single" && request.items.length > 3) text += `\n  ${theme.fg("muted", `... +${request.items.length - 3} more`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			const summaryLines = extractSummaryLines(result);
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				const message = text?.type === "text" ? text.text : "(no output)";
				if (details?.blocked) {
					const reason = details.reason ? ` [${details.reason}]` : "";
					return new Text(`${theme.fg("error", "✗")} ${theme.fg("error", message)}${theme.fg("muted", reason)}`, 0, 0);
				}
				return new Text(message, 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const appendSummaryHeader = (container: Container) => {
				if (summaryLines.progress.length === 0 && !summaryLines.todo) return;
				for (const line of summaryLines.progress) container.addChild(new Text(theme.fg("accent", line), 0, 0));
				if (summaryLines.todo) container.addChild(new Text(theme.fg("muted", summaryLines.todo), 0, 0));
				container.addChild(new Spacer(1));
			};

			const buildSummaryPrefix = () => {
				const parts: string[] = [];
				for (const line of summaryLines.progress) parts.push(theme.fg("accent", line));
				if (summaryLines.todo) parts.push(theme.fg("muted", summaryLines.todo));
				return parts.length > 0 ? `${parts.join("\n")}\n\n` : "";
			};
			const summarizeValues = <T,>(values: Array<T | undefined>): T | "mixed" | undefined => {
				const defined = values.filter((value): value is T => value !== undefined);
				if (defined.length === 0) return undefined;
				return defined.every((value) => value === defined[0]) ? defined[0] : "mixed";
			};
			const sharedResultMeta = (results: SingleResult[]) => ({
				model: summarizeValues(results.map((r) => r.model)),
				thinking: summarizeValues(results.map((r) => r.thinkingLevel)),
			});

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				const errorText = isError ? getResultErrorText(r) : "";

				if (expanded) {
					const container = new Container();
					appendSummaryHeader(container);
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (r.model) header += ` ${theme.fg("accent", `[model:${r.model}]`)}`;
					if (r.thinkingLevel) header += ` ${theme.fg("warning", `[thinking:${r.thinkingLevel}]`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && errorText)
						container.addChild(new Text(theme.fg("error", `Error: ${errorText}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(isError ? theme.fg("error", errorText) : theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model, r.thinkingLevel);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${buildSummaryPrefix()}${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (r.model) text += ` ${theme.fg("accent", `[model:${r.model}]`)}`;
				if (r.thinkingLevel) text += ` ${theme.fg("warning", `[thinking:${r.thinkingLevel}]`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && errorText) text += `\n${theme.fg("error", `Error: ${errorText}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model, r.thinkingLevel);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const topMeta = sharedResultMeta(details.results);

				if (expanded) {
					const container = new Container();
					appendSummaryHeader(container);
					let chainHeader =
						icon +
						" " +
						theme.fg("toolTitle", theme.bold("chain ")) +
						theme.fg("accent", `${successCount}/${details.results.length} steps`);
					if (topMeta.model) chainHeader += ` ${theme.fg("accent", `[model:${topMeta.model}]`)}`;
					if (topMeta.thinking) chainHeader += ` ${theme.fg("warning", `[thinking:${topMeta.thinking}]`)}`;
					container.addChild(new Text(chainHeader, 0, 0));

					for (const r of details.results) {
						const rIsError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
						const rIcon = rIsError ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const errorText = rIsError ? getResultErrorText(r) : "";

						container.addChild(new Spacer(1));
						let stepHeader = `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`;
						if (r.model) stepHeader += ` ${theme.fg("accent", `[model:${r.model}]`)}`;
						if (r.thinkingLevel) stepHeader += ` ${theme.fg("warning", `[thinking:${r.thinkingLevel}]`)}`;
						container.addChild(new Text(stepHeader, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (rIsError && errorText) container.addChild(new Text(theme.fg("error", `Error: ${errorText}`), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						} else if (rIsError && errorText && displayItems.length === 0) {
							container.addChild(new Spacer(1));
							container.addChild(new Text(theme.fg("error", errorText), 0, 0));
						}

						const stepUsage = formatUsageStats(r.usage, r.model, r.thinkingLevel);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text =
					buildSummaryPrefix() +
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				if (topMeta.model) text += ` ${theme.fg("accent", `[model:${topMeta.model}]`)}`;
				if (topMeta.thinking) text += ` ${theme.fg("warning", `[thinking:${topMeta.thinking}]`)}`;
				for (const r of details.results) {
					const rIsError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
					const rIcon = rIsError ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const errorText = rIsError ? getResultErrorText(r) : "";
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.model) text += ` ${theme.fg("accent", `[model:${r.model}]`)}`;
					if (r.thinkingLevel) text += ` ${theme.fg("warning", `[thinking:${r.thinkingLevel}]`)}`;
					if (rIsError && errorText) text += `\n${theme.fg("error", `Error: ${errorText}`)}`;
					else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const isFailedResult = (r: SingleResult) =>
					(r.exitCode !== 0 && r.exitCode !== -1) || r.stopReason === "error" || r.stopReason === "aborted";
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const failCount = details.results.filter(isFailedResult).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const topMeta = sharedResultMeta(details.results);
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					appendSummaryHeader(container);
					let parallelHeader = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
					if (topMeta.model) parallelHeader += ` ${theme.fg("accent", `[model:${topMeta.model}]`)}`;
					if (topMeta.thinking) parallelHeader += ` ${theme.fg("warning", `[thinking:${topMeta.thinking}]`)}`;
					container.addChild(new Text(parallelHeader, 0, 0));

					for (const r of details.results) {
						const rIsError = isFailedResult(r);
						const rIcon = rIsError ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const errorText = rIsError ? getResultErrorText(r) : "";

						container.addChild(new Spacer(1));
						let taskHeader = `${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`;
						if (r.model) taskHeader += ` ${theme.fg("accent", `[model:${r.model}]`)}`;
						if (r.thinkingLevel) taskHeader += ` ${theme.fg("warning", `[thinking:${r.thinkingLevel}]`)}`;
						container.addChild(new Text(taskHeader, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (rIsError && errorText) container.addChild(new Text(theme.fg("error", `Error: ${errorText}`), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						} else if (rIsError && errorText && displayItems.length === 0) {
							container.addChild(new Spacer(1));
							container.addChild(new Text(theme.fg("error", errorText), 0, 0));
						}

						const taskUsage = formatUsageStats(r.usage, r.model, r.thinkingLevel);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text = `${buildSummaryPrefix()}${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				if (topMeta.model) text += ` ${theme.fg("accent", `[model:${topMeta.model}]`)}`;
				if (topMeta.thinking) text += ` ${theme.fg("warning", `[thinking:${topMeta.thinking}]`)}`;
				for (const r of details.results) {
					const rIsError = isFailedResult(r);
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: rIsError
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const errorText = rIsError ? getResultErrorText(r) : "";
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.model) text += ` ${theme.fg("accent", `[model:${r.model}]`)}`;
					if (r.thinkingLevel) text += ` ${theme.fg("warning", `[thinking:${r.thinkingLevel}]`)}`;
					if (rIsError && errorText) text += `\n${theme.fg("error", `Error: ${errorText}`)}`;
					else if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
