import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

class FooterStatuses {
	preset?: string;
	mcp?: string;
	others: string[] = [];
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sanitizeStatusText(text: string): string {
	return stripAnsi(text)
		.replace(/[\r\n\t]/g, " ")
		.replace(/(?:\s*[•·]\s*)?\d+\s+pool\(s\)/gi, "")
		.replace(/\s*[•·]\s*$/g, "")
		.replace(/:\s*/g, ": ")
		.replace(/ +/g, " ")
		.trim();
}

function getFooterStatuses(entries: Array<[string, string]>): FooterStatuses {
	const result = new FooterStatuses();

	for (const [key, rawText] of entries) {
		const status = sanitizeStatusText(rawText);
		if (!status) continue;

		if (!result.preset && key === "preset") {
			result.preset = status;
			continue;
		}

		if (!result.mcp && key.toLowerCase().includes("mcp")) {
			result.mcp = status;
			continue;
		}

		if (!result.preset && /^preset\s*:/i.test(status)) {
			result.preset = status;
			continue;
		}

		if (!result.mcp && /^mcp\s*:/i.test(status)) {
			result.mcp = status;
			continue;
		}

		result.others.push(status);
	}

	return result;
}

function getCurrentDirectoryName(cwd: string): string {
	if (cwd === "/") return "/";
	const name = basename(cwd);
	return name || cwd;
}

function getThinkingColor(level: string):
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh" {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "thinkingOff";
	}
}

function orange(text: string): string {
	return `\x1b[38;5;208m${text}\x1b[39m`;
}

function blue(text: string): string {
	return `\x1b[38;5;39m${text}\x1b[39m`;
}

function styleContextPercent(theme: Theme, percent: number | null): string {
	const label = percent === null ? "?" : `${Math.round(percent)}%`;

	if (percent === null) return theme.fg("dim", label);
	if (percent >= 90) return theme.fg("error", theme.bold(label));
	if (percent >= 75) return orange(`\x1b[1m${label}\x1b[22m`);
	if (percent >= 60) return theme.fg("warning", theme.bold(label));
	return theme.fg("success", theme.bold(label));
}

function joinSegments(theme: Theme, segments: string[]): string {
	return segments.filter(Boolean).join(theme.fg("dim", " • "));
}

function buildFooterLine(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	branch: string | null,
	statuses: FooterStatuses,
): string {
	const contextUsage = ctx.getContextUsage();
	const contextPercent = contextUsage?.percent ?? null;
	const provider = truncateToWidth(ctx.model?.provider ?? "no provider", 18, "…");
	const model = truncateToWidth(ctx.model?.name ?? ctx.model?.id ?? "no model", 28, "…");
	const thinkingLevel = ctx.model?.reasoning ? pi.getThinkingLevel() : "off";
	const directory = getCurrentDirectoryName(ctx.sessionManager.getCwd());

	const segments = [
		`${theme.fg("dim", "⌂ ")}${theme.fg("accent", theme.bold(directory))}`,
		branch ? `${theme.fg("dim", "⎇ ")}${theme.fg("success", truncateToWidth(branch, 24, "…"))}` : "",
		styleContextPercent(theme, contextPercent),
		blue(provider),
		theme.bold(model),
		theme.fg(getThinkingColor(thinkingLevel), theme.bold(thinkingLevel)),
		statuses.preset ? blue(statuses.preset) : "",
		statuses.mcp ?? "",
		...statuses.others,
	];

	return joinSegments(theme, segments);
}

function buildFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => ({
		dispose: footerData.onBranchChange(() => tui.requestRender()),
		invalidate() {},
		render(width: number): string[] {
			const branch = footerData.getGitBranch();
			const statuses = getFooterStatuses(
				Array.from(footerData.getExtensionStatuses().entries()).sort(([a], [b]) => a.localeCompare(b)),
			);

			return [truncateToWidth(buildFooterLine(pi, ctx, theme, branch, statuses), width, theme.fg("dim", "…"))];
		},
	}));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		buildFooter(pi, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		buildFooter(pi, ctx);
	});
}
