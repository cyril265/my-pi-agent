import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerModeAndWorkflowCommands from "./commands";
import registerModeSystemPrompts from "./mode-system-prompts";
import registerSubagentExtension from "./subagent/index";
import registerSystemEvalExtension from "./system-eval";

interface SyncResult {
  copied: number;
  updated: number;
  unchanged: number;
  skippedExisting: number;
  sourceDir: string;
  targetDir: string;
}

function syncPackagedAgents() {
  const overwriteExisting = process.env.PI_AMP_PACK_OVERWRITE === "1";
  const agentDir = getAgentDir();
  const targetDir = path.join(agentDir, "agents");
  const thisFile = fileURLToPath(import.meta.url);
  const sourceDir = path.join(path.dirname(thisFile), "agents");

  if (!fs.existsSync(sourceDir)) {
    return {
      copied: 0,
      updated: 0,
      unchanged: 0,
      skippedExisting: 0,
      sourceDir,
      targetDir,
    } satisfies SyncResult;
  }
  fs.mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  let updated = 0;
  let unchanged = 0;
  let skippedExisting = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath);
      copied++;
      continue;
    }

    const sourceContent = fs.readFileSync(sourcePath, "utf-8");
    const targetContent = fs.readFileSync(targetPath, "utf-8");
    if (sourceContent === targetContent) {
      unchanged++;
      continue;
    }

    if (!overwriteExisting) {
      skippedExisting++;
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
    updated++;
  }

  return {
    copied,
    updated,
    unchanged,
    skippedExisting,
    sourceDir,
    targetDir,
  } satisfies SyncResult;
}

export default function (pi: ExtensionAPI) {
  const syncResult = syncPackagedAgents();

  registerModeSystemPrompts(pi);
  registerModeAndWorkflowCommands(pi);
  registerSystemEvalExtension(pi);

  pi.on("session_start", async (_event, ctx) => {
    const changedCount = syncResult.copied + syncResult.updated;
    if (changedCount > 0) {
      ctx.ui.notify(
        `pi-amp-pack synced ${changedCount} agents (new:${syncResult.copied}, updated:${syncResult.updated})`,
        "info",
      );
    }
    if (syncResult.skippedExisting > 0) {
      ctx.ui.notify(
        `pi-amp-pack left ${syncResult.skippedExisting} user-modified agents unchanged (set PI_AMP_PACK_OVERWRITE=1 to overwrite).`,
        "warning",
      );
    }
  });

  registerSubagentExtension(pi);
}
