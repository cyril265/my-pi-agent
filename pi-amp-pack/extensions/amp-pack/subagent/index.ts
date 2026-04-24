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
 * Persists final run artifacts under repo-local .tmp and indexes them in sq metadata so callers can inspect full outputs later via subagent_result.
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
import {
	persistSubagentRunArtifacts,
	readSubagentRunStep,
	readSubagentRunSummary,
	type PersistableSubagentResult,
	type SubagentArtifactBundle,
	type SubagentMode,
} from "./artifacts.js";
import { type AgentConfig, type AgentDiscoveryResult, type AgentThinkingLevel, discoverAgents } from "./agents.js";
import { SqTodoTracker, extractSummaryLines, getResultSummaryText, withTodoTrackingNote } from "./todo-tracking.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_CHAIN_PREVIOUS_CHARS = 12000;
const AMP_SUBAGENT_PROCESS_ENV = "PI_AMP_SUBAGENT";

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

interface SingleResult extends PersistableSubagentResult {
	agentSource: AgentSource;
	usage: UsageStats;
	thinkingLevel?: EffectiveThinkingLevel;
}

interface SubagentDetails {
	mode: SubagentMode;
	results: SingleResult[];
	artifacts?: SubagentArtifactBundle;
	artifactError?: string;
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

function getArtifactNoticeLines(details: SubagentDetails | undefined): string[] {
	if (details?.artifacts) {
		return [
			`Subagent run: ${details.artifacts.runId}`,
			`Summary file: ${details.artifacts.summaryFile}`,
			"Use subagent_result with runId and optional stepIndex for full outputs.",
		];
	}
	if (details?.artifactError) {
		return [`Artifacts unavailable: ${details.artifactError}`];
	}
	return [];
}

function attachArtifactSummary(result: AgentToolResult<SubagentDetails>): AgentToolResult<SubagentDetails> {
	const noticeLines = getArtifactNoticeLines(result.details as SubagentDetails | undefined);
	if (noticeLines.length === 0) return result;
	const content = [...result.content];
	const firstTextIndex = content.findIndex((part) => part.type === "text");
	const notice = noticeLines.join("\n");
	if (firstTextIndex >= 0) {
		const current = content[firstTextIndex];
		if (current.type === "text") content[firstTextIndex] = { ...current, text: `${notice}\n\n${current.text}` };
	} else {
		content.unshift({ type: "text", text: notice });
	}
	return { ...result, content };
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
	stepIndex: number,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const resolved = buildResolvedAgent(agents, requestedAgent, preferredProvider, modelRegistry);
	const agentName = resolved.config?.name ?? getAgentDisplayName(requestedAgent);

	if (!resolved.config) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: resolved.unknownAgentName ?? agentName,
			agentSource: "unknown",
			task,
			taskCwd: cwd ?? defaultCwd,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${resolved.unknownAgentName ?? agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			stepIndex,
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
		taskCwd: cwd ?? defaultCwd,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		stepIndex,
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
			env: { ...process.env, [AMP_SUBAGENT_PROCESS_ENV]: "1" },
			signal,
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
		if (result.aborted) throw new Error("Subagent was aborted");
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

const SubagentResultParams = Type.Object(
	{
		runId: Type.String({ description: "Run id returned by subagent." }),
		stepIndex: Type.Optional(Type.Number({ minimum: 0, description: "Optional zero-based step index to fetch a single step result." })),
	},
	{ additionalProperties: false },
);

interface StepInput {
	agent: RequestedAgent;
	task: string;
	thinking?: AgentThinkingLevel;
	cwd?: string;
}

interface AgentInvocation {
	taskCwd: string;
	discovery: AgentDiscoveryResult;
}

interface SubagentResultDetails {
	runId: string;
	mode: SubagentMode;
	runDir: string;
	queuePath: string;
	summaryFile: string;
	stepIndex?: number;
	outputFile?: string;
	rawFile?: string;
	availableSteps: Array<{
		stepIndex: number;
		step?: number;
		agent: string;
		status: "succeeded" | "failed";
		outputFile: string;
		rawFile: string;
	}>;
}

function resolveInvocationCwd(defaultCwd: string, requestedCwd: string | undefined): string {
	if (!requestedCwd) return defaultCwd;
	return path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(defaultCwd, requestedCwd);
}

function resolveAgentInvocation(defaultCwd: string, _requestedAgent: RequestedAgent, requestedCwd: string | undefined): AgentInvocation {
	const taskCwd = resolveInvocationCwd(defaultCwd, requestedCwd);
	const discovery = discoverAgents(taskCwd, "user");
	return { taskCwd, discovery };
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
	});

	pi.on("model_select", async (event, ctx) => {
		rememberModelContext({ model: event.model as { provider: string; id: string }, modelRegistry: ctx.modelRegistry as ModelRegistryLookup });
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
			"Returns a runId and saves full outputs under repo-local .tmp so you can inspect them later with subagent_result.",
			"Uses user agents from ~/.pi/agent/agents.",
			"Todo tracking is always attempted in the nearest .sift/issues.jsonl queue for the invocation.",
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			rememberModelContext(ctx as { model?: { provider: string; id: string }; modelRegistry: ModelRegistryLookup });
			const baseDiscovery = discoverAgents(ctx.cwd, "user");
			const callerThinking = pi.getThinkingLevel();
			const validationError = validateSubagentParams(params);

			const mode = getSubagentMode(params);
			const makeDetails =
				(detailsMode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode: detailsMode,
					results,
				});

			if (validationError) {
				const available = baseDiscovery.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. ${validationError}\nAvailable agents: ${available}` }],
					details: makeDetails("single")([]),
				};
			}

			const plannedTasks = params.steps.map((step, index) => ({
				key: `${mode}:${index}`,
				agent: getAgentDisplayName(step.agent),
				task: step.task,
				step: mode === "chain" ? index + 1 : undefined,
			}));
			const progressTracker = new RunProgressTracker(mode, plannedTasks);
			const emitProgressUpdate = (partial: AgentToolResult<SubagentDetails>) => onUpdate?.(attachProgressSummary(partial, progressTracker));
			emitProgressUpdate({ content: [{ type: "text", text: "(starting...)" }], details: makeDetails(mode)([]) });

			const trackingCwd = resolveTrackingCwd(params, ctx.cwd);
			const todoTracker = await SqTodoTracker.create(trackingCwd, mode, toolCallId, params.runTitle);
			const finalizeAndReturn = async (result: AgentToolResult<SubagentDetails>) => {
				const details = result.details ?? makeDetails(mode)([]);
				const persisted = await persistSubagentRunArtifacts(
					trackingCwd,
					todoTracker?.getRunId(),
					mode,
					toolCallId,
					details.results,
					trackingCwd,
				);
				const resultWithArtifacts: AgentToolResult<SubagentDetails> = {
					...result,
					details: {
						...details,
						artifacts: persisted.artifacts,
						artifactError: persisted.error,
					},
				};
				const withProgress = attachProgressSummary(resultWithArtifacts, progressTracker);
				const withArtifacts = attachArtifactSummary(withProgress);
				await todoTracker?.finalize(!result.isError, getResultSummaryText(withArtifacts));
				return withTodoTrackingNote(withArtifacts, todoTracker?.statusNote());
			};

			try {
				if (mode === "chain") {
					const results: SingleResult[] = [];
					let previousOutput = "";

					for (let i = 0; i < params.steps.length; i++) {
						const step = params.steps[i];
						const taskKey = `chain:${i}`;
						const previousTaskId = i > 0 ? todoTracker?.getTaskId(`chain:${i - 1}`) : undefined;
						const invocation = resolveAgentInvocation(ctx.cwd, step.agent, resolveStepCwd(step, params, ctx.cwd));
						const boundedPrevious = buildChainContext(previousOutput);
						const taskWithContext = step.task.replace(/\{previous\}/g, boundedPrevious);

						const agentName = getAgentDisplayName(step.agent);
						await todoTracker?.startTask(
							taskKey,
							agentName,
							taskWithContext,
							invocation.taskCwd,
							i + 1,
							previousTaskId ? [previousTaskId] : [],
						);
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
								invocation.discovery.agents,
								step.agent,
								taskWithContext,
								step.thinking,
								callerThinking,
								ctx.model?.provider,
								ctx.modelRegistry,
								invocation.taskCwd,
								i,
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
									content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${getAgentDisplayName(step.agent)}): ${errorMsg}` }],
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

				if (mode === "parallel") {
					if (params.steps.length > MAX_PARALLEL_TASKS) {
						return await finalizeAndReturn({
							content: [
								{ type: "text", text: `Too many parallel tasks (${params.steps.length}). Max is ${MAX_PARALLEL_TASKS}.` },
							],
							details: makeDetails("parallel")([]),
							isError: true,
						});
					}

					const allResults: SingleResult[] = new Array(params.steps.length);
					for (let i = 0; i < params.steps.length; i++) {
						allResults[i] = {
							agent: getAgentDisplayName(params.steps[i].agent),
							agentSource: "unknown",
							task: params.steps[i].task,
							taskCwd: resolveStepCwd(params.steps[i], params, ctx.cwd),
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							stepIndex: i,
							thinkingLevel: resolveThinkingLevel(
								params.steps[i].thinking,
								isGenericAgentSpec(params.steps[i].agent) ? params.steps[i].agent.thinking : undefined,
								callerThinking,
							),
						};
					}

					const emitParallelUpdate = (message = "(running...)") => {
						emitProgressUpdate({
							content: [{ type: "text", text: message }],
							details: makeDetails("parallel")([...allResults]),
						});
					};

					const results = await mapWithConcurrencyLimit(params.steps, MAX_CONCURRENCY, async (t, index) => {
						const taskKey = `parallel:${index}`;
						const agentName = getAgentDisplayName(t.agent);
						const invocation = resolveAgentInvocation(ctx.cwd, t.agent, resolveStepCwd(t, params, ctx.cwd));
						await todoTracker?.startTask(taskKey, agentName, t.task, invocation.taskCwd, undefined, []);
						progressTracker.startTask(taskKey, agentName, t.task);
						emitParallelUpdate();
						try {
							const result = await runSingleAgent(
								ctx.cwd,
								invocation.discovery.agents,
								t.agent,
								t.task,
								t.thinking,
								callerThinking,
								ctx.model?.provider,
								ctx.modelRegistry,
								invocation.taskCwd,
								index,
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
						return `[#${r.stepIndex} ${r.agent}] ${failed ? "failed" : "completed"}: ${preview || "(no output)"}`;
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

				if (mode === "single") {
					const step = params.steps[0]!;
					const agentName = getAgentDisplayName(step.agent);
					const invocation = resolveAgentInvocation(ctx.cwd, step.agent, resolveStepCwd(step, params, ctx.cwd));
					const taskKey = "single:0";
					await todoTracker?.startTask(taskKey, agentName, step.task, invocation.taskCwd, undefined, []);
					progressTracker.startTask(taskKey, agentName, step.task);
					emitProgressUpdate({ content: [{ type: "text", text: "(running...)" }], details: makeDetails("single")([]) });
					try {
						const result = await runSingleAgent(
							ctx.cwd,
							invocation.discovery.agents,
							step.agent,
							step.task,
							step.thinking,
							callerThinking,
							ctx.model?.provider,
							ctx.modelRegistry,
							invocation.taskCwd,
							0,
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
					content: [{ type: "text", text: "Invalid parameters. Unsupported subagent mode." }],
					details: makeDetails("single")([]),
					isError: true,
				});
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				return await finalizeAndReturn({
					content: [{ type: "text", text: `Subagent execution failed: ${errorMessage}` }],
					details: makeDetails(mode)([]),
					isError: true,
				});
			}
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
			const artifactSummaryLines = details?.artifacts
				? [
					`Artifacts: ${details.artifacts.runId}`,
					`Summary: ${details.artifacts.summaryFile}`,
				]
				: details?.artifactError
					? [`Artifacts unavailable: ${details.artifactError}`]
					: [];
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
				if (summaryLines.progress.length === 0 && artifactSummaryLines.length === 0 && !summaryLines.todo) return;
				for (const line of summaryLines.progress) container.addChild(new Text(theme.fg("accent", line), 0, 0));
				for (const line of artifactSummaryLines) container.addChild(new Text(theme.fg("muted", line), 0, 0));
				if (summaryLines.todo) container.addChild(new Text(theme.fg("muted", summaryLines.todo), 0, 0));
				container.addChild(new Spacer(1));
			};

			const buildSummaryPrefix = () => {
				const parts: string[] = [];
				for (const line of summaryLines.progress) parts.push(theme.fg("accent", line));
				for (const line of artifactSummaryLines) parts.push(theme.fg("muted", line));
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
						const stepHeader = `${theme.fg("muted", `─── Step ${r.step} [#${r.stepIndex}]: `) + theme.fg("accent", r.agent)} ${rIcon}${formatResultMeta(r, theme)}`;
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
					text += `\n\n${theme.fg("muted", `─── Step ${r.step} [#${r.stepIndex}]: `)}${theme.fg("accent", r.agent)} ${rIcon}${formatResultMeta(r, theme)}`;
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
						const taskHeader = `${theme.fg("muted", `─── [#${r.stepIndex}] `) + theme.fg("accent", r.agent)} ${rIcon}${formatResultMeta(r, theme)}`;
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
					text += `\n\n${theme.fg("muted", `─── [#${r.stepIndex}] `)}${theme.fg("accent", r.agent)} ${rIcon}${formatResultMeta(r, theme)}`;
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

	pi.registerTool({
		name: "subagent_result",
		label: "Subagent Result",
		description: [
			"Fetch saved output from a previous subagent run.",
			"Use the runId returned by subagent.",
			"Without stepIndex it returns the saved run summary.",
			"With stepIndex it returns the saved output for that zero-based step.",
		].join(" "),
		parameters: SubagentResultParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const normalizedRunId = params.runId.trim();
			const normalizedStepIndex = Number.isFinite(params.stepIndex) ? Math.floor(params.stepIndex!) : undefined;
			const queueResolveCwd = ctx.cwd;

			try {
				if (normalizedStepIndex !== undefined) {
					const { run, step, content } = await readSubagentRunStep(queueResolveCwd, normalizedRunId, normalizedStepIndex);
					const details: SubagentResultDetails = {
						runId: run.runId,
						mode: run.mode,
						runDir: run.runDir,
						queuePath: run.queuePath,
						summaryFile: run.summaryFile,
						stepIndex: step.stepIndex,
						outputFile: step.outputFile,
						rawFile: step.rawFile,
						availableSteps: run.steps.map((candidate) => ({
							stepIndex: candidate.stepIndex,
							step: candidate.step,
							agent: candidate.agent,
							status: candidate.status,
							outputFile: candidate.outputFile,
							rawFile: candidate.rawFile,
						})),
					};
					return {
						content: [{ type: "text", text: content }],
						details,
					};
				}

				const { run, content } = await readSubagentRunSummary(queueResolveCwd, normalizedRunId);
				const details: SubagentResultDetails = {
					runId: run.runId,
					mode: run.mode,
					runDir: run.runDir,
					queuePath: run.queuePath,
					summaryFile: run.summaryFile,
					availableSteps: run.steps.map((candidate) => ({
						stepIndex: candidate.stepIndex,
						step: candidate.step,
						agent: candidate.agent,
						status: candidate.status,
						outputFile: candidate.outputFile,
						rawFile: candidate.rawFile,
					})),
				};
				return {
					content: [{ type: "text", text: content }],
					details,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `subagent_result failed: ${message}` }],
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const runId = typeof args.runId === "string" ? args.runId : "...";
			const stepIndex = typeof args.stepIndex === "number" ? args.stepIndex : undefined;
			const text = stepIndex === undefined
				? `${theme.fg("toolTitle", theme.bold("subagent_result "))}${theme.fg("accent", runId)}`
				: `${theme.fg("toolTitle", theme.bold("subagent_result "))}${theme.fg("accent", runId)}${theme.fg("muted", ` stepIndex:${stepIndex}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }) {
			const text = result.content.find((part) => part.type === "text");
			const message = text?.type === "text" ? text.text : "(no output)";
			if (expanded || message.includes("\n")) {
				return new Markdown(message, 0, 0, getMarkdownTheme());
			}
			return new Text(message, 0, 0);
		},
	});
}
