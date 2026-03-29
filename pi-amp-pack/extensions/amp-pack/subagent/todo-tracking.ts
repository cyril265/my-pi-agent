import { Queue, mergeMetadata, resolveQueuePath, type Item } from "../../../sq-node/dist/index.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

const MAX_TODO_TEXT_CHARS = 2400;
const MAX_TODO_SUMMARY_CHARS = 8000;

export interface TodoTrackingSingleResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	thinkingLevel?: string;
	usage?: Record<string, unknown>;
}

export type TrackedRunOutcome = "succeeded" | "failed" | "cancelled";

export interface LoadedTrackedRun {
	runId: string;
	queuePath: string;
	run: Item;
	tasks: Item[];
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function getSubagentMetadata(item: Item): Record<string, unknown> {
	return asRecord(item.metadata.subagent) ?? {};
}

function sortTrackedTasks(tasks: Item[]): Item[] {
	return [...tasks].sort((left, right) => {
		const leftMeta = getSubagentMetadata(left);
		const rightMeta = getSubagentMetadata(right);
		const leftStep = typeof leftMeta.step === "number" ? leftMeta.step : Number.MAX_SAFE_INTEGER;
		const rightStep = typeof rightMeta.step === "number" ? rightMeta.step : Number.MAX_SAFE_INTEGER;
		if (leftStep !== rightStep) return leftStep - rightStep;
		return left.created_at.localeCompare(right.created_at);
	});
}

export async function loadTrackedRun(defaultCwd: string, runId: string): Promise<LoadedTrackedRun | null> {
	const queuePath = resolveQueuePath({ cwd: defaultCwd, env: process.env });
	const queue = new Queue(queuePath);
	const items = await queue.allWithComputedStatus();
	const run = items.find((item) => item.metadata.kind === "subagent_run" && (item.id === runId || getSubagentMetadata(item).runId === runId));
	if (!run) return null;
	const persistedRunId = typeof getSubagentMetadata(run).runId === "string" ? String(getSubagentMetadata(run).runId) : run.id;
	const tasks = sortTrackedTasks(
		items.filter((item) => item.metadata.kind === "subagent_task" && getSubagentMetadata(item).runId === persistedRunId),
	);
	return { runId: persistedRunId, queuePath, run, tasks };
}

export class SqTodoTracker {
	private readonly queuePath: string;
	private readonly queue: Queue;
	private readonly mode: "single" | "parallel" | "chain";
	private readonly runTitle: string;
	private readonly toolCallId: string;
	private readonly warnings: string[] = [];
	private readonly taskIds = new Map<string, string>();
	private runId: string | undefined;
	private disabledReason: string | undefined;
	private finalized = false;

	private constructor(
		queuePath: string,
		mode: "single" | "parallel" | "chain",
		runTitle: string,
		toolCallId: string,
	) {
		this.queuePath = queuePath;
		this.queue = new Queue(queuePath);
		this.mode = mode;
		this.runTitle = runTitle;
		this.toolCallId = toolCallId;
	}

	static async create(
		queueResolveCwd: string,
		mode: "single" | "parallel" | "chain",
		toolCallId: string,
		runTitle: string | undefined,
	): Promise<SqTodoTracker | null> {
		try {
			const queuePath = resolveQueuePath({ cwd: queueResolveCwd, env: process.env });
			const resolvedRunTitle = runTitle?.trim() ? runTitle.trim() : `Subagent ${mode} run`;
			const tracker = new SqTodoTracker(queuePath, mode, resolvedRunTitle, toolCallId);
			await tracker.initialize();
			return tracker;
		} catch {
			return null;
		}
	}

	getRunId(): string | undefined {
		return this.runId;
	}

	getQueuePath(): string {
		return this.queuePath;
	}

	private addWarning(message: string) {
		if (this.warnings.length >= 8) return;
		this.warnings.push(message);
	}

	private async initialize() {
		try {
			const requestedAt = new Date().toISOString();
			const item = await this.queue.push({
				title: this.runTitle,
				description: `Tracking run for subagent ${this.mode} mode`,
				metadata: {
					kind: "subagent_run",
					subagent: {
						state: "queued",
						mode: this.mode,
						toolCallId: this.toolCallId,
						queuePath: this.queuePath,
						requestedAt,
					},
				},
				sources: [],
				blocked_by: [],
			});
			this.runId = item.id;
			await this.mergeItemMetadata(item.id, {
				subagent: {
					runId: item.id,
				},
			});
		} catch (error) {
			this.disabledReason = error instanceof Error ? error.message : String(error);
		}
	}

	isActive(): boolean {
		return Boolean(this.runId) && !this.disabledReason;
	}

	private async setItemStatus(itemId: string, status: "pending" | "in_progress" | "closed") {
		try {
			const updated = status === "closed" ? await this.queue.close(itemId) : await this.queue.update(itemId, { status });
			if (!updated) this.addWarning(`sq update ${itemId} status ${status} failed`);
		} catch {
			this.addWarning(`sq update ${itemId} status ${status} failed`);
		}
	}

	private async mergeItemMetadata(itemId: string, patch: Record<string, unknown>) {
		try {
			const existing = await this.queue.find(itemId);
			if (!existing) {
				this.addWarning(`sq update ${itemId} metadata merge failed`);
				return;
			}
			const updated = await this.queue.update(itemId, {
				metadata: mergeMetadata(existing.metadata ?? {}, patch),
			});
			if (!updated) this.addWarning(`sq update ${itemId} metadata merge failed`);
		} catch {
			this.addWarning(`sq update ${itemId} metadata merge failed`);
		}
	}

