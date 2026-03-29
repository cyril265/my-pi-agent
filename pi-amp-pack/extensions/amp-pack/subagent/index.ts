/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Uses one caller-facing shape:
 *   - Single: { steps: [{ agent: "name", task: "..." }] }
 *   - Parallel: { steps: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { sequential: true, steps: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { runPiJsonProcess, writePromptToTempFile } from "../pi-process";
import { type AgentConfig, type AgentDiscoveryResult, type AgentThinkingLevel, discoverAgents } from "./agents.js";
import {
	SqTodoTracker,
	extractSummaryLines,
	getResultSummaryText,
	loadTrackedRun,
	resolveMainTodoQueuePath,
	withTodoTrackingNote,
} from "./todo-tracking.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_CHAIN_PREVIOUS_CHARS = 12000;
const COMPLETED_BACKGROUND_RUN_TTL_MS = 30 * 60 * 1000;
const MAX_COMPLETED_BACKGROUND_RUNS = 24;
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

interface ModelLookupResult {
	provider: string;
	id: string;
}

interface ModelRegistryLookup {
	find(provider: string, modelId: string): ModelLookupResult | undefined;
}

type AgentSource = "user" | "project" | "inline" | "unknown";
type AgentModelSource = "active-provider" | "fallback" | "pinned" | "configured";

interface ResolvedAgentModel {
	model?: string;
	source?: AgentModelSource;
}

function resolveAgentModel(
	agent: AgentConfig,
	preferredProvider: string | undefined,
	modelRegistry: ModelRegistryLookup,
): ResolvedAgentModel {
	const configuredModel = agent.model?.trim() || undefined;
	const fallbackModel = agent.fallbackModel?.trim() || undefined;
	if (!configuredModel) {
		return fallbackModel ? { model: fallbackModel, source: "fallback" } : {};
	}
	if (configuredModel.includes("/")) return { model: configuredModel, source: "pinned" };
	const preferredModel = preferredProvider ? modelRegistry.find(preferredProvider, configuredModel) : undefined;
	if (preferredModel) {
		return { model: `${preferredModel.provider}/${preferredModel.id}`, source: "active-provider" };
	}
	if (fallbackModel) return { model: fallbackModel, source: "fallback" };
	return { model: configuredModel, source: "configured" };
}

function splitQualifiedModel(model: string | undefined): { provider?: string; id?: string } {
	if (!model) return {};
	const separatorIndex = model.indexOf("/");
	if (separatorIndex === -1) return { id: model };
	return {
		provider: model.slice(0, separatorIndex),
		id: model.slice(separatorIndex + 1),
	};
}

function resolveRequestedModel(
	model: string | undefined,
	preferredProvider: string | undefined,
	modelRegistry: ModelRegistryLookup | undefined,
): string | undefined {
	const configuredModel = model?.trim() || undefined;
	if (!configuredModel || configuredModel.includes("/")) return configuredModel;
	const preferredModel = preferredProvider && modelRegistry ? modelRegistry.find(preferredProvider, configuredModel) : undefined;
	return preferredModel ? `${preferredModel.provider}/${preferredModel.id}` : configuredModel;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

type ThemeFormatter = {
	fg: (color: any, text: string) => string;
};

function formatUsageStats(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns?: number;
}): string {
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
	return parts.join(" ");
}

function formatResultMeta(result: Pick<SingleResult, "model" | "thinkingLevel">, theme: ThemeFormatter): string {
	let text = "";
	if (result.model) text += ` ${theme.fg("dim", `[${result.model}]`)}`;
	if (result.thinkingLevel) text += ` ${theme.fg("warning", `[thinking:${result.thinkingLevel}]`)}`;
	return text;
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
			if (running.length > 0) parts.push(`Running: ${summarizeAgents(running)}`);
			if (queued.length > 0) parts.push(`Queued: ${summarizeAgents(queued)}`);
			if (failed.length > 0) parts.push(`Failed: ${summarizeAgents(failed, 2)}`);
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

function summarizeAgents(items: ProgressItem[], maxEntries = 3): string {
	const counts = new Map<string, number>();
	const order: string[] = [];

	for (const item of items) {
		const current = counts.get(item.agent);
		if (current === undefined) order.push(item.agent);
		counts.set(item.agent, (current ?? 0) + 1);
	}

	const visible = order.slice(0, maxEntries).map((agent) => {
		const count = counts.get(agent) ?? 0;
		return count > 1 ? `${agent} ×${count}` : agent;
	});
	const hidden = order.length - visible.length;
	if (hidden > 0) visible.push(`+${hidden} more`);
	return visible.join(", ");
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

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

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
	trackingCwd: string;
	runTitle?: string;
}

type BackgroundRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface BackgroundRunRecord {
	runId: string;
	queuePath: string;
	request: NormalizedSubagentRequest;
	status: BackgroundRunState;
	startedAt: string;
	completedAt?: string;
	latest?: AgentToolResult<SubagentDetails>;
	final?: AgentToolResult<SubagentDetails>;
	abortController: AbortController;
	tracker: SqTodoTracker | null;
	promise?: Promise<void>;
}

const backgroundRuns = new Map<string, BackgroundRunRecord>();

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
	preferredProvider: string | undefined,
	modelRegistry: ModelRegistryLookup,
): { config?: ResolvedAgentConfig; unknownAgentName?: string } {
	if (isGenericAgentSpec(requestedAgent)) {
		return {
			config: {
				name: getAgentDisplayName(requestedAgent),
				source: "inline",
				tools: requestedAgent.tools?.length ? requestedAgent.tools : undefined,
				model: resolveRequestedModel(requestedAgent.model, preferredProvider, modelRegistry),
				thinking: requestedAgent.thinking,
				systemPrompt: requestedAgent.systemPrompt,
			},
		};
	}

	const agent = agents.find((candidate) => candidate.name === requestedAgent);
	if (!agent) return { unknownAgentName: requestedAgent };
	return {
		config: {
			name: agent.name,
			source: agent.source,
			tools: agent.tools,
			model: resolveAgentModel(agent, preferredProvider, modelRegistry).model,
			thinking: agent.thinking,
			systemPrompt: agent.systemPrompt,
		},
	};
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	requestedAgent: RequestedAgent,
	task: string,
	thinkingOverride: AgentThinkingLevel | undefined,
	callerThinking: string | undefined,
	preferredProvider: string | undefined,
	modelRegistry: ModelRegistryLookup,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	trackingQueuePath?: string,
	onProcessStart?: (pid: number | undefined) => void,
): Promise<SingleResult> {
	const resolved = buildResolvedAgent(agents, requestedAgent, preferredProvider, modelRegistry);
	const agentName = resolved.config?.name ?? getAgentDisplayName(requestedAgent);

	if (!resolved.config) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: resolved.unknownAgentName ?? agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${resolved.unknownAgentName ?? agentName}". Available agents: ${available}.`,
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

		const result = await runPiJsonProcess({
			args,
			cwd: cwd ?? defaultCwd,
			env: {
				...process.env,
				[AMP_SUBAGENT_PROCESS_ENV]: "1",
				SQ_QUEUE_PATH: trackingQueuePath ?? process.env.SQ_QUEUE_PATH ?? resolveMainTodoQueuePath(defaultCwd),
			},
			signal,
			onSpawn: onProcessStart,
			onEvent: (event) => {
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
			},
		});

		currentResult.stderr = result.stderr;
		currentResult.exitCode = result.exitCode;
		if (result.aborted) {
			currentResult.stopReason ??= "aborted";
			currentResult.errorMessage ??= "Subagent was aborted";
		}
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

const StepItem = Type.Object(
	{
		agent: Type.Union([
			Type.String({ description: "Name of the saved agent to invoke" }),
			GenericAgentSchema,
		]),
		task: Type.String({
			description: "Task to delegate to the agent. In sequential mode, {previous} can be used to inject the previous step output.",
		}),
		thinking: Type.Optional(ThinkingLevelSchema),
		cwd: Type.Optional(Type.String({ description: "Working directory for this step" })),
	},
	{ additionalProperties: false },
);

const SubagentParams = Type.Object(
	{
		steps: Type.Array(StepItem, {
			minItems: 1,
			description: "One step runs a single subagent; multiple steps run in parallel unless sequential:true.",
		}),
		sequential: Type.Optional(Type.Boolean({ description: "Run steps sequentially as a chain." })),
		cwd: Type.Optional(Type.String({ description: "Default working directory for all steps unless a step overrides it." })),
		runTitle: Type.Optional(Type.String({ description: "Optional tracking title for the parent subagent run." })),
	},
	{ additionalProperties: false },
);

interface StepInput {
	agent: RequestedAgent;
	task: string;
	thinking?: AgentThinkingLevel;
	cwd?: string;
}

function resolveInvocationCwd(defaultCwd: string, requestedCwd: string | undefined): string {
	if (!requestedCwd) return defaultCwd;
	return path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(defaultCwd, requestedCwd);
}

function getSubagentMode(params: { steps: StepInput[]; sequential?: boolean }): "single" | "parallel" | "chain" {
	if (params.sequential) return "chain";
	return params.steps.length <= 1 ? "single" : "parallel";
}

function validateSubagentParams(params: { steps: StepInput[]; sequential?: boolean }): string | undefined {
	if (params.steps.length === 0) return "At least one step is required.";
	if (params.sequential && params.steps.length < 2) return "Sequential mode requires at least 2 steps.";
	return undefined;
}

function resolveStepCwd(step: StepInput, params: { cwd?: string }, sessionCwd: string): string {
	return resolveInvocationCwd(sessionCwd, step.cwd ?? params.cwd);
}

function resolveTrackingCwd(params: { steps: StepInput[]; cwd?: string }, sessionCwd: string): string {
	if (params.cwd) return resolveInvocationCwd(sessionCwd, params.cwd);
	const resolvedStepCwds = [...new Set(params.steps.map((step) => resolveStepCwd(step, params, sessionCwd)))];
	return resolvedStepCwds.length === 1 ? resolvedStepCwds[0]! : sessionCwd;
}

const AsyncRunLookupParams = Type.Object(
	{
		runId: Type.String({ description: "Run id returned by subagent_start." }),
	},
	{ additionalProperties: false },
);

function normalizeSubagentRequest(
	params: { steps: StepInput[]; sequential?: boolean; cwd?: string; runTitle?: string },
	sessionCwd: string,
): { request?: NormalizedSubagentRequest; error?: string } {
	const validationError = validateSubagentParams(params);
	if (validationError) return { error: validationError };
	const mode = getSubagentMode(params);
	return {
		request: {
			mode,
			items: params.steps.map((step) => ({
				agent: step.agent,
				task: step.task,
				thinking: step.thinking,
				cwd: resolveStepCwd(step, params, sessionCwd),
			})),
			trackingCwd: resolveTrackingCwd(params, sessionCwd),
			runTitle: params.runTitle?.trim() || undefined,
		},
	};
}

function buildBackgroundRunKey(runId: string): string {
	return runId;
}

function getAvailableAgentsText(cwd: string): string {
	const discovery = discoverAgents(cwd, "user");
	return discovery.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

function getBackgroundRunStatus(record: BackgroundRunRecord): BackgroundRunState {
	if (record.final?.isError) {
		return record.status === "cancelled" ? "cancelled" : "failed";
	}
	return record.status;
}

function pruneBackgroundRuns(now = Date.now()) {
	const completed: Array<{ key: string; completedAt: number }> = [];
	for (const [key, record] of backgroundRuns.entries()) {
		if (!record.completedAt) continue;
		const completedAt = Date.parse(record.completedAt);
		if (!Number.isNaN(completedAt) && now - completedAt > COMPLETED_BACKGROUND_RUN_TTL_MS) {
			backgroundRuns.delete(key);
			continue;
		}
		completed.push({ key, completedAt: Number.isNaN(completedAt) ? now : completedAt });
	}

	if (completed.length <= MAX_COMPLETED_BACKGROUND_RUNS) return;
	completed
		.sort((left, right) => left.completedAt - right.completedAt)
		.slice(0, completed.length - MAX_COMPLETED_BACKGROUND_RUNS)
		.forEach((entry) => backgroundRuns.delete(entry.key));
}

function summarizeTrackedTasks(tasks: Array<Record<string, unknown>>): {
	total: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	running: number;
	queued: number;
} {
	const counts = { total: tasks.length, succeeded: 0, failed: 0, cancelled: 0, running: 0, queued: 0 };
	for (const task of tasks) {
		const state = typeof task.state === "string" ? task.state : undefined;
		if (state === "succeeded") counts.succeeded++;
		else if (state === "failed") counts.failed++;
		else if (state === "cancelled") counts.cancelled++;
		else if (state === "running") counts.running++;
		else counts.queued++;
	}
	return counts;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function getStoredTaskEntries(tasks: Array<{ title?: string; description?: string; metadata: Record<string, unknown>; status: string }>) {
	return tasks.map((task) => {
		const subagent = asRecord(task.metadata.subagent) ?? {};
		const output = asString(subagent.output);
		const error = asString(subagent.error);
		const outcome = asString(subagent.outcome) ?? (task.status === "in_progress" ? "running" : task.status === "closed" ? "succeeded" : "queued");
		return {
			agent: asString(subagent.agent) ?? task.title ?? "unknown",
			task: task.description ?? "",
			state: outcome,
			preview: output || error || task.description || "(no output)",
		};
	});
}

function formatStoredRunSummary(
	runId: string,
	queuePath: string,
	status: string,
	mode: string | undefined,
	tasks: ReturnType<typeof getStoredTaskEntries>,
	summary?: string,
): string {
	const counts = summarizeTrackedTasks(tasks);
	const lines = [
		`Run: ${runId}`,
		`Status: ${status}`,
		`Queue: ${queuePath}`,
	];
	if (mode) lines.push(`Mode: ${mode}`);
	lines.push(`Tasks: ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.cancelled} cancelled, ${counts.running} running, ${counts.queued} queued`);
	if (summary) lines.push("", summary);
	if (tasks.length > 0) {
		lines.push(
			"",
			...tasks.map((task) => `[${task.agent}] ${task.state}: ${truncateText(task.preview, 160).replace(/\s+/g, " ").trim()}`),
		);
	}
	return lines.join("\n");
}

function buildRunLookup(params: { runId: string }): { runId: string; key: string } {
	return {
		runId: params.runId,
		key: buildBackgroundRunKey(params.runId),
	};
}

function applyMainTodoQueuePath(cwd: string) {
	process.env.SQ_QUEUE_PATH = resolveMainTodoQueuePath(cwd);
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

async function buildStoredRunResult(
	defaultCwd: string,
	params: { runId: string },
): Promise<AgentToolResult<SubagentDetails>> {
	const tracked = await loadTrackedRun(defaultCwd, params.runId);
	if (!tracked) {
		return {
			content: [{ type: "text", text: `Run ${params.runId} was not found in the resolved sq queue.` }],
			details: { mode: "single", results: [] },
			isError: true,
		};
	}
	const runMeta = asRecord(tracked.run.metadata.subagent) ?? {};
	const mode = asString(runMeta.mode);
	const status = asString(runMeta.state) ?? tracked.run.status;
	const summary = asString(runMeta.summary);
	const tasks = getStoredTaskEntries(tracked.tasks);
	return {
		content: [
			{
				type: "text",
				text: formatStoredRunSummary(params.runId, tracked.queuePath, status, mode, tasks, summary),
			},
		],
		details: {
			mode: mode === "parallel" || mode === "chain" || mode === "single" ? mode : "single",
			results: [],
		},
		isError: status === "failed",
	};
}

async function executeSubagentRequest(
	toolCallId: string,
	request: NormalizedSubagentRequest,
	defaultCwd: string,
	callerThinking: string | undefined,
	callerThinkingOverride: AgentThinkingLevel | undefined,
	preferredProvider: string | undefined,
	modelRegistry: ModelRegistryLookup,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	tracker?: SqTodoTracker | null,
	runMetadata: Record<string, unknown> = {},
): Promise<AgentToolResult<SubagentDetails>> {
	const makeDetails =
		(detailsMode: "single" | "parallel" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode: detailsMode,
			results,
		});
	const availableAgents = resolveAvailableAgents(defaultCwd, request.items);
	const plannedTasks = request.items.map((item, index) => ({
		key: `${request.mode === "chain" ? "chain" : request.mode === "parallel" ? "parallel" : "single"}:${index}`,
		agent: getAgentDisplayName(item.agent),
		task: item.task,
		step: request.mode === "chain" ? index + 1 : undefined,
	}));
	const progressTracker = new RunProgressTracker(request.mode, plannedTasks);
	const emitProgressUpdate = (partial: AgentToolResult<SubagentDetails>) => onUpdate?.(attachProgressSummary(partial, progressTracker));
	emitProgressUpdate({ content: [{ type: "text", text: "(starting...)" }], details: makeDetails(request.mode)([]) });

	const todoTracker = tracker ?? await SqTodoTracker.create(request.trackingCwd, request.mode, toolCallId, request.runTitle);
	await todoTracker?.markRunStarted(runMetadata);
	const trackingQueuePath = todoTracker?.getQueuePath();

	const finalizeAndReturn = async (
		result: AgentToolResult<SubagentDetails>,
		outcomeOverride?: BackgroundRunState,
	) => {
		const withProgress = attachProgressSummary(result, progressTracker);
		const outcome: BackgroundRunState = outcomeOverride ?? (result.isError ? "failed" : "succeeded");
		await todoTracker?.finalize(outcome === "cancelled" ? "cancelled" : outcome === "failed" ? "failed" : "succeeded", getResultSummaryText(withProgress));
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
				const taskCwd = step.cwd ?? defaultCwd;
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
						defaultCwd,
						availableAgents.agents,
						step.agent,
						taskWithContext,
						step.thinking ?? callerThinkingOverride,
						callerThinking,
						preferredProvider,
						modelRegistry,
						taskCwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						trackingQueuePath,
						(pid) => todoTracker?.noteTaskProcess(taskKey, pid),
					);
					results.push(result);
					await todoTracker?.finishTask(taskKey, result);
					progressTracker.finishTask(taskKey, !(result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"));
					emitProgressUpdate({ content: [{ type: "text", text: getFinalOutput(result.messages) || "(step complete)" }], details: makeDetails("chain")(results) });

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg = getResultErrorText(result);
						const outcome = result.stopReason === "aborted" ? "cancelled" : "failed";
						return await finalizeAndReturn({
							content: [{ type: "text", text: outcome === "cancelled" ? `Chain cancelled at step ${i + 1} (${agentName}).` : `Chain stopped at step ${i + 1} (${agentName}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: outcome !== "cancelled",
						}, outcome);
					}

					previousOutput = getFinalOutput(result.messages);
				} catch (error) {
					const cancelled = Boolean(signal?.aborted);
					await todoTracker?.finishTaskWithError(taskKey, error, cancelled ? "cancelled" : "failed");
					progressTracker.finishTask(taskKey, false);
					emitProgressUpdate({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: makeDetails("chain")(results) });
					if (cancelled) {
						return await finalizeAndReturn({
							content: [{ type: "text", text: `Chain cancelled at step ${i + 1} (${agentName}).` }],
							details: makeDetails("chain")(results),
						}, "cancelled");
					}
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
					content: [{ type: "text", text: `Too many parallel tasks (${request.items.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
					details: makeDetails("parallel")([]),
					isError: true,
				}, "failed");
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
					thinkingLevel: resolveThinkingLevel(request.items[i].thinking ?? callerThinkingOverride, isGenericAgentSpec(request.items[i].agent) ? request.items[i].agent.thinking : undefined, callerThinking),
				};
			}

			const emitParallelUpdate = (message = "(running...)") => {
				emitProgressUpdate({
					content: [{ type: "text", text: message }],
					details: makeDetails("parallel")([...allResults]),
				});
			};

			try {
				const results = await mapWithConcurrencyLimit(request.items, MAX_CONCURRENCY, async (t, index) => {
					if (signal?.aborted) throw new Error("Subagent was aborted");
					const taskKey = `parallel:${index}`;
					const taskCwd = t.cwd ?? defaultCwd;
					const agentName = getAgentDisplayName(t.agent);
					await todoTracker?.startTask(taskKey, agentName, t.task, taskCwd, undefined, []);
					progressTracker.startTask(taskKey, agentName, t.task);
					emitParallelUpdate();
					try {
						const result = await runSingleAgent(
							defaultCwd,
							availableAgents.agents,
							t.agent,
							t.task,
							t.thinking ?? callerThinkingOverride,
							callerThinking,
							preferredProvider,
							modelRegistry,
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
							trackingQueuePath,
							(pid) => todoTracker?.noteTaskProcess(taskKey, pid),
						);
						allResults[index] = result;
						progressTracker.finishTask(taskKey, !(result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"));
						emitParallelUpdate(getFinalOutput(result.messages) || "(task complete)");
						await todoTracker?.finishTask(taskKey, result);
						return result;
					} catch (error) {
						const cancelled = Boolean(signal?.aborted);
						await todoTracker?.finishTaskWithError(taskKey, error, cancelled ? "cancelled" : "failed");
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
				}, failCount > 0 ? "failed" : "succeeded");
			} catch (error) {
				const cancelled = Boolean(signal?.aborted);
				return await finalizeAndReturn({
					content: [{ type: "text", text: cancelled ? "Parallel subagent run cancelled." : `Subagent execution failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: makeDetails("parallel")(allResults),
					isError: !cancelled,
				}, cancelled ? "cancelled" : "failed");
			}
		}

		if (request.mode === "single") {
			const singleItem = request.items[0];
			const taskKey = "single:0";
			const taskCwd = singleItem.cwd ?? defaultCwd;
			const agentName = getAgentDisplayName(singleItem.agent);
			await todoTracker?.startTask(taskKey, agentName, singleItem.task, taskCwd, undefined, []);
			progressTracker.startTask(taskKey, agentName, singleItem.task);
			emitProgressUpdate({ content: [{ type: "text", text: "(running...)" }], details: makeDetails("single")([]) });
			try {
				const result = await runSingleAgent(
					defaultCwd,
					availableAgents.agents,
					singleItem.agent,
					singleItem.task,
					singleItem.thinking ?? callerThinkingOverride,
					callerThinking,
					preferredProvider,
					modelRegistry,
					taskCwd,
					undefined,
					signal,
					emitProgressUpdate,
					makeDetails("single"),
					trackingQueuePath,
					(pid) => todoTracker?.noteTaskProcess(taskKey, pid),
				);

				await todoTracker?.finishTask(taskKey, result);
				progressTracker.finishTask(taskKey, !(result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"));
				const isError =
					result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg = getResultErrorText(result);
					const outcome = result.stopReason === "aborted" ? "cancelled" : "failed";
					return await finalizeAndReturn({
						content: [{ type: "text", text: outcome === "cancelled" ? `Subagent run cancelled (${result.agent}).` : `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: outcome !== "cancelled",
					}, outcome);
				}

				return await finalizeAndReturn({
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				});
			} catch (error) {
				const cancelled = Boolean(signal?.aborted);
				await todoTracker?.finishTaskWithError(taskKey, error, cancelled ? "cancelled" : "failed");
				progressTracker.finishTask(taskKey, false);
				emitProgressUpdate({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: makeDetails("single")([]) });
				return await finalizeAndReturn({
					content: [{ type: "text", text: cancelled ? `Subagent run cancelled (${agentName}).` : `Subagent execution failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: makeDetails("single")([]),
					isError: !cancelled,
				}, cancelled ? "cancelled" : "failed");
			}
		}

		return await finalizeAndReturn({
			content: [{ type: "text", text: "Invalid parameters." }],
			details: makeDetails("single")([]),
			isError: true,
		}, "failed");
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return await finalizeAndReturn({
			content: [{ type: "text", text: `Subagent execution failed: ${errorMessage}` }],
			details: makeDetails(request.mode)([]),
			isError: true,
		}, signal?.aborted ? "cancelled" : "failed");
	}
}

export default function (pi: ExtensionAPI) {
	let currentModel: { provider: string; id: string } | undefined;
	let currentModelRegistry: ModelRegistryLookup | undefined;

	const rememberModelContext = (ctx: { model?: { provider: string; id: string }; modelRegistry: ModelRegistryLookup }) => {
		currentModel = ctx.model;
		currentModelRegistry = ctx.modelRegistry;
	};

	const findAgentForPreview = (agentName: string) => discoverAgents(process.cwd(), "user").agents.find((agent) => agent.name === agentName);

	const formatPreviewSettings = (
		requestedAgent: RequestedAgent | undefined,
		thinkingOverride: AgentThinkingLevel | undefined,
		theme: ThemeFormatter,
	): string => {
		if (!requestedAgent) return "";

		const resolved = typeof requestedAgent === "string"
			? (() => {
				const agent = findAgentForPreview(requestedAgent);
				if (!agent) return undefined;
				return {
					model: currentModelRegistry
						? resolveAgentModel(agent, currentModel?.provider, currentModelRegistry).model
						: agent.model?.trim() || agent.fallbackModel?.trim() || undefined,
					thinking: agent.thinking,
				};
			})()
			: {
				model: resolveRequestedModel(requestedAgent.model, currentModel?.provider, currentModelRegistry),
				thinking: requestedAgent.thinking,
			};
		if (!resolved) return "";

		const resolvedModel = resolved.model?.trim() || undefined;
		const resolvedParts = splitQualifiedModel(resolvedModel);
		const providerText = resolvedParts.provider
			? currentModel?.provider === resolvedParts.provider ? "inherit" : resolvedParts.provider
			: "inherit";
		const modelText = resolvedParts.id
			? currentModel?.id === resolvedParts.id ? "inherit" : resolvedParts.id
			: "inherit";
		const requestedThinking = thinkingOverride ?? resolved.thinking;
		const thinkingText = !requestedThinking || requestedThinking === "inherit" ? "inherit" : requestedThinking;
		return ` ${theme.fg("dim", `[provider:${providerText}, model:${modelText}, thinking:${thinkingText}]`)}`;
	};

	pi.on("session_start", async (_event, ctx) => {
		rememberModelContext(ctx as { model?: { provider: string; id: string }; modelRegistry: ModelRegistryLookup });
		if (process.env[AMP_SUBAGENT_PROCESS_ENV] === "1") return;
		applyMainTodoQueuePath(ctx.cwd);
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

	pi.on("model_select", async (event, ctx) => {
		rememberModelContext({ model: event.model as { provider: string; id: string }, modelRegistry: ctx.modelRegistry as ModelRegistryLookup });
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (process.env[AMP_SUBAGENT_PROCESS_ENV] === "1") return;
		applyMainTodoQueuePath(ctx.cwd);
	});

	pi.on("session_fork", async (_event, ctx) => {
		if (process.env[AMP_SUBAGENT_PROCESS_ENV] === "1") return;
		applyMainTodoQueuePath(ctx.cwd);
	});

	pi.registerTool({
		name: "subagent_start",
		label: "Subagent Start",
		description: "Start an asynchronous subagent run and return immediately with a run id.",
		parameters: SubagentParams,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			rememberModelContext(ctx as { model?: { provider: string; id: string }; modelRegistry: ModelRegistryLookup });
			pruneBackgroundRuns();
			const normalized = normalizeSubagentRequest(params, ctx.cwd);
			if (!normalized.request) {
				return {
					content: [{ type: "text", text: `${normalized.error ?? "Invalid parameters."}\nAvailable agents: ${getAvailableAgentsText(ctx.cwd)}` }],
					details: { mode: "single", results: [] },
					isError: true,
				};
			}

			const tracker = await SqTodoTracker.create(normalized.request.trackingCwd, normalized.request.mode, toolCallId, normalized.request.runTitle);
			const runId = tracker?.getRunId();
			if (!tracker || !runId) {
				return {
					content: [{ type: "text", text: "Failed to initialize sq tracking for the async run." }],
					details: { mode: normalized.request.mode, results: [] },
					isError: true,
				};
			}

			const queuePath = tracker.getQueuePath();
			const abortController = new AbortController();
			const record: BackgroundRunRecord = {
				runId,
				queuePath,
				request: normalized.request,
				status: "queued",
				startedAt: new Date().toISOString(),
				abortController,
				tracker,
			};
			backgroundRuns.set(buildBackgroundRunKey(runId), record);

			record.promise = executeSubagentRequest(
				toolCallId,
				normalized.request,
				ctx.cwd,
				pi.getThinkingLevel(),
				undefined,
				ctx.model?.provider,
				ctx.modelRegistry,
				abortController.signal,
				(partial) => {
					record.latest = partial;
					record.status = abortController.signal.aborted ? "cancelled" : "running";
				},
				tracker,
				{ execution: "async" },
			)
				.then((result) => {
					record.latest = result;
					record.final = result;
					record.status = record.status === "cancelled" || abortController.signal.aborted ? "cancelled" : result.isError ? "failed" : "succeeded";
					record.completedAt = new Date().toISOString();
					pruneBackgroundRuns();
				})
				.catch((error) => {
					const cancelled = abortController.signal.aborted;
					record.final = {
						content: [{ type: "text", text: cancelled ? "Subagent run cancelled." : `Subagent execution failed: ${error instanceof Error ? error.message : String(error)}` }],
						details: { mode: normalized.request.mode, results: [] },
						isError: !cancelled,
					};
					record.latest = record.final;
					record.status = cancelled ? "cancelled" : "failed";
					record.completedAt = new Date().toISOString();
					pruneBackgroundRuns();
				});

			return {
				content: [
					{
						type: "text",
						text: [
							`Started async subagent run ${runId}.`,
							`Queue: ${queuePath}`,
							`Mode: ${normalized.request.mode}`,
							"Use subagent_status, subagent_results, or subagent_cancel with this runId.",
						].join("\n"),
					},
				],
				details: { mode: normalized.request.mode, results: [] },
			};
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Check the current status of an async subagent run by run id.",
		parameters: AsyncRunLookupParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			pruneBackgroundRuns();
			const live = backgroundRuns.get(buildRunLookup(params).key);
			if (!live) return await buildStoredRunResult(ctx.cwd, params);

			const status = getBackgroundRunStatus(live);
			const progress = live.latest ? extractSummaryLines(live.latest).progress : [];
			const lines = [
				`Run: ${live.runId}`,
				`Status: ${status}`,
				`Queue: ${live.queuePath}`,
				`Mode: ${live.request.mode}`,
			];
			if (progress.length > 0) lines.push("", ...progress);
			else if (live.final) lines.push("", getResultSummaryText(live.final));
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: live.latest?.details ?? { mode: live.request.mode, results: [] },
				isError: status === "failed",
			};
		},
	});

	pi.registerTool({
		name: "subagent_results",
		label: "Subagent Results",
		description: "Read the latest or final results for an async subagent run by run id.",
		parameters: AsyncRunLookupParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			pruneBackgroundRuns();
			const live = backgroundRuns.get(buildRunLookup(params).key);
			if (!live) return await buildStoredRunResult(ctx.cwd, params);

			const base = live.final ?? live.latest ?? {
				content: [{ type: "text", text: "(no output yet)" }],
				details: { mode: live.request.mode, results: [] },
			};
			const header = [`Run: ${live.runId}`, `Status: ${getBackgroundRunStatus(live)}`, `Queue: ${live.queuePath}`, ""].join("\n");
			const content = [...base.content];
			const firstTextIndex = content.findIndex((part) => part.type === "text");
			if (firstTextIndex >= 0) {
				const current = content[firstTextIndex];
				if (current.type === "text") content[firstTextIndex] = { ...current, text: `${header}${current.text}` };
			} else {
				content.unshift({ type: "text", text: header.trimEnd() });
			}
			return {
				...base,
				content,
				isError: getBackgroundRunStatus(live) === "failed",
			};
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Subagent Cancel",
		description: "Request cancellation for a live async subagent run by run id.",
		parameters: AsyncRunLookupParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			pruneBackgroundRuns();
			const live = backgroundRuns.get(buildRunLookup(params).key);
			if (!live) {
				const stored = await loadTrackedRun(ctx.cwd, params.runId);
				if (!stored) {
					return {
						content: [{ type: "text", text: `Run ${params.runId} was not found in the resolved sq queue.` }],
						details: { mode: "single", results: [] },
						isError: true,
					};
				}
				const runMeta = asRecord(stored.run.metadata.subagent) ?? {};
				const state = asString(runMeta.state) ?? stored.run.status;
				const isFinal = state === "succeeded" || state === "failed" || state === "cancelled" || stored.run.status === "closed";
				return {
					content: [{ type: "text", text: isFinal ? `Run ${params.runId} is already ${state}.` : `Run ${params.runId} is not live in this session, so it cannot be cancelled here.` }],
					details: { mode: "single", results: [] },
					isError: !isFinal,
				};
			}

			if (live.final) {
				return {
					content: [{ type: "text", text: `Run ${live.runId} is already ${getBackgroundRunStatus(live)}.` }],
					details: live.final.details,
				};
			}
			if (live.abortController.signal.aborted) {
				return {
					content: [{ type: "text", text: `Cancellation already requested for run ${live.runId}.` }],
					details: live.latest?.details ?? { mode: live.request.mode, results: [] },
				};
			}

			live.status = "cancelled";
			live.abortController.abort();
			await live.tracker?.markCancellationRequested();
			return {
				content: [{ type: "text", text: `Cancellation requested for run ${live.runId}.` }],
				details: live.latest?.details ?? { mode: live.request.mode, results: [] },
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Pass `steps` as an array: one step runs a single subagent, multiple steps run in parallel.",
			"Set `sequential:true` to run steps as a chain with optional {previous} placeholders.",
			"Each step agent can be a saved agent name or an inline generic agent object with systemPrompt, tools, model, and thinking.",
			"Thinking is configured per step; use thinking: \"inherit\" to use the caller's current thinking level.",
			"Uses user agents from ~/.pi/agent/agents.",
			"Use `subagent_start` for background runs with persistent sq tracking.",
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			rememberModelContext(ctx as { model?: { provider: string; id: string }; modelRegistry: ModelRegistryLookup });
			const callerThinking = pi.getThinkingLevel();
			const normalized = normalizeSubagentRequest(params, ctx.cwd);
			if (!normalized.request) {
				const available = getAvailableAgentsText(ctx.cwd);
				return {
					content: [{ type: "text", text: `Invalid parameters. ${normalized.error ?? "Unknown error."}\nAvailable agents: ${available}` }],
					details: { mode: "single", results: [] },
				};
			}
			return await executeSubagentRequest(
				toolCallId,
				normalized.request,
				ctx.cwd,
				callerThinking,
				undefined,
				ctx.model?.provider,
				ctx.modelRegistry,
				signal,
				onUpdate,
			);
		},

		renderCall(args, theme) {
			const settingsText = (agent: RequestedAgent | undefined, thinking?: AgentThinkingLevel) =>
				formatPreviewSettings(agent, thinking, theme);
			const steps = Array.isArray(args.steps) ? args.steps : [];
			const mode = getSubagentMode({ steps, sequential: args.sequential });
			if (mode === "chain") {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${steps.length} steps)`);
				for (let i = 0; i < Math.min(steps.length, 3); i++) {
					const step = steps[i];
					const agent = step?.agent as RequestedAgent | undefined;
					const agentName = agent ? getAgentDisplayName(agent) : "...";
					const taskText = typeof step?.task === "string" ? step.task : "";
					const thinking = typeof step?.thinking === "string" ? step.thinking : undefined;
					const cleanTask = taskText.replace(/\{previous\}/g, "").trim();
					const preview = wrapTaskPreview(cleanTask);
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", agentName) +
						settingsText(agent, thinking) +
						theme.fg("dim", ` ${preview}`);
				}
				if (steps.length > 3) text += `\n  ${theme.fg("muted", `... +${steps.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (mode === "parallel") {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${steps.length} tasks)`);
				for (const step of steps.slice(0, 3)) {
					const agent = step?.agent as RequestedAgent | undefined;
					const agentName = agent ? getAgentDisplayName(agent) : "...";
					const taskText = typeof step?.task === "string" ? step.task : "";
					const thinking = typeof step?.thinking === "string" ? step.thinking : undefined;
					const preview = wrapTaskPreview(taskText);
					text += `\n  ${theme.fg("accent", agentName)}${settingsText(agent, thinking)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (steps.length > 3) text += `\n  ${theme.fg("muted", `... +${steps.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const step = steps[0];
			const agent = step?.agent as RequestedAgent | undefined;
			const agentName = agent ? getAgentDisplayName(agent) : "...";
			const taskText = typeof step?.task === "string" ? step.task : "";
			const thinking = typeof step?.thinking === "string" ? step.thinking : undefined;
			const preview = wrapTaskPreview(taskText, 108, 4);
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				settingsText(agent, thinking);
			text += `\n  ${theme.fg("dim", preview)}`;
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
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${formatResultMeta(r, theme)}`;
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
					const usageStr = formatUsageStats(r.usage);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${buildSummaryPrefix()}${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${formatResultMeta(r, theme)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && errorText) text += `\n${theme.fg("error", `Error: ${errorText}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage);
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

				if (expanded) {
					const container = new Container();
					appendSummaryHeader(container);
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIsError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
						const rIcon = rIsError ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const errorText = rIsError ? getResultErrorText(r) : "";

						container.addChild(new Spacer(1));
						const stepHeader = `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}${formatResultMeta(r, theme)}`;
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

						const stepUsage = formatUsageStats(r.usage);
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
				for (const r of details.results) {
					const rIsError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
					const rIcon = rIsError ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const errorText = rIsError ? getResultErrorText(r) : "";
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}${formatResultMeta(r, theme)}`;
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
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIsError = isFailedResult(r);
						const rIcon = rIsError ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const errorText = rIsError ? getResultErrorText(r) : "";

						container.addChild(new Spacer(1));
						const taskHeader = `${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}${formatResultMeta(r, theme)}`;
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

						const taskUsage = formatUsageStats(r.usage);
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
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}${formatResultMeta(r, theme)}`;
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
