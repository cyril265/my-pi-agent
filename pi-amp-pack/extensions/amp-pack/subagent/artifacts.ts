import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { Queue, mergeMetadata, resolveQueuePath } from "../../../sq-node/dist/index.js";

export type SubagentMode = "single" | "parallel" | "chain";
export type PersistedAgentSource = "user" | "project" | "inline" | "unknown";
export type PersistedThinkingLevel = "low" | "medium" | "high" | "xhigh";

export interface PersistableUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface PersistableSubagentResult {
	agent: string;
	agentSource: PersistedAgentSource;
	task: string;
	taskCwd: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: PersistableUsageStats;
	stepIndex: number;
	model?: string;
	thinkingLevel?: PersistedThinkingLevel;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface PersistedStepArtifact {
	stepIndex: number;
	step?: number;
	agent: string;
	agentSource: PersistedAgentSource;
	status: "succeeded" | "failed";
	exitCode: number;
	stopReason?: string;
	model?: string;
	thinkingLevel?: PersistedThinkingLevel;
	taskCwd: string;
	outputFile: string;
	rawFile: string;
}

export interface SubagentArtifactBundle {
	runId: string;
	runDir: string;
	queuePath: string;
	summaryFile: string;
	steps: PersistedStepArtifact[];
}

export interface PersistedSubagentRunMetadata extends SubagentArtifactBundle {
	createdAt: string;
	mode: SubagentMode;
	toolCallId: string;
	baseCwd: string;
}

function resolveArtifactsRoot(baseCwd: string): string {
	return path.join(baseCwd, ".tmp", "subagent-runs");
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
		}
	}
	return items;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: PersistableUsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
}

function formatToolCallPlain(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			return `$ ${command}`;
		}
		case "read": {
			const filePath = ((args.file_path || args.path || "...") as string) || "...";
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset === undefined && limit === undefined) return `read ${filePath}`;
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			return `read ${filePath}:${startLine}${endLine ? `-${endLine}` : ""}`;
		}
		case "write":
			return `write ${((args.file_path || args.path || "...") as string) || "..."}`;
		case "edit":
			return `edit ${((args.file_path || args.path || "...") as string) || "..."}`;
		default:
			return `${toolName} ${JSON.stringify(args)}`;
	}
}

function isFailedResult(result: PersistableSubagentResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return JSON.stringify({ error: `Could not serialize artifact payload: ${message}` }, null, 2);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequiredString(source: Record<string, unknown>, key: string, context: string): string {
	const value = source[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${context} is missing string field ${key}`);
	}
	return value;
}

function getOptionalString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getRequiredNumber(source: Record<string, unknown>, key: string, context: string): number {
	const value = source[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${context} is missing numeric field ${key}`);
	}
	return value;
}

function parseStepArtifacts(value: unknown, runId: string): PersistedStepArtifact[] {
	if (!Array.isArray(value)) {
		throw new Error(`sq run ${runId} is missing subagent.artifacts.steps`);
	}
	return value.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`sq run ${runId} has invalid step artifact at index ${index}`);
		const context = `sq run ${runId} step ${index}`;
		return {
			stepIndex: getRequiredNumber(entry, "stepIndex", context),
			step: typeof entry.step === "number" && Number.isFinite(entry.step) ? entry.step : undefined,
			agent: getRequiredString(entry, "agent", context),
			agentSource: getRequiredString(entry, "agentSource", context) as PersistedAgentSource,
			status: getRequiredString(entry, "status", context) as "succeeded" | "failed",
			exitCode: getRequiredNumber(entry, "exitCode", context),
			stopReason: getOptionalString(entry, "stopReason"),
			model: getOptionalString(entry, "model"),
			thinkingLevel: getOptionalString(entry, "thinkingLevel") as PersistedThinkingLevel | undefined,
			taskCwd: getRequiredString(entry, "taskCwd", context),
			outputFile: getRequiredString(entry, "outputFile", context),
			rawFile: getRequiredString(entry, "rawFile", context),
		};
	});
}

function parsePersistedSubagentRunMetadata(metadata: Record<string, unknown>, runId: string): PersistedSubagentRunMetadata {
	const subagent = metadata.subagent;
	if (!isRecord(subagent)) throw new Error(`sq run ${runId} has no subagent metadata`);
	const artifacts = subagent.artifacts;
	if (!isRecord(artifacts)) throw new Error(`sq run ${runId} has no subagent.artifacts metadata`);
	const context = `sq run ${runId} artifacts`;
	return {
		runId: getRequiredString(artifacts, "runId", context),
		runDir: getRequiredString(artifacts, "runDir", context),
		queuePath: getRequiredString(artifacts, "queuePath", context),
		summaryFile: getRequiredString(artifacts, "summaryFile", context),
		steps: parseStepArtifacts(artifacts.steps, runId),
		createdAt: getRequiredString(artifacts, "createdAt", context),
		mode: getRequiredString(artifacts, "mode", context) as SubagentMode,
		toolCallId: getRequiredString(artifacts, "toolCallId", context),
		baseCwd: getRequiredString(artifacts, "baseCwd", context),
	};
}

