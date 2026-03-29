import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface PiJsonEvent {
	type?: string;
	[key: string]: unknown;
}

export interface PiJsonRunOptions {
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
	onEvent?: (event: PiJsonEvent) => void;
}

export interface PiJsonRunResult {
	exitCode: number;
	stderr: string;
	rawStdout: string;
	timedOut: boolean;
	aborted: boolean;
}

export async function writePromptToTempFile(
	name: string,
	prompt: string,
	tempRoot = os.tmpdir(),
	prefix = "pi-prompt-",
): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(tempRoot, prefix));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir, filePath };
}

export function getPiInvocation(args: string[]): PiInvocation {
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

export async function runPiJsonProcess(options: PiJsonRunOptions): Promise<PiJsonRunResult> {
	return await new Promise<PiJsonRunResult>((resolve) => {
		const invocation = getPiInvocation(options.args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let rawStdout = "";
		let stderr = "";
		let buffer = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		let abortHandler: (() => void) | undefined;

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (abortHandler && options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
			resolve({ exitCode, stderr, rawStdout, timedOut, aborted });
		};

		const killProcess = (reason: "timeout" | "abort") => {
			if (reason === "timeout") timedOut = true;
			if (reason === "abort") aborted = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000).unref();
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: PiJsonEvent;
			try {
				event = JSON.parse(line) as PiJsonEvent;
			} catch {
				return;
			}

			try {
				options.onEvent?.(event);
			} catch {
				// ignore observer failures so the child run can continue
			}
		};

		proc.stdout.on("data", (data) => {
			const text = data.toString();
			rawStdout += text;
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("error", (error) => {
			stderr += `${stderr ? "\n" : ""}${error.message}`;
			finish(1);
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
		});

		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutHandle = setTimeout(() => killProcess("timeout"), options.timeoutMs);
		}

		if (options.signal) {
			abortHandler = () => killProcess("abort");
			if (options.signal.aborted) abortHandler();
			else options.signal.addEventListener("abort", abortHandler, { once: true });
		}
	});
}
