import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { formatUsageStatus } from "@marckrenn/pi-sub-bar/src/formatting.js";
import { loadSettings as loadSubBarSettings } from "@marckrenn/pi-sub-bar/src/settings.js";
import type { RateWindow, UsageError, UsageSnapshot } from "@marckrenn/pi-sub-bar/src/types.js";

class FooterStatuses {
	preset?: string;
	mcp?: string;
	others: string[] = [];
}

type CodexUsageWindow = {
	usedPercent?: number;
	windowSeconds?: number;
	resetAt?: number;
};

type CodexUsageState = {
	providerName?: string;
	loading: boolean;
	fetchedAt?: number;
	error?: string;
	fiveHour?: CodexUsageWindow;
	weekly?: CodexUsageWindow;
};

type FooterModelState = {
	provider?: string;
	id?: string;
	name?: string;
	reasoning?: boolean;
};

class FooterRuntimeState {
	requestRender?: () => void;
	currentModel: FooterModelState = {};
	codexUsage: CodexUsageState = { loading: false };
	codexUsageCache = new Map<string, CodexUsageState>();
	codexUsageRequestId = 0;
	codexUsageAbort?: AbortController;
}

const runtimeState = new FooterRuntimeState();
const CODEX_PROVIDER = /^openai-codex(?:-\d+)?$/;
const SUB_USAGE_STATUS_KEYS = new Set(["sub-bar", "sub-status:usage"]);
const CODEX_USAGE_CACHE_MS = 15_000;
const DEFAULT_CODEX_USAGE_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

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

function shouldHideStatusEntry(key: string, providerName: string | undefined): boolean {
	if (!providerName || !CODEX_PROVIDER.test(providerName)) return false;
	return SUB_USAGE_STATUS_KEYS.has(key) || key.startsWith("sub-status:");
}

