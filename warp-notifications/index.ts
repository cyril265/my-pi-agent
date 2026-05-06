import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const EXTENSION_VERSION = "0.1.0";
const WARP_SENTINEL_TITLE = "warp://cli-agent";

// Warp currently has CLIAgent::Pi, but its listener is not enabled in
// app/src/terminal/cli_agent_sessions/listener/mod.rs. "auggie" is supported
// for structured OSC 777 without first-party install flow, so we use it as a
// compatibility shim until Warp enables Pi as supported.
const WARP_COMPAT_AGENT = "auggie";

type WarpAgentEvent =
  | "session_start"
  | "prompt_submit"
  | "tool_complete"
  | "stop"
  | "permission_request"
  | "permission_replied"
  | "question_asked"
  | "idle_prompt";

type WarpPayload = {
  v: 1;
  agent: string;
  event: WarpAgentEvent;
  session_id: string;
  cwd?: string;
  project?: string;
  query?: string;
  response?: string;
  summary?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  plugin_version?: string;
};

let sessionId = `pi-${process.pid}-${Date.now()}`;
let lastPrompt = "Pi task";
let sessionStarted = false;

function oscSafe(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/;/g, ",").trim();
}

function getSessionId(ctx?: ExtensionContext): string {
  const sessionFile = ctx?.sessionManager.getSessionFile();
  if (sessionFile) return `pi-${sessionFile}`;
  return sessionId;
}

function projectName(cwd: string): string | undefined {
  const name = cwd.split(/[\\/]/).filter(Boolean).pop();
  return name || undefined;
}

function sendWarpEvent(event: WarpAgentEvent, fields: Partial<WarpPayload> = {}, ctx?: ExtensionContext): void {
  if (process.env.TERM_PROGRAM !== "WarpTerminal") return;

  const cwd = fields.cwd ?? process.cwd();
  const payload: WarpPayload = {
    v: 1,
    agent: WARP_COMPAT_AGENT,
    event,
    session_id: fields.session_id ?? getSessionId(ctx),
    cwd,
    project: fields.project ?? projectName(cwd),
    plugin_version: `pi-warp-notifications-${EXTENSION_VERSION}`,
    ...fields,
  };

  const body = oscSafe(JSON.stringify(payload));
  process.stdout.write(`\x1b]777;notify;${WARP_SENTINEL_TITLE};${body}\x07`);
}

function ensureSessionStarted(ctx?: ExtensionContext): void {
  if (sessionStarted) return;
  sessionStarted = true;
  sendWarpEvent("session_start", {}, ctx);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    sessionId = `pi-${process.pid}-${Date.now()}`;
    sessionStarted = false;
    ensureSessionStarted(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    ensureSessionStarted(ctx);
    lastPrompt = event.prompt.trim() || "Pi task";
    sendWarpEvent("prompt_submit", { query: lastPrompt }, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    ensureSessionStarted(ctx);
    sendWarpEvent(
      "stop",
      {
        query: lastPrompt,
        summary: lastPrompt,
        response: "Ready for input",
      },
      ctx,
    );
  });

  pi.registerCommand("warpnotify-test", {
    description: "Send a test notification to Warp's agent inbox",
    handler: async (args, ctx) => {
      ensureSessionStarted(ctx);
      const summary = args.trim() || "Pi Warp notification test";
      sendWarpEvent("stop", { query: summary, summary, response: "Ready for input" }, ctx);
      ctx.ui.notify("Sent Warp inbox test event", "info");
    },
  });
}
