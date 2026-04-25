import { randomInt } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const SIMPLE_SUBAGENT_PROCESS_ENV = "PI_SIMPLE_SUBAGENT";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type PiJsonEvent = {
  type?: string;
  message?: unknown;
};

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

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function getCwdLabel(cwd: string): string {
  const name = path.basename(cwd);
  return name || cwd;
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

const idChars = "abcdefghijklmnopqrstuvwxyz0123456789";

function getRandomId(): string {
  let id = "";
  for (let i = 0; i < 10; i++) id += idChars[randomInt(idChars.length)];
  return id;
}

function createRunDirectory(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const runDirectory = path.join(os.tmpdir(), getRandomId());
    try {
      fs.mkdirSync(runDirectory);
      return runDirectory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Failed to create random subagent directory");
}

function sanitizeFileName(name: string): string {
  const sanitized = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("Agent name is empty after sanitizing");
  return sanitized;
}

async function runPiJsonProcess(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onEvent: (event: PiJsonEvent) => void,
): Promise<{ exitCode: number; stderr: string; aborted: boolean }> {
  return await new Promise((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, [SIMPLE_SUBAGENT_PROCESS_ENV]: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let buffer = "";
    let aborted = false;
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      resolve({ exitCode, stderr, aborted });
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        onEvent(JSON.parse(line) as PiJsonEvent);
      } catch {
        // ignore malformed lines
      }
    };

    const abortHandler = () => {
      aborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000).unref();
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
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

    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

function getPromptArgument(prompt: string): string {
  return prompt.startsWith("-") ? `\n${prompt}` : prompt;
}

function buildPiShellCommand(prompt: string, model: string, thinking: ThinkingLevel): string {
  return ["pi", "--model", model, "--thinking", thinking, getPromptArgument(prompt)].map(shellQuote).join(" ");
}

function openCmuxSplit(prompt: string, model: string, thinking: ThinkingLevel, cwd: string) {
  const splitResult = spawnSync("cmux", ["--json", "new-split", "right"], {
    cwd,
    encoding: "utf-8",
  });
  if (splitResult.status !== 0) {
    throw new Error(splitResult.stderr.trim() || splitResult.stdout.trim() || "cmux new-split failed");
  }

  const splitOutput = splitResult.stdout.trim();
  const surfaceRef = splitOutput ? (JSON.parse(splitOutput) as { surface_ref?: string }).surface_ref : undefined;
  if (!surfaceRef) {
    throw new Error("cmux new-split did not return surface_ref");
  }

  const command = `cd ${shellQuote(cwd)} && ${buildPiShellCommand(prompt, model, thinking)}`;
  const sendResult = spawnSync("cmux", ["send", "--surface", surfaceRef, `${command}\n`], {
    cwd,
    encoding: "utf-8",
  });
  if (sendResult.status !== 0) {
    throw new Error(sendResult.stderr.trim() || sendResult.stdout.trim() || "cmux send failed");
  }
}

function openTmuxSplit(prompt: string, model: string, thinking: ThinkingLevel, cwd: string) {
  const command = buildPiShellCommand(prompt, model, thinking);
  const splitResult = spawnSync("tmux", ["split-window", "-h", "-c", cwd, command], {
    cwd,
    encoding: "utf-8",
  });
  if (splitResult.status !== 0) {
    throw new Error(splitResult.stderr.trim() || splitResult.stdout.trim() || "tmux split-window failed");
  }
}

function isWarpTerminal() {
  return process.platform === "darwin" && process.env.TERM_PROGRAM === "WarpTerminal";
}

function appleScriptQuote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function openWarpSplit(prompt: string, model: string, thinking: ThinkingLevel, cwd: string) {
  const command = `cd ${shellQuote(cwd)} && ${buildPiShellCommand(prompt, model, thinking)}`;
  const encodedCommand = Buffer.from(command, "utf-8").toString("base64");
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
`;

  const result = spawnSync("osascript", ["-e", script], {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "Warp split failed. Grant Accessibility permission to terminal app running pi.",
    );
  }
}

function openMuxSplit(prompt: string, model: string, thinking: ThinkingLevel, cwd: string) {
  if (process.env.CMUX_WORKSPACE_ID || process.env.CMUX_SURFACE_ID) {
    openCmuxSplit(prompt, model, thinking, cwd);
    return;
  }
  if (process.env.TMUX) {
    openTmuxSplit(prompt, model, thinking, cwd);
    return;
  }
  if (isWarpTerminal()) {
    openWarpSplit(prompt, model, thinking, cwd);
    return;
  }

  throw new Error("Not inside cmux, tmux, or Warp");
}

async function runSubAgent(
  model: string,
  thinking: ThinkingLevel,
  prompt: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
): Promise<{ text: string; exitCode: number }> {
  const messages: Message[] = [];
  const args = ["--mode", "json", "-p", "--no-session", "--model", model, "--thinking", thinking, getPromptArgument(prompt)];

  const result = await runPiJsonProcess(args, cwd, signal, (event) => {
    if (event.type !== "message_end" || !event.message) return;
    const message = event.message as Message;
    messages.push(message);
    const text = getFinalOutput(messages);
    if (!text) return;
    onUpdate?.(text);
  });

  if (result.aborted) {
    throw new Error("Subagent was aborted");
  }

  return {
    text: getFinalOutput(messages) || result.stderr.trim() || "(no output)",
    exitCode: result.exitCode,
  };
}

export default function (pi: ExtensionAPI) {
  if (process.env[SIMPLE_SUBAGENT_PROCESS_ENV] === "1") return;

  pi.registerCommand("runSubAgent", {
    description: "Open subagent in cmux, tmux, or Warp split.",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /runSubAgent <prompt>", "warning");
        return;
      }
      if (!process.env.CMUX_WORKSPACE_ID && !process.env.CMUX_SURFACE_ID && !process.env.TMUX && !isWarpTerminal()) {
        ctx.ui.notify("Not inside cmux, tmux, or Warp", "error");
        return;
      }
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      if (!model) {
        ctx.ui.notify("No caller model", "error");
        return;
      }

      try {
        openMuxSplit(prompt, model, pi.getThinkingLevel() as ThinkingLevel, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });


  pi.registerTool({
    name: "runSubAgents",
    description: "Run multiple independent subagents in parallel. Each subagent writes its result to /tmp/<random-id>/<name>-result.md.",
    parameters: Type.Object({
      agents: Type.Array(
        Type.Object({
          thinking: Type.Union([
            Type.Literal("off"),
            Type.Literal("minimal"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("xhigh"),
          ]),
          name: Type.String(),
          prompt: Type.String(),
          cwd: Type.String(),
        }),
      ),
    }),
    renderCall(args, theme) {
      const text = [
        theme.fg("toolTitle", theme.bold("runSubAgents")),
        theme.fg("muted", ` - agents:${args.agents.length}`),
        "\n",
        theme.fg(
          "toolOutput",
          args.agents
            .map((agent, index) => `${index + 1}. ${agent.name} - ${getCwdLabel(agent.cwd)} - ${truncate(agent.prompt, 120)}`)
            .join("\n"),
        ),
      ].join("");
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "(no output)";
      return new Text(`\n${theme.fg("muted", "results:")}\n${text}`, 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      if (!model) throw new Error("No caller model");
      if (params.agents.length === 0) throw new Error("No agents");

      const runDirectory = createRunDirectory();

      const results = await Promise.all(
        params.agents.map(async (agent, index) => {
          const result = await runSubAgent(model, agent.thinking, agent.prompt, agent.cwd, signal, undefined);
          const outputPath = path.join(runDirectory, `${sanitizeFileName(agent.name)}-result.md`);
          fs.writeFileSync(outputPath, result.text);
          onUpdate?.({
            content: [{ type: "text", text: `Agent ${index + 1} done: ${outputPath}` }],
          });
          return { index, outputPath, result };
        }),
      );

      const text = results
        .sort((a, b) => a.index - b.index)
        .map(({ index, outputPath, result }) => `${params.agents[index].name} (exit ${result.exitCode}): ${outputPath}`)
        .join("\n");

      return {
        content: [{ type: "text", text }],
        isError: results.some(({ result }) => result.exitCode !== 0),
      };
    },
  });
}