	async markRunStarted(extra: Record<string, unknown> = {}) {
		if (!this.isActive() || !this.runId) return;
		await this.setItemStatus(this.runId, "in_progress");
		await this.mergeItemMetadata(this.runId, {
			subagent: {
				state: "running",
				startedAt: new Date().toISOString(),
				...extra,
			},
		});
	}

	private taskOutcome(result: TodoTrackingSingleResult, forcedOutcome?: TrackedRunOutcome): TrackedRunOutcome {
		if (forcedOutcome) return forcedOutcome;
		if (result.stopReason === "aborted") return "cancelled";
		return result.exitCode !== 0 || result.stopReason === "error" ? "failed" : "succeeded";
	}

	getTaskId(taskKey: string): string | undefined {
		return this.taskIds.get(taskKey);
	}

	async startTask(
		taskKey: string,
		agent: string,
		task: string,
		taskCwd: string,
		step: number | undefined,
		blockedByIds: string[],
	) {
		if (!this.isActive() || this.taskIds.has(taskKey) || !this.runId) return;

		const titlePrefix = this.mode === "chain" && step ? `Step ${step}` : this.mode === "parallel" ? "Parallel" : "Task";
		try {
			const startedAt = new Date().toISOString();
			const item = await this.queue.push({
				title: `${titlePrefix}: ${agent}`,
				description: truncateText(task, MAX_TODO_TEXT_CHARS),
				metadata: {
					kind: "subagent_task",
					runId: this.runId,
					taskKey,
					subagent: {
						runId: this.runId,
						state: "running",
						mode: this.mode,
						taskKey,
						agent,
						step,
						taskCwd,
						startedAt,
					},
				},
				sources: [],
				blocked_by: blockedByIds,
			});
			this.taskIds.set(taskKey, item.id);
			await this.setItemStatus(item.id, "in_progress");
		} catch {
			this.addWarning(`sq add task for ${agent} failed`);
		}
	}

	async finishTask(taskKey: string, result: TodoTrackingSingleResult, forcedOutcome?: TrackedRunOutcome) {
		if (!this.isActive()) return;
		const taskId = this.taskIds.get(taskKey);
		if (!taskId) return;

		const outcome = this.taskOutcome(result, forcedOutcome);
		const output = truncateText(getFinalOutput(result.messages), MAX_TODO_SUMMARY_CHARS);
		const errorText = truncateText(result.errorMessage || result.stderr || "", MAX_TODO_SUMMARY_CHARS);
		await this.mergeItemMetadata(taskId, {
			subagent: {
				state: outcome,
				finishedAt: new Date().toISOString(),
				outcome,
				exitCode: result.exitCode,
				stopReason: result.stopReason,
				error: errorText || undefined,
				output: output || undefined,
				model: result.model,
				thinkingLevel: result.thinkingLevel,
				usage: result.usage,
			},
		});

		await this.setItemStatus(taskId, outcome === "failed" ? "pending" : "closed");
	}

	async finishTaskWithError(taskKey: string, error: unknown, outcome: Exclude<TrackedRunOutcome, "succeeded"> = "failed") {
		if (!this.isActive()) return;
		const taskId = this.taskIds.get(taskKey);
		if (!taskId) return;

		const message = error instanceof Error ? error.message : String(error);
		await this.mergeItemMetadata(taskId, {
			subagent: {
				state: outcome,
				finishedAt: new Date().toISOString(),
				outcome,
				error: truncateText(message, MAX_TODO_SUMMARY_CHARS),
			},
		});
		await this.setItemStatus(taskId, outcome === "failed" ? "pending" : "closed");
	}

	async finalize(outcome: TrackedRunOutcome, summary: string) {
		if (this.finalized) return;
		this.finalized = true;
		if (!this.isActive() || !this.runId) return;

		await this.mergeItemMetadata(this.runId, {
			subagent: {
				state: outcome,
				finishedAt: new Date().toISOString(),
				outcome,
				summary: truncateText(summary, MAX_TODO_SUMMARY_CHARS),
				taskCount: this.taskIds.size,
				warnings: this.warnings,
			},
		});

		await this.setItemStatus(this.runId, outcome === "failed" ? "pending" : "closed");
	}

	statusNote(): string | undefined {
		if (this.disabledReason) return `disabled: ${this.disabledReason}`;
		if (!this.runId) return undefined;
		if (this.warnings.length > 0) {
			return `run ${this.runId} (${this.queuePath}) with ${this.warnings.length} warning(s)`;
		}
		return `run ${this.runId} (${this.queuePath})`;
	}
}

export function extractSummaryLines(result: AgentToolResult<any>): { progress: string[]; todo?: string } {
	const firstText = result.content.find((part) => part.type === "text");
	if (!firstText || firstText.type !== "text") return { progress: [] };
	const lines = firstText.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const progress = lines.filter((line) => /^(Plan|Done|Now|Next|Running|Queued|Failed|Status): /.test(line));
	const todo = lines.find((line) => line.startsWith("Todo tracking: "));
	return { progress, todo };
}

export function getResultSummaryText(result: AgentToolResult<any>): string {
	const parts: string[] = [];
	for (const part of result.content) {
		if (part.type === "text") parts.push(part.text);
	}
	const summary = parts.join("\n\n").trim();
	return summary || "(no output)";
}

export function withTodoTrackingNote(result: AgentToolResult<any>, note: string | undefined): AgentToolResult<any> {
	if (!note) return result;
	const content = [...result.content];
	const firstTextIndex = content.findIndex((part) => part.type === "text");
	if (firstTextIndex >= 0) {
		const current = content[firstTextIndex];
		if (current.type === "text") {
			content[firstTextIndex] = { ...current, text: `${current.text}\n\nTodo tracking: ${note}` };
		}
	} else {
		content.push({ type: "text", text: `Todo tracking: ${note}` });
	}
	return { ...result, content };
}