function getFooterStatuses(entries: Array<[string, string]>, providerName: string | undefined): FooterStatuses {
	const result = new FooterStatuses();

	for (const [key, rawText] of entries) {
		if (shouldHideStatusEntry(key, providerName)) continue;

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

function styleRemainingPercent(theme: Theme, percent: number | undefined): string {
	const label = percent === undefined ? "?" : `${Math.round(percent)}%`;
	if (percent === undefined) return theme.fg("dim", label);
	if (percent <= 5) return theme.fg("error", theme.bold(label));
	if (percent <= 15) return orange(`\x1b[1m${label}\x1b[22m`);
	if (percent <= 30) return theme.fg("warning", theme.bold(label));
	return theme.fg("success", theme.bold(label));
}

function joinSegments(theme: Theme, segments: string[]): string {
	return segments.filter(Boolean).join(theme.fg("dim", " • "));
}

function getTotalAssistantCost(ctx: ExtensionContext): number {
	let totalCost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		totalCost += entry.message.usage.cost.total;
	}

	return totalCost;
}

function buildOpenRouterCostSegment(ctx: ExtensionContext, theme: Theme): string {
	if (runtimeState.currentModel.provider !== "openrouter") return "";

	const totalCost = getTotalAssistantCost(ctx);
	if (totalCost <= 0) return "";

	return theme.bold(`$${totalCost.toFixed(3)}`);
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2) return {};

	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function getCodexAccountId(accessToken: string, storedAccountId?: string): string | undefined {
	if (storedAccountId) return storedAccountId;

	const payload = decodeJwtPayload(accessToken);
	const auth = getRecord(payload[OPENAI_AUTH_CLAIM]);
	return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

function normalizeCodexUsageWindow(window: unknown): CodexUsageWindow | undefined {
	const raw = getRecord(window);
	if (!raw) return undefined;

	return {
		usedPercent: typeof raw.used_percent === "number" ? raw.used_percent : undefined,
		windowSeconds: typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds : undefined,
		resetAt: typeof raw.reset_at === "number" ? raw.reset_at : undefined,
	};
}

function matchesCodexUsageWindow(window: CodexUsageWindow | undefined, expectedSeconds: number): boolean {
	if (!window?.windowSeconds) return false;
	return Math.abs(window.windowSeconds - expectedSeconds) <= 120;
}

function parseCodexUsageSnapshot(data: unknown): Pick<CodexUsageState, "fiveHour" | "weekly"> {
	const raw = getRecord(data);
	const rateLimit = getRecord(raw?.rate_limit);
	const windows = [
		normalizeCodexUsageWindow(rateLimit?.primary_window),
		normalizeCodexUsageWindow(rateLimit?.secondary_window),
	].filter((window): window is CodexUsageWindow => Boolean(window));

	return {
		fiveHour: windows.find((window) => matchesCodexUsageWindow(window, 5 * 60 * 60)),
		weekly: windows.find((window) => matchesCodexUsageWindow(window, 7 * 24 * 60 * 60)),
	};
}

function getCodexRemainingPercent(window: CodexUsageWindow | undefined): number | undefined {
	if (window?.usedPercent === undefined) return undefined;
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function formatResetShort(resetAt?: number): string | undefined {
	if (!resetAt) return undefined;

	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";

	const totalMinutes = Math.round(diffMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return `~${days}d`;
	if (hours > 0) return `~${hours}h`;
	return `~${minutes}m`;
}

async function readResponseError(response: Response): Promise<string> {
	const raw = await response.text();
	if (response.status === 401) {
		return "Unauthorized - log in again";
	}
	if (!raw) {
		return `HTTP ${response.status}`;
	}
	try {
		const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
		const message = parsed.error?.message || parsed.message;
		if (message) return `HTTP ${response.status}: ${message}`;
	} catch {
		// Ignore JSON parse failures and fall back to raw body.
	}
	return `HTTP ${response.status}: ${raw}`;
}

function syncCurrentModel(ctx: ExtensionContext): void {
	runtimeState.currentModel = {
		provider: ctx.model?.provider,
		id: ctx.model?.id,
		name: ctx.model?.name,
		reasoning: ctx.model?.reasoning,
	};
}

function getActiveCodexProvider(): string | undefined {
	const providerName = runtimeState.currentModel.provider;
	if (!providerName || !CODEX_PROVIDER.test(providerName)) return undefined;
	return providerName;
}

function cloneCodexUsage(state: CodexUsageState): CodexUsageState {
	return {
		providerName: state.providerName,
		loading: state.loading,
		fetchedAt: state.fetchedAt,
		error: state.error,
		fiveHour: state.fiveHour ? { ...state.fiveHour } : undefined,
		weekly: state.weekly ? { ...state.weekly } : undefined,
	};
}

function clearCodexUsage(): void {
	runtimeState.codexUsageAbort?.abort();
	runtimeState.codexUsageAbort = undefined;
	if (
		runtimeState.codexUsage.providerName
		|| runtimeState.codexUsage.loading
		|| runtimeState.codexUsage.error
		|| runtimeState.codexUsage.fiveHour
		|| runtimeState.codexUsage.weekly
	) {
		runtimeState.codexUsage = { loading: false };
		runtimeState.requestRender?.();
	}
}

async function refreshCodexUsage(ctx: ExtensionContext, options?: { force?: boolean }): Promise<void> {
	const providerName = getActiveCodexProvider();
	if (!providerName) {
		clearCodexUsage();
		return;
	}

	const cached = runtimeState.codexUsageCache.get(providerName);
	if (!options?.force && cached?.fetchedAt && Date.now() - cached.fetchedAt < CODEX_USAGE_CACHE_MS) {
		runtimeState.codexUsage = cloneCodexUsage({ ...cached, loading: false });
		runtimeState.requestRender?.();
		return;
	}

	if (!options?.force && runtimeState.codexUsage.loading && runtimeState.codexUsage.providerName === providerName) {
		return;
	}

	runtimeState.codexUsageAbort?.abort();
	const controller = new AbortController();
	const requestId = ++runtimeState.codexUsageRequestId;
	runtimeState.codexUsageAbort = controller;
	runtimeState.codexUsage = cached
		? cloneCodexUsage({ ...cached, loading: true })
		: { providerName, loading: true };
	runtimeState.requestRender?.();

	try {
		const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerName);
		if (!accessToken) {
			throw new Error("No authentication configured");
		}

		const credential = ctx.modelRegistry.authStorage.get(providerName) as { accountId?: unknown } | undefined;
		const accountId = getCodexAccountId(
			accessToken,
			typeof credential?.accountId === "string" ? credential.accountId : undefined,
		);
		const baseUrl = (process.env.CHATGPT_BASE_URL || DEFAULT_CODEX_USAGE_BASE_URL).replace(/\/+$/, "");
		const headers = new Headers({
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"User-Agent": "pi-hud-footer",
		});
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}

		const response = await fetch(`${baseUrl}/wham/usage`, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(await readResponseError(response));
		}

		const parsed = parseCodexUsageSnapshot(await response.json());
		const nextState: CodexUsageState = {
			providerName,
			loading: false,
			fetchedAt: Date.now(),
			fiveHour: parsed.fiveHour,
			weekly: parsed.weekly,
		};

		if (controller.signal.aborted || requestId !== runtimeState.codexUsageRequestId) return;
		if (getActiveCodexProvider() !== providerName) return;

		runtimeState.codexUsage = cloneCodexUsage(nextState);
		runtimeState.codexUsageCache.set(providerName, cloneCodexUsage(nextState));
		runtimeState.requestRender?.();
	} catch (error) {
		if (controller.signal.aborted || requestId !== runtimeState.codexUsageRequestId) return;

		const message = error instanceof Error ? error.message : String(error);
		runtimeState.codexUsage = {
			providerName,
			loading: false,
			fetchedAt: Date.now(),
			error: message,
		};
		runtimeState.requestRender?.();
	} finally {
		if (runtimeState.codexUsageAbort === controller) {
			runtimeState.codexUsageAbort = undefined;
		}
	}
}

function buildCodexUsageSnapshot(): UsageSnapshot | undefined {
	const providerName = getActiveCodexProvider();
	if (!providerName) return undefined;

	const usage = runtimeState.codexUsage;
	if (usage.providerName !== providerName || usage.loading) {
		return undefined;
	}

	const windows: RateWindow[] = [];
	const pushWindow = (label: string, window: CodexUsageWindow | undefined) => {
		if (!window) return;
		windows.push({
			label,
			usedPercent: window.usedPercent ?? 0,
			resetDescription: formatResetShort(window.resetAt),
			resetAt: window.resetAt ? new Date(window.resetAt * 1000).toISOString() : undefined,
		});
	};

	pushWindow("5h", usage.fiveHour);
	pushWindow("Week", usage.weekly);

	const error: UsageError | undefined = usage.error
		? { code: "FETCH_FAILED", message: usage.error }
		: undefined;

	return {
		provider: "codex",
		displayName: "OpenAI Codex",
		windows,
		error,
		lastSuccessAt: usage.fetchedAt,
		status: { indicator: "none" },
	};
}

function buildCodexQuotaSegment(theme: Theme): string {
	const providerName = getActiveCodexProvider();
	if (!providerName) return "";

	const usage = runtimeState.codexUsage;
	if (usage.providerName !== providerName || usage.loading) {
		return theme.fg("dim", "quota…");
	}

	const snapshot = buildCodexUsageSnapshot();
	if (!snapshot) {
		return theme.fg("warning", "quota?");
	}

	const settings = loadSubBarSettings();
	const formatted = formatUsageStatus(
		theme,
		snapshot,
		{
			provider: runtimeState.currentModel.provider,
			id: runtimeState.currentModel.id,
		},
		settings,
	);
	return formatted?.trim() || theme.fg("warning", "quota?");
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
	const provider = truncateToWidth(runtimeState.currentModel.provider ?? "no provider", 18, "…");
	const model = truncateToWidth(runtimeState.currentModel.name ?? runtimeState.currentModel.id ?? "no model", 28, "…");
	const thinkingLevel = runtimeState.currentModel.reasoning ? pi.getThinkingLevel() : "off";
	const directory = getCurrentDirectoryName(ctx.sessionManager.getCwd());
	const openRouterCostSegment = buildOpenRouterCostSegment(ctx, theme);
	const codexQuotaSegment = buildCodexQuotaSegment(theme);

	const segments = [
		`${theme.fg("dim", "⌂ ")}${theme.fg("accent", theme.bold(directory))}`,
		branch ? `${theme.fg("dim", "⎇ ")}${theme.fg("success", truncateToWidth(branch, 24, "…"))}` : "",
		styleContextPercent(theme, contextPercent),
		blue(provider),
		theme.bold(model),
		theme.fg(getThinkingColor(thinkingLevel), theme.bold(thinkingLevel)),
		statuses.preset ? blue(statuses.preset) : "",
		statuses.mcp ?? "",
		openRouterCostSegment,
		codexQuotaSegment,
		...statuses.others,
	];

	return joinSegments(theme, segments);
}

function buildFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
		const requestRender = () => tui.requestRender();
		runtimeState.requestRender = requestRender;

		return {
			dispose() {
				unsubscribeBranch();
				if (runtimeState.requestRender === requestRender) {
					runtimeState.requestRender = undefined;
				}
			},
			invalidate() {},
			render(width: number): string[] {
				const branch = footerData.getGitBranch();
				const providerName = runtimeState.currentModel.provider;
				const statuses = getFooterStatuses(
					Array.from(footerData.getExtensionStatuses().entries()).sort(([a], [b]) => a.localeCompare(b)),
					providerName,
				);

				return [truncateToWidth(buildFooterLine(pi, ctx, theme, branch, statuses), width, theme.fg("dim", "…"))];
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		syncCurrentModel(ctx);
		if (!ctx.hasUI) return;
		buildFooter(pi, ctx);
		void refreshCodexUsage(ctx, { force: true });
	});

	pi.on("model_select", async (_event, ctx) => {
		syncCurrentModel(ctx);
		if (!ctx.hasUI) return;
		buildFooter(pi, ctx);
		void refreshCodexUsage(ctx, { force: true });
	});

	pi.on("turn_end", async (_event, ctx) => {
		syncCurrentModel(ctx);
		if (!ctx.hasUI) return;
		void refreshCodexUsage(ctx);
		runtimeState.requestRender?.();
	});

	pi.on("session_shutdown", async () => {
		clearCodexUsage();
		runtimeState.currentModel = {};
		runtimeState.requestRender = undefined;
	});
}