function buildStepMarkdown(runId: string, result: PersistableSubagentResult, artifact: PersistedStepArtifact): string {
	const lines: string[] = [];
	const status = artifact.status;
	const finalOutput = getFinalOutput(result.messages);
	const transcript = getDisplayItems(result.messages);
	const usageText = formatUsageStats(result.usage);
	const errorText = truncateText(result.errorMessage || result.stderr || finalOutput || "(no output)", 12000);

	lines.push(`# Subagent step ${result.stepIndex}`);
	lines.push(``);
	lines.push(`- runId: ${runId}`);
	lines.push(`- stepIndex: ${result.stepIndex}`);
	if (result.step !== undefined) lines.push(`- step: ${result.step}`);
	lines.push(`- agent: ${result.agent}`);
	lines.push(`- agentSource: ${result.agentSource}`);
	lines.push(`- status: ${status}`);
	lines.push(`- exitCode: ${result.exitCode}`);
	if (result.stopReason) lines.push(`- stopReason: ${result.stopReason}`);
	if (result.model) lines.push(`- model: ${result.model}`);
	if (result.thinkingLevel) lines.push(`- thinkingLevel: ${result.thinkingLevel}`);
	lines.push(`- taskCwd: ${result.taskCwd}`);
	lines.push(`- outputFile: ${artifact.outputFile}`);
	lines.push(`- rawFile: ${artifact.rawFile}`);
	lines.push(``);
	lines.push(`## Task`);
	lines.push(``);
	lines.push(result.task || "(no task)");

	if (finalOutput) {
		lines.push(``, `## Final output`, ``, finalOutput);
	} else if (status === "failed") {
		lines.push(``, `## Error`, ``, errorText);
	}

	if (transcript.length > 0) {
		lines.push(``, `## Assistant/tool transcript`, ``);
		for (const item of transcript) {
			if (item.type === "toolCall") lines.push(`- ${formatToolCallPlain(item.name, item.args)}`);
			else lines.push(item.text);
			lines.push("");
		}
	}

	if (result.stderr.trim()) {
		lines.push(``, `## Stderr`, ``, result.stderr.trim());
	}

	if (usageText) {
		lines.push(``, `## Usage`, ``, usageText);
	}

	return lines.join("\n").trimEnd() + "\n";
}

function buildSummaryMarkdown(run: PersistedSubagentRunMetadata): string {
	const lines: string[] = [];
	lines.push(`# Subagent run ${run.runId}`);
	lines.push(``);
	lines.push(`- mode: ${run.mode}`);
	lines.push(`- createdAt: ${run.createdAt}`);
	lines.push(`- baseCwd: ${run.baseCwd}`);
	lines.push(`- runDir: ${run.runDir}`);
	lines.push(`- summaryFile: ${run.summaryFile}`);
	lines.push(`- queuePath: ${run.queuePath}`);
	lines.push(`- toolCallId: ${run.toolCallId}`);
	lines.push(``);
	lines.push(`Use \`subagent_result\` with this \`runId\` for the overview, or add \`stepIndex\` to fetch a single step.`);
	lines.push(``);
	lines.push(`## Steps`);
	lines.push(``);

	for (const step of run.steps) {
		lines.push(`- [stepIndex ${step.stepIndex}] ${step.agent} — ${step.status}`);
		if (step.step !== undefined) lines.push(`  - step: ${step.step}`);
		lines.push(`  - outputFile: ${step.outputFile}`);
		lines.push(`  - rawFile: ${step.rawFile}`);
		lines.push(`  - taskCwd: ${step.taskCwd}`);
		if (step.model) lines.push(`  - model: ${step.model}`);
		if (step.thinkingLevel) lines.push(`  - thinkingLevel: ${step.thinkingLevel}`);
		if (step.stopReason) lines.push(`  - stopReason: ${step.stopReason}`);
	}

	return lines.join("\n").trimEnd() + "\n";
}

