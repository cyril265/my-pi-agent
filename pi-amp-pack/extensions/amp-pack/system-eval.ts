import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runPiJsonProcess } from "./pi-process";

const DEFAULT_MODEL = "github-copilot/gpt-5.4";
const DEFAULT_THINKING = "medium";
const DEFAULT_BASE_REF = "origin/next";
const DEFAULT_TASK_FILE = path.join("tools", "prompt-eval", "task.md");
const DEFAULT_TARGET_DIFF_FILE = path.join("tools", "prompt-eval", "target.diff");
const AMP_SYSTEM_EVAL_PROCESS_ENV = "PI_AMP_SYSTEM_EVAL";

type EvalPhase = "preparing" | "running" | "judging" | "done";

interface JudgeResult {
	score: number;
	summary: string;
	matchedIntent: string[];
	missingOrIncorrect: string[];
	unnecessaryOrWrong: string[];
	raw: string;
}

interface SystemEvalDetails {
	phase: EvalPhase;
	runDir: string;
	worktreeDir?: string;
	candidatePrompt: string;
	taskFile: string;
	targetDiffFile: string;
	producedDiffFile?: string;
	baseRef: string;
	model: string;
	thinking: string;
	exitCode?: number;
	timedOut?: boolean;
	changedFiles?: number;
	lastTool?: string;
	assistantTurns?: number;
	judge?: JudgeResult;
}

const SystemEvalParams = Type.Object(
	{
		candidatePrompt: Type.Optional(Type.String({ description: "Candidate AGENTS prompt file. Defaults to ~/.pi/agent/AGENTS.md" })),
		taskFile: Type.Optional(Type.String({ description: "Task markdown file. Defaults to tools/prompt-eval/task.md" })),
		targetDiffFile: Type.Optional(Type.String({ description: "Frozen target diff file. Defaults to tools/prompt-eval/target.diff" })),
		baseRef: Type.Optional(Type.String({ description: "Git ref used for the clean worktree. Defaults to origin/next" })),
		model: Type.Optional(Type.String({ description: "Model for both the coding run and judge run. Defaults to github-copilot/gpt-5.4." })),
		thinking: Type.Optional(Type.String({ description: "Thinking level for both the coding run and judge run. Defaults to medium." })),
		timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout for the coding run in seconds. Omit for no timeout." })),
		keepWorktree: Type.Optional(Type.Boolean({ description: "Keep the generated worktree after the run. Defaults to true" })),
	},
	{ additionalProperties: false },
);

const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator of coding agent output.
Return only valid JSON with this exact shape:
{
  "score": number,
  "summary": string,
  "matchedIntent": string[],
  "missingOrIncorrect": string[],
  "unnecessaryOrWrong": string[]
}
Rules:
- score must be in [0,1]
- judge the produced diff against the target diff for the same task
- prioritize correctness, completeness, architectural alignment, and avoiding unrelated churn
- be harsh about missing important behavior and needless edits
- no markdown, no code fences, no extra keys`;

const JUDGE_USER_PROMPT = `The attached files are:
- the task description
- the target diff (desired outcome)
- the produced diff (candidate output)

Compare the produced diff to the target diff.
Score the produced diff from 0 to 1.
Use these criteria:
- correctness of the implemented behavior
- completeness relative to the target outcome
- architectural alignment with the intended approach
- lack of unrelated churn

