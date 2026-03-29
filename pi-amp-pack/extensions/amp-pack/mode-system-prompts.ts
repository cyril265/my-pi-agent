import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const WORKFLOW_MODE_ENTRY = "amp-pack-workflow-mode";
const thisFile = fileURLToPath(import.meta.url);
const systemPromptDir = path.join(path.dirname(thisFile), "system-prompts");

function getPackagedSystemPrompt(promptName: string) {
  const promptPath = path.join(systemPromptDir, `${promptName}.md`);
  return fs.readFileSync(promptPath, "utf-8").trim();
}

const deepSystemPrompt = getPackagedSystemPrompt("deep");
const rushSystemPrompt = getPackagedSystemPrompt("rush");

function getActiveWorkflowMode(ctx: ExtensionContext) {
  for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== WORKFLOW_MODE_ENTRY) {
      continue;
    }

    const mode = entry.data?.mode;
    if (typeof mode === "string" && mode.length > 0) {
      return mode;
    }

    break;
  }

  return undefined;
}

function getSystemPromptForMode(mode: string | undefined) {
  switch (mode) {
    case "deep":
      return deepSystemPrompt;
    case "rush":
      return rushSystemPrompt;
    default:
      return undefined;
  }
}

export default function registerModeSystemPrompts(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const mode = getActiveWorkflowMode(ctx);
    const systemPrompt = getSystemPromptForMode(mode);
    if (!systemPrompt) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${systemPrompt}`,
    };
  });
}