export async function persistSubagentRunArtifacts(
	queueResolveCwd: string,
	runId: string | undefined,
	mode: SubagentMode,
	toolCallId: string,
	results: PersistableSubagentResult[],
	baseCwd: string,
): Promise<{ artifacts?: SubagentArtifactBundle; error?: string }> {
	if (!runId) {
		return { error: "sq run id unavailable; could not index subagent artifacts" };
	}

	try {
		const queuePath = resolveQueuePath({ cwd: queueResolveCwd });
		const queue = new Queue(queuePath);
		const existingRun = await queue.find(runId);
		if (!existingRun) {
			return { error: `sq run ${runId} not found in ${queuePath}` };
		}

		const runDir = path.join(resolveArtifactsRoot(baseCwd), runId);
		fs.mkdirSync(runDir, { recursive: true });

		const steps: PersistedStepArtifact[] = [];
		for (const result of results) {
			const baseName = `step-${result.stepIndex.toString().padStart(2, "0")}`;
			const outputFile = path.join(runDir, `${baseName}.md`);
			const rawFile = path.join(runDir, `${baseName}.json`);
			const artifact: PersistedStepArtifact = {
				stepIndex: result.stepIndex,
				step: result.step,
				agent: result.agent,
				agentSource: result.agentSource,
				status: isFailedResult(result) ? "failed" : "succeeded",
				exitCode: result.exitCode,
				stopReason: result.stopReason,
				model: result.model,
				thinkingLevel: result.thinkingLevel,
				taskCwd: result.taskCwd,
				outputFile,
				rawFile,
			};
			steps.push(artifact);

			fs.writeFileSync(outputFile, buildStepMarkdown(runId, result, artifact), "utf-8");
			fs.writeFileSync(
				rawFile,
				safeJsonStringify({
					runId,
					stepIndex: result.stepIndex,
					result,
				}),
				"utf-8",
			);
		}

		const summaryFile = path.join(runDir, "summary.md");
		const run: PersistedSubagentRunMetadata = {
			runId,
			createdAt: new Date().toISOString(),
			mode,
			toolCallId,
			baseCwd,
			runDir,
			queuePath,
			summaryFile,
			steps,
		};
		fs.writeFileSync(summaryFile, buildSummaryMarkdown(run), "utf-8");

		const updatedRun = await queue.update(runId, {
			metadata: mergeMetadata(existingRun.metadata ?? {}, {
				subagent: {
					artifacts: run,
				},
			}),
		});
		if (!updatedRun) {
			return { error: `sq run ${runId} disappeared while writing artifacts` };
		}

		return {
			artifacts: {
				runId,
				runDir,
				queuePath,
				summaryFile,
				steps,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: message };
	}
}

async function readPersistedSubagentRunMetadata(
	queueResolveCwd: string,
	runId: string,
): Promise<PersistedSubagentRunMetadata> {
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) throw new Error("runId is required.");
	const queuePath = resolveQueuePath({ cwd: queueResolveCwd });
	const queue = new Queue(queuePath);
	const run = await queue.find(normalizedRunId);
	if (!run) {
		throw new Error(`No saved subagent run found for ${normalizedRunId} in ${queuePath}`);
	}
	return parsePersistedSubagentRunMetadata(run.metadata ?? {}, normalizedRunId);
}

export async function readSubagentRunSummary(
	queueResolveCwd: string,
	runId: string,
): Promise<{ run: PersistedSubagentRunMetadata; content: string }> {
	const run = await readPersistedSubagentRunMetadata(queueResolveCwd, runId);
	if (!fs.existsSync(run.summaryFile)) {
		throw new Error(`Summary file not found for run ${run.runId}: ${run.summaryFile}`);
	}
	return {
		run,
		content: fs.readFileSync(run.summaryFile, "utf-8"),
	};
}

export async function readSubagentRunStep(
	queueResolveCwd: string,
	runId: string,
	stepIndex: number,
): Promise<{ run: PersistedSubagentRunMetadata; step: PersistedStepArtifact; content: string }> {
	const run = await readPersistedSubagentRunMetadata(queueResolveCwd, runId);
	const step = run.steps.find((candidate) => candidate.stepIndex === stepIndex);
	if (!step) {
		const available = run.steps.map((candidate) => candidate.stepIndex).join(", ") || "none";
		throw new Error(`Run ${run.runId} has no stepIndex ${stepIndex}. Available step indexes: ${available}`);
	}
	if (!fs.existsSync(step.outputFile)) {
		throw new Error(`Output file not found for run ${run.runId} stepIndex ${stepIndex}: ${step.outputFile}`);
	}
	return {
		run,
		step,
		content: fs.readFileSync(step.outputFile, "utf-8"),
	};
}