If the produced diff is empty or clearly incomplete, score it low.`;

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function resolvePath(baseDir: string, filePath: string): string {
	const expanded = expandHome(filePath.replace(/^@/, ""));
	return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function timestampId() {
	const now = new Date();
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readText(filePath: string) {
	return fs.readFileSync(filePath, "utf-8");
}

function writeText(filePath: string, content: string) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function copyIfExists(sourcePath: string, targetPath: string) {
	if (!fs.existsSync(sourcePath)) return false;
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.copyFileSync(sourcePath, targetPath);
	return true;
}

async function runCommand(
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	return await new Promise((resolve, reject) => {
		const proc = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let abortHandler: (() => void) | undefined;

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("error", reject);
		proc.on("close", (code) => {
			if (abortHandler && options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
			resolve({ stdout, stderr, code: code ?? 0, killed: proc.killed });
		});

		if (options.signal) {
			abortHandler = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000).unref();
			};
			if (options.signal.aborted) abortHandler();
			else options.signal.addEventListener("abort", abortHandler, { once: true });
		}
	});
}

function extractMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: string }).type === "text")
		.map((part) => part.text)
		.join("");
}

function parseJudgeResult(raw: string): JudgeResult {
	const trimmed = raw.trim();
	const jsonText = trimmed.startsWith("{")
		? trimmed
		: trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
	const parsed = JSON.parse(jsonText) as Partial<JudgeResult>;
	return {
		score: clampScore(parsed.score),
		summary: typeof parsed.summary === "string" ? parsed.summary : "",
		matchedIntent: Array.isArray(parsed.matchedIntent) ? parsed.matchedIntent.filter((item): item is string => typeof item === "string") : [],
		missingOrIncorrect: Array.isArray(parsed.missingOrIncorrect)
			? parsed.missingOrIncorrect.filter((item): item is string => typeof item === "string")
			: [],
		unnecessaryOrWrong: Array.isArray(parsed.unnecessaryOrWrong)
			? parsed.unnecessaryOrWrong.filter((item): item is string => typeof item === "string")
			: [],
		raw,
	};
}

function clampScore(score: unknown) {
	if (typeof score !== "number" || Number.isNaN(score)) return 0;
	return Math.min(1, Math.max(0, score));
}

function formatList(items: string[]) {
	return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function formatProgressText(details: SystemEvalDetails, assistantPreview: string) {
	const lines = [
		`phase: ${details.phase}`,
		`model: ${details.model} thinking:${details.thinking}`,
		`base: ${details.baseRef}`,
		`candidate: ${details.candidatePrompt}`,
		`task: ${details.taskFile}`,
		`target: ${details.targetDiffFile}`,
		`run dir: ${details.runDir}`,
	];

	if (details.worktreeDir) lines.push(`worktree: ${details.worktreeDir}`);
	if (details.assistantTurns) lines.push(`assistant turns: ${details.assistantTurns}`);
	if (details.lastTool) lines.push(`last tool: ${details.lastTool}`);
	if (details.changedFiles !== undefined) lines.push(`changed files: ${details.changedFiles}`);
	if (details.exitCode !== undefined) lines.push(`exit: ${details.exitCode}${details.timedOut ? " (timed out)" : ""}`);
	if (details.producedDiffFile) lines.push(`produced diff: ${details.producedDiffFile}`);
	if (assistantPreview.trim()) lines.push(`assistant: ${assistantPreview.trim()}`);
	return lines.join("\n");
}

function formatFinalText(details: SystemEvalDetails) {
	const judge = details.judge;
	const lines = [
		`System eval complete`,
		``,
		`- model: ${details.model} thinking:${details.thinking}`,
		`- base: ${details.baseRef}`,
		`- candidate: ${details.candidatePrompt}`,
		`- task: ${details.taskFile}`,
		`- target: ${details.targetDiffFile}`,
		`- run dir: ${details.runDir}`,
		`- worktree: ${details.worktreeDir ?? "(none)"}`,
		`- produced diff: ${details.producedDiffFile ?? "(none)"}`,
		`- exit: ${details.exitCode ?? "?"}${details.timedOut ? " (timed out)" : ""}`,
		`- changed files: ${details.changedFiles ?? 0}`,
	];

	if (!judge) {
		lines.push(`- judge: unavailable`);
		return lines.join("\n");
	}

	lines.push(`- judge score: ${judge.score.toFixed(3)}`);
	if (judge.summary) {
		lines.push(``, `Summary`, judge.summary);
	}
	lines.push(``, `Matched Intent`, formatList(judge.matchedIntent));
	lines.push(``, `Missing Or Incorrect`, formatList(judge.missingOrIncorrect));
	lines.push(``, `Unnecessary Or Wrong`, formatList(judge.unnecessaryOrWrong));
	return lines.join("\n");
}

function makeAssistantPreview(text: string) {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= 240) return collapsed;
	return `${collapsed.slice(0, 237)}...`;
}

export default function registerSystemEvalExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "system_eval",
		label: "System Eval",
		description: [
			"Run a system prompt evaluation against a saved target diff.",
			"Creates a clean git worktree, runs an isolated pi instance with the candidate AGENTS prompt, captures the produced diff, and grades it with an LLM judge.",
			"Defaults: candidate ~/.pi/agent/AGENTS.md, task tools/prompt-eval/task.md, target tools/prompt-eval/target.diff, base origin/next, model github-copilot/gpt-5.4 with medium thinking, and no timeout unless requested.",
			"Set model or thinking to override the child coding run and judge run.",
		].join(" "),
		promptSnippet: "Run a prompt evaluation in an isolated worktree and judge the produced diff against a saved target diff",
		promptGuidelines: [
			"Use this tool when the user wants to evaluate or optimize the system prompt against a target diff.",
			"Prefer the default gpt-5.4 medium configuration unless the user explicitly asks for different files or timeout.",
		],
		parameters: SystemEvalParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (process.env[AMP_SYSTEM_EVAL_PROCESS_ENV] === "1") {
				throw new Error("system_eval cannot run recursively inside another system_eval child process.");
			}

			const repoRootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, signal });
			if (repoRootResult.code !== 0) {
				throw new Error(repoRootResult.stderr || "Failed to resolve git repository root.");
			}

			const repoRoot = repoRootResult.stdout.trim();
			const runId = timestampId();
			const runDir = path.join(repoRoot, ".tmp", "system-eval", runId);
			const worktreeDir = path.join(runDir, "worktree");
			const candidatePrompt = resolvePath(os.homedir(), params.candidatePrompt ?? path.join("~", ".pi", "agent", "AGENTS.md"));
			const taskFile = params.taskFile ? resolvePath(ctx.cwd, params.taskFile) : path.join(repoRoot, DEFAULT_TASK_FILE);
			const targetDiffFile = params.targetDiffFile ? resolvePath(ctx.cwd, params.targetDiffFile) : path.join(repoRoot, DEFAULT_TARGET_DIFF_FILE);
			const baseRef = params.baseRef?.trim() || DEFAULT_BASE_REF;
			const model = params.model?.trim() || DEFAULT_MODEL;
			const thinking = params.thinking?.trim() || DEFAULT_THINKING;
			const timeoutSeconds = Number.isFinite(params.timeoutSeconds) && (params.timeoutSeconds ?? 0) > 0
				? Math.floor(params.timeoutSeconds!)
				: undefined;
			const keepWorktree = params.keepWorktree ?? true;
			const producedDiffFile = path.join(runDir, "produced.diff");
			const agentDir = path.join(runDir, "agent-home");
			const judgeAgentDir = path.join(runDir, "judge-agent-home");
			const details: SystemEvalDetails = {
				phase: "preparing",
				runDir,
				candidatePrompt,
				taskFile,
				targetDiffFile,
				baseRef,
				model,
				thinking,
			};

			const emitUpdate = (assistantText = "") => {
				onUpdate?.({
					content: [{ type: "text", text: formatProgressText(details, makeAssistantPreview(assistantText)) }],
					details,
				});
			};

			if (!fs.existsSync(candidatePrompt)) throw new Error(`Candidate prompt file not found: ${candidatePrompt}`);
			if (!fs.existsSync(taskFile)) throw new Error(`Task file not found: ${taskFile}`);
			if (!fs.existsSync(targetDiffFile)) throw new Error(`Target diff file not found: ${targetDiffFile}`);

			fs.mkdirSync(runDir, { recursive: true });
			writeText(path.join(runDir, "candidate-AGENTS.md"), `${readText(candidatePrompt)}\n`);
			writeText(path.join(runDir, "task.md"), `${readText(taskFile)}\n`);
			copyIfExists(targetDiffFile, path.join(runDir, "target.diff"));
			emitUpdate();

			const realAgentDir = getAgentDir();
			fs.mkdirSync(agentDir, { recursive: true });
			writeText(path.join(agentDir, "AGENTS.md"), readText(candidatePrompt));
			copyIfExists(path.join(realAgentDir, "auth.json"), path.join(agentDir, "auth.json"));
			copyIfExists(path.join(realAgentDir, "models.json"), path.join(agentDir, "models.json"));
			fs.mkdirSync(judgeAgentDir, { recursive: true });
			copyIfExists(path.join(realAgentDir, "auth.json"), path.join(judgeAgentDir, "auth.json"));
			copyIfExists(path.join(realAgentDir, "models.json"), path.join(judgeAgentDir, "models.json"));

			const addWorktreeResult = await runCommand("git", ["worktree", "add", "--detach", worktreeDir, baseRef], {
				cwd: repoRoot,
				signal,
			});
			if (addWorktreeResult.code !== 0) {
				throw new Error(addWorktreeResult.stderr || addWorktreeResult.stdout || "Failed to create worktree.");
			}

			details.phase = "running";
			details.worktreeDir = worktreeDir;
			emitUpdate();

			let latestAssistantText = "";
			let assistantTurns = 0;
			let lastTool = "";
			let lastEmitAt = 0;

			const taskText = readText(taskFile).trim();
			const childResult = await runPiJsonProcess({
				args: [
					"--mode",
					"json",
					"-p",
					"--no-session",
					"--model",
					model,
					"--thinking",
					thinking,
					"--tools",
					"read,bash,edit,write",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					taskText,
				],
				cwd: worktreeDir,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					PI_SKIP_VERSION_CHECK: "1",
					[AMP_SYSTEM_EVAL_PROCESS_ENV]: "1",
				},
				timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
				signal,
				onEvent: (event) => {
					if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
						lastTool = event.toolName;
					}
					if (event.type === "message_update") {
						const assistantMessageEvent = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
						if (assistantMessageEvent?.type === "text_delta" && typeof assistantMessageEvent.delta === "string") {
							latestAssistantText += assistantMessageEvent.delta;
						}
					}
					if (event.type === "message_end" && event.message) {
						const message = event.message as { role?: string };
						if (message.role === "assistant") {
							assistantTurns++;
							latestAssistantText = extractMessageText(event.message);
						}
					}

					const now = Date.now();
					if (now - lastEmitAt >= 750) {
						lastEmitAt = now;
						details.assistantTurns = assistantTurns;
						details.lastTool = lastTool || undefined;
						emitUpdate(latestAssistantText);
					}
				},
			});

			details.exitCode = childResult.exitCode;
			details.timedOut = childResult.timedOut;
			details.assistantTurns = assistantTurns;
			details.lastTool = lastTool || undefined;
			writeText(path.join(runDir, "pi-events.jsonl"), childResult.rawStdout);
			writeText(path.join(runDir, "pi-stderr.txt"), childResult.stderr);
			writeText(path.join(runDir, "assistant-output.md"), `${latestAssistantText}\n`);

			const statusResult = await runCommand("git", ["status", "--short"], { cwd: worktreeDir, signal });
			if (statusResult.code !== 0) {
				throw new Error(statusResult.stderr || "Failed to collect git status.");
			}
			writeText(path.join(runDir, "git-status.txt"), statusResult.stdout);
			details.changedFiles = statusResult.stdout.split("\n").filter((line) => line.trim().length > 0).length;

			const diffResult = await runCommand("git", ["diff", "--no-ext-diff", "--binary"], { cwd: worktreeDir, signal });
			if (diffResult.code !== 0) {
				throw new Error(diffResult.stderr || "Failed to collect produced diff.");
			}
			writeText(producedDiffFile, diffResult.stdout);
			details.producedDiffFile = producedDiffFile;
			emitUpdate(latestAssistantText);

			details.phase = "judging";
			emitUpdate(latestAssistantText);

			let judgeRaw = "";
			const judgeResult = await runPiJsonProcess({
				args: [
					"--mode",
					"json",
					"-p",
					"--no-session",
					"--model",
					model,
					"--thinking",
					thinking,
					"--no-tools",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--system-prompt",
					JUDGE_SYSTEM_PROMPT,
					`@${taskFile}`,
					`@${targetDiffFile}`,
					`@${producedDiffFile}`,
					JUDGE_USER_PROMPT,
				],
				cwd: runDir,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: judgeAgentDir,
					PI_SKIP_VERSION_CHECK: "1",
					[AMP_SYSTEM_EVAL_PROCESS_ENV]: "1",
				},
				timeoutMs: undefined,
				signal,
				onEvent: (event) => {
					if (event.type === "message_end" && event.message) {
						const message = event.message as { role?: string };
						if (message.role === "assistant") {
							judgeRaw = extractMessageText(event.message);
						}
					}
				},
			});

			writeText(path.join(runDir, "judge-events.jsonl"), judgeResult.rawStdout);
			writeText(path.join(runDir, "judge-stderr.txt"), judgeResult.stderr);
			writeText(path.join(runDir, "judge-raw.txt"), `${judgeRaw}\n`);

			if (judgeResult.exitCode !== 0) {
				throw new Error(judgeResult.stderr || `Judge run failed with exit code ${judgeResult.exitCode}.`);
			}

			try {
				details.judge = parseJudgeResult(judgeRaw);
			} catch (error) {
				details.judge = {
					score: 0,
					summary: error instanceof Error ? `Failed to parse judge output: ${error.message}` : "Failed to parse judge output.",
					matchedIntent: [],
					missingOrIncorrect: [],
					unnecessaryOrWrong: [],
					raw: judgeRaw,
				};
			}
			details.phase = "done";

			if (!keepWorktree) {
				const removeResult = await runCommand("git", ["worktree", "remove", "--force", worktreeDir], { cwd: repoRoot, signal });
				if (removeResult.code === 0) {
					details.worktreeDir = undefined;
				}
			}

			writeText(path.join(runDir, "run.json"), `${JSON.stringify(details, null, 2)}\n`);

			return {
				content: [{ type: "text", text: formatFinalText(details) }],
				details,
			};
		},
	});
}
