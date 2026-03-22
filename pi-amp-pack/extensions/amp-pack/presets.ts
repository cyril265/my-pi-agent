import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type WorkflowThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

const WORKFLOW_MODE_ENTRY = "amp-pack-workflow-mode";

function stripFrontmatter(markdown: string) {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return markdown;
  return markdown.slice(end + 4).replace(/^\s+/, "");
}

function getPackagedPromptBody(promptName: string) {
  const thisFile = fileURLToPath(import.meta.url);
  const promptPath = path.join(
    path.dirname(thisFile),
    "prompts",
    `${promptName}.md`,
  );
  const content = fs.readFileSync(promptPath, "utf-8");
  return stripFrontmatter(content).trim();
}

function buildWorkflowRequest(promptBody: string, request: string) {
  return `${promptBody}\n\nNow apply that workflow to this request:\n${request}`;
}

export default function registerWorkflowPresets(pi: ExtensionAPI) {
  let activeWorkflowMode: string | undefined;

  function updateStatus(ctx: ExtensionContext) {
    if (activeWorkflowMode) {
      ctx.ui.setStatus("mode", ctx.ui.theme.fg("accent", `mode:${activeWorkflowMode}`));
    } else {
      ctx.ui.setStatus("mode", undefined);
    }
  }

  function persistMode(mode: string) {
    pi.appendEntry(WORKFLOW_MODE_ENTRY, { mode });
  }

  function restoreMode(ctx: ExtensionContext) {
    for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
      if (entry.type === "custom" && entry.customType === WORKFLOW_MODE_ENTRY) {
        const mode = entry.data?.mode;
        if (typeof mode === "string" && mode.length > 0) {
          activeWorkflowMode = mode;
        }
        break;
      }
    }
  }

  const registerWorkflowCommand = (
    name: string,
    thinkingLevel: WorkflowThinkingLevel,
    queuedLabel: string,
    description: string,
  ) => {
    const promptBody = getPackagedPromptBody(name);

    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        activeWorkflowMode = name;
        persistMode(name);
        updateStatus(ctx);
        pi.setThinkingLevel(thinkingLevel);
        const request = args?.trim();

        if (!request) {
          ctx.ui.notify(
            `Thinking level set to ${thinkingLevel}. Usage: /${name} <request>`,
            "info",
          );
          return;
        }

        const message = buildWorkflowRequest(promptBody, request);
        if (ctx.isIdle()) {
          pi.sendUserMessage(message);
        } else {
          pi.sendUserMessage(message, { deliverAs: "steer" });
          ctx.ui.notify(`${queuedLabel} queued`, "info");
        }
      },
    });
  };

  registerWorkflowCommand(
    "deep",
    "high",
    "Deep request",
    "Set thinking to high and send the deep workflow prompt for a request",
  );
  registerWorkflowCommand(
    "rush",
    "low",
    "Rush request",
    "Set thinking to low and send the rush workflow prompt for a request",
  );
  registerWorkflowCommand(
    "smart",
    "medium",
    "Smart request",
    "Set thinking to medium and send the smart workflow prompt for a request",
  );
  registerWorkflowCommand(
    "implement",
    "medium",
    "Implementation request",
    "Set thinking to medium and send the implement workflow prompt for a request",
  );
  registerWorkflowCommand(
    "investigate",
    "high",
    "Investigation request",
    "Set thinking to high and send the investigate workflow prompt for a request",
  );
  registerWorkflowCommand(
    "review-changes",
    "high",
    "Review request",
    "Set thinking to high and send the review workflow prompt for a request",
  );
  registerWorkflowCommand(
    "explain-code",
    "medium",
    "Explanation request",
    "Set thinking to medium and send the explain-code workflow prompt for a request",
  );

  pi.on("session_start", async (_event, ctx) => {
    restoreMode(ctx);
    updateStatus(ctx);
  });
}
