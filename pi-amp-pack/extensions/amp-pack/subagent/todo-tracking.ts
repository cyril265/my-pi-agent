import { Queue, mergeMetadata, resolveQueuePath } from "../../../sq-node/dist/index.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
const MAX_TODO_TEXT_CHARS = 2400;
const MAX_TODO_SUMMARY_CHARS = 8000;

export interface TodoTrackingOptions {
	enabled?: boolean;
	queuePath?: string;
	runTitle?: string;
}

export interface TodoTrackingSingleResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
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
		defaultCwd: string,
		mode: "single" | "parallel" | "chain",
		toolCallId: string,
		todo: TodoTrackingOptions,
	): Promise<SqTodoTracker | null> {
		if (todo.enabled === false) return null;

		const queuePath = resolveQueuePath({ cwd: defaultCwd, queuePathOverride: todo.queuePath });
		const runTitle = todo.runTitle?.trim() ? todo.runTitle.trim() : `Subagent ${mode} run`;
		const tracker = new SqTodoTracker(queuePath, mode, runTitle, toolCallId);
		await tracker.initialize();
		return tracker;
	}

	private addWarning(message: string) {
		if (this.warnings.length >= 8) return;
		this.warnings.push(message);
	}

	private async initialize() {
		try {
			const item = await this.queue.push({
				title: this.runTitle,
				description: `Tracking run for subagent ${this.mode} mode`,
				metadata: {
					kind: "subagent_run",
					mode: this.mode,
					toolCallId: this.toolCallId,
					startedAt: new Date().toISOString(),
				},
				sources: [],
				blocked_by: [],
			});
			this.runId = item.id;
		} catch (error) {
			this.disabledReason = error instanceof Error ? error.message : String(error);
		}
	}

	isActive(): boolean {
		return Boolean(this.runId) && !this.disabledReason;
	}

	private isTaskFailure(result: TodoTrackingSingleResult): boolean {
		return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	}

	private async setTaskStatus(taskId: string, status: "pending" | "in_progress") {
		try {
			const updated = await this.queue.update(taskId, { status });
			if (!updated) this.addWarning(`sq update ${taskId} status ${status} failed`);
		} catch {
			this.addWarning(`sq update ${taskId} status ${status} failed`);
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

	private async closeItem(itemId: string) {
		try {
			const updated = await this.queue.close(itemId);
			if (!updated) this.addWarning(`sq close ${itemId} failed`);
		} catch {
			this.addWarning(`sq close ${itemId} failed`);
		}
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
			const item = await this.queue.push({
				title: `${titlePrefix}: ${agent}`,
				description: truncateText(task, MAX_TODO_TEXT_CHARS),
				metadata: {
					kind: "subagent_task",
					runId: this.runId,
					mode: this.mode,
					taskKey,
					agent,
					step,
					taskCwd,
					startedAt: new Date().toISOString(),
				},
				sources: [],
				blocked_by: blockedByIds,
			});
			this.taskIds.set(taskKey, item.id);
			await this.setTaskStatus(item.id, "in_progress");
		} catch {
			this.addWarning(`sq add task for ${agent} failed`);
		}
	}

	async finishTask(taskKey: string, result: TodoTrackingSingleResult) {
		if (!this.isActive()) return;
		const taskId = this.taskIds.get(taskKey);
		if (!taskId) return;

		const failed = this.isTaskFailure(result);
		const output = truncateText(getFinalOutput(result.messages), MAX_TODO_SUMMARY_CHARS);
		const errorText = truncateText(result.errorMessage || result.stderr || "", MAX_TODO_SUMMARY_CHARS);
		await this.mergeItemMetadata(taskId, {
			subagent: {
				finishedAt: new Date().toISOString(),
				outcome: failed ? "failed" : "succeeded",
				exitCode: result.exitCode,
				stopReason: result.stopReason,
				error: errorText || undefined,
				output: output || undefined,
			},
		});

		if (failed) await this.setTaskStatus(taskId, "pending");
		else await this.closeItem(taskId);
	}

	async finishTaskWithError(taskKey: string, error: unknown) {
		if (!this.isActive()) return;
		const taskId = this.taskIds.get(taskKey);
		if (!taskId) return;

		const message = error instanceof Error ? error.message : String(error);
		await this.mergeItemMetadata(taskId, {
			subagent: {
				finishedAt: new Date().toISOString(),
				outcome: "failed",
				error: truncateText(message, MAX_TODO_SUMMARY_CHARS),
			},
		});
		await this.setTaskStatus(taskId, "pending");
	}

	async finalize(succeeded: boolean, summary: string) {
		if (this.finalized) return;
		this.finalized = true;
		if (!this.isActive() || !this.runId) return;

		await this.mergeItemMetadata(this.runId, {
			subagent: {
				finishedAt: new Date().toISOString(),
				outcome: succeeded ? "succeeded" : "failed",
				summary: truncateText(summary, MAX_TODO_SUMMARY_CHARS),
				taskCount: this.taskIds.size,
				warnings: this.warnings,
			},
		});

		if (succeeded) await this.closeItem(this.runId);
		else await this.setTaskStatus(this.runId, "pending");
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
