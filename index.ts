import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import core from "./tmux-core.cjs";

type Pane = {
	target: string;
	paneId: string;
	sessionName: string;
	windowIndex: string;
	paneIndex: string;
	command: string;
	cwd: string;
	title: string;
	panePid: string;
	kind: string;
	repo: string;
	isCurrent: boolean;
	status?: string;
	relation?: string;
	parentPaneId?: string;
	role?: string;
	workgraphTaskId?: string;
	task?: string;
	statusGlyph?: string;
	isPreviousPane?: boolean;
	isRecentPane?: boolean;
};

type PaneMetadata = {
	parentPaneId?: string;
	role?: string;
	workgraphTaskId?: string;
	task?: string;
	createdAt?: number;
};

type ActivityMetadata = {
	lastHash?: string;
	lastChangedAt?: number;
	lastSeenAt?: number;
	lastStatus?: string;
};

type ManagerMetadata = {
	paneId?: string;
	target?: string;
	createdAt?: number;
};

type NavigationMetadata = {
	currentPaneId?: string;
	previousPaneId?: string;
	updatedAt?: number;
};

type PanelState = {
	panes: Record<string, PaneMetadata>;
	activity: Record<string, ActivityMetadata>;
	manager?: ManagerMetadata;
	navigation?: NavigationMetadata;
};

type PaneGroup = { title: string; panes: Pane[] };

type PanelResult =
	| { type: "close" }
	| { type: "refresh" }
	| { type: "preview"; paneId: string }
	| { type: "back" }
	| { type: "jump"; paneId: string }
	| { type: "send"; paneId: string };

const {
	parsePaneRows,
	groupPanes,
	buildSmartMobileGroups: coreBuildSmartMobileGroups,
	buildCaptureArgs,
	buildJumpSteps,
	buildSendKeysArgs,
	formatPaneLabel,
	formatPaneCompactLabel,
	formatPaneCleanMobileLabel: coreFormatPaneCleanMobileLabel,
	flattenGroups,
	resolvePaneSelector,
	parseTmuxCommandArgs: coreParseTmuxCommandArgs,
	resolvePanelViewMode: coreResolvePanelViewMode,
	getOverlayOptions,
	enrichPaneMetadata: coreEnrichPaneMetadata,
	buildSpawnWindowArgs,
	buildManagerSessionArgs: coreBuildManagerSessionArgs,
	buildManagerWindowArgs: coreBuildManagerWindowArgs,
	resolveManagerPane: coreResolveManagerPane,
	updateJumpHistory: coreUpdateJumpHistory,
	resolveFlipPane: coreResolveFlipPane,
	MANAGER_SESSION_NAME: coreManagerSessionName,
	computeScrollOffset: coreComputeScrollOffset,
	computeManualScrollOffset: coreComputeManualScrollOffset,
	formatCaptureError: coreFormatCaptureError,
	normalizeRenderLines: coreNormalizeRenderLines,
	shouldIgnoreInitialPreviewEnter: coreShouldIgnoreInitialPreviewEnter,
	resolveNumericJumpInput: coreResolveNumericJumpInput,
	finalizeNumericJumpInput: coreFinalizeNumericJumpInput,
	computePaneActivity: coreComputePaneActivity,
} = core as {
	parsePaneRows: (output: string, currentPaneId?: string) => Pane[];
	groupPanes: (panes: Pane[], currentCwd?: string) => PaneGroup[];
	buildSmartMobileGroups?: (groups: PaneGroup[], limit?: number) => PaneGroup[];
	buildCaptureArgs: (pane: Pane, lines?: number) => string[];
	buildJumpSteps: (pane: Pane, clientName?: string) => string[][];
	buildSendKeysArgs: (pane: Pane, message: string) => string[];
	formatPaneLabel: (pane: Pane) => string;
	formatPaneCompactLabel: (number: number, pane: Pane) => string;
	formatPaneCleanMobileLabel?: (number: number, pane: Pane) => string;
	flattenGroups: (groups: PaneGroup[]) => Array<{ number: number; groupTitle: string; pane: Pane }>;
	resolvePaneSelector: (
		flatItems: Array<{ number: number; groupTitle: string; pane: Pane }>,
		selector?: string,
	) => { number: number; groupTitle: string; pane: Pane } | undefined;
	resolvePanelViewMode?: (configuredView?: string, columns?: number, threshold?: number) => "mobile" | "desktop";
	parseTmuxCommandArgs: (args: string) =>
		| { action: "open"; query?: string; scope?: string }
		| { action: "list" }
		| { action: "preview" | "jump"; selector?: string }
		| { action: "send"; selector?: string; message?: string }
		| { action: "link"; selector?: string; role?: string }
		| { action: "unlink"; selector?: string }
		| { action: "wg"; selector?: string; taskId?: string }
		| { action: "spawn"; kind?: string; task?: string }
		| { action: "flip" };
	getOverlayOptions: (columns?: number) => Record<string, unknown>;
	enrichPaneMetadata?: (pane: Pane, state: PanelState, currentPaneId?: string, capturedText?: string) => Pane;
	buildSpawnWindowArgs: (cwd: string, kind: string, task?: string) => string[];
	buildManagerSessionArgs?: (cwd: string) => string[];
	buildManagerWindowArgs?: (cwd: string) => string[];
	resolveManagerPane?: (panes: Pane[], state: PanelState) => Pane | undefined;
	updateJumpHistory?: (state: PanelState, fromPaneId?: string, toPaneId?: string, now?: number) => PanelState;
	resolveFlipPane?: (panes: Pane[], state: PanelState, currentPaneId?: string) => Pane | undefined;
	MANAGER_SESSION_NAME?: string;
	computeScrollOffset?: (selectedRowIndex: number, currentOffset: number, viewportSize: number) => number;
	computeManualScrollOffset?: (currentOffset: number, delta: number, totalRows: number, viewportSize: number) => number;
	formatCaptureError?: (pane: Pane, errorMessage: unknown) => string;
	normalizeRenderLines?: (lines: string[], targetLineCount: number) => string[];
	shouldIgnoreInitialPreviewEnter?: (openedAt: number, now?: number, guardMs?: number) => boolean;
	resolveNumericJumpInput?: (
		state: { buffer?: string; updatedAt?: number },
		digit: string,
		totalCount: number,
		now?: number,
		timeoutMs?: number,
	) => { buffer: string; updatedAt: number; selectedIndex?: number; shouldJump?: boolean };
	finalizeNumericJumpInput?: (
		state: { buffer?: string; updatedAt?: number },
		totalCount: number,
		now?: number,
		timeoutMs?: number,
	) => { selectedIndex: number; shouldJump: true } | undefined;
	computePaneActivity?: (
		pane: Pane,
		capturedText: string,
		previousActivity?: ActivityMetadata,
		now?: number,
	) => { status: string; statusGlyph: string; activity: ActivityMetadata };
};

function fallbackStatusGlyph(status: string): string {
	return (
		{
			active: "●",
			recent: "◐",
			cooling: "◌",
			idle: "○",
			"needs-input": "◆",
			done: "✓",
			error: "!",
			unknown: "?",
		} as Record<string, string>
	)[status] || "?";
}

function fallbackHashText(text: string): string {
	let hash = 5381;
	for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
	return (hash >>> 0).toString(16);
}

function fallbackStatusOverride(pane: Pane, capturedText: string): string | undefined {
	const text = `${pane.title || ""}\n${capturedText || ""}`.toLowerCase();
	if (/password:|\b(confirm|allow|deny|continue\?|proceed\?|select one|waiting for input|press enter)\b/.test(text)) return "needs-input";
	if (/\b(traceback|exception|panic|failed|failure|fatal|error:|command not found)\b/.test(text)) return "error";
	if (/\b(done|complete|completed|success|succeeded|finished|ready)\b/.test(text)) return "done";
	return undefined;
}

function fallbackComputePaneActivity(
	pane: Pane,
	capturedText: string,
	previousActivity?: ActivityMetadata,
	now = Date.now(),
): { status: string; statusGlyph: string; activity: ActivityMetadata } {
	const contentHash = fallbackHashText(capturedText || "");
	const isFirstSeen = !previousActivity?.lastHash;
	const changed = !isFirstSeen && previousActivity?.lastHash !== contentHash;
	const lastChangedAt = changed ? now : previousActivity?.lastChangedAt ?? now;
	const override = fallbackStatusOverride(pane, capturedText);
	let status = override;
	if (!status && isFirstSeen) status = pane.kind === "shell" ? "idle" : "unknown";
	else if (!status && changed) status = "active";
	else if (!status) {
		const age = Math.max(0, now - lastChangedAt);
		if (age < 60_000) status = "active";
		else if (age < 5 * 60_000) status = "recent";
		else if (age < 20 * 60_000) status = "cooling";
		else status = "idle";
	}
	return {
		status,
		statusGlyph: fallbackStatusGlyph(status),
		activity: { lastHash: contentHash, lastChangedAt, lastSeenAt: now, lastStatus: status },
	};
}

function fallbackEnrichPaneMetadata(pane: Pane, state: PanelState, currentPaneId?: string, capturedText?: string): Pane {
	const meta = state?.panes?.[pane.paneId] || {};
	const relation = meta.parentPaneId === currentPaneId ? "child" : meta.parentPaneId ? "linked" : undefined;
	const override = fallbackStatusOverride(pane, capturedText || "");
	const status = override || (pane.kind === "shell" ? "idle" : ["pi", "codex", "claude", "opencode", "kilocode"].includes(pane.kind) ? "active" : "unknown");
	return {
		...pane,
		status,
		relation,
		parentPaneId: meta.parentPaneId,
		role: meta.role,
		workgraphTaskId: meta.workgraphTaskId,
		task: meta.task,
		isPreviousPane: state.navigation?.previousPaneId === pane.paneId,
		isRecentPane: state.navigation?.currentPaneId === pane.paneId || state.navigation?.previousPaneId === pane.paneId,
	};
}

function fallbackComputeScrollOffset(selectedRowIndex: number, currentOffset: number, viewportSize: number): number {
	const viewport = Math.max(0, Number(viewportSize || 0));
	if (viewport <= 0) return 0;
	const selected = Math.max(0, Number(selectedRowIndex || 0));
	const offset = Math.max(0, Number(currentOffset || 0));
	if (selected < offset) return selected;
	if (selected >= offset + viewport) return selected - viewport + 1;
	return offset;
}

function fallbackComputeManualScrollOffset(currentOffset: number, delta: number, totalRows: number, viewportSize: number): number {
	const total = Math.max(0, Number(totalRows || 0));
	const viewport = Math.max(0, Number(viewportSize || 0));
	if (viewport <= 0 || total <= viewport) return 0;
	const maxOffset = Math.max(0, total - viewport);
	const next = Math.max(0, Number(currentOffset || 0) + Number(delta || 0));
	return Math.min(maxOffset, next);
}

function fallbackFormatCaptureError(pane: Pane, errorMessage: unknown): string {
	const message = errorMessage instanceof Error ? errorMessage.message : String(errorMessage || "Unknown capture error");
	return `Preview failed for ${pane.target} (${pane.paneId})\n${message}`;
}

function fallbackNormalizeRenderLines(lines: string[], targetLineCount: number): string[] {
	const target = Math.max(0, Number(targetLineCount || 0));
	if (target <= 0) return lines;
	const normalized = lines.slice(0, target);
	while (normalized.length < target) normalized.push("");
	return normalized;
}

const enrichPaneMetadata = coreEnrichPaneMetadata ?? fallbackEnrichPaneMetadata;
const computeScrollOffset = coreComputeScrollOffset ?? fallbackComputeScrollOffset;
const computeManualScrollOffset = coreComputeManualScrollOffset ?? fallbackComputeManualScrollOffset;
const formatCaptureError = coreFormatCaptureError ?? fallbackFormatCaptureError;
const normalizeRenderLines = coreNormalizeRenderLines ?? fallbackNormalizeRenderLines;
const computePaneActivity = coreComputePaneActivity ?? fallbackComputePaneActivity;
const shouldIgnoreInitialPreviewEnter =
	coreShouldIgnoreInitialPreviewEnter ??
	((openedAt: number, now = Date.now(), guardMs = 650): boolean => Boolean(openedAt) && Math.max(0, now - openedAt) < guardMs);

const LIST_PANES_FORMAT = [
	"#{session_name}:#{window_index}.#{pane_index}",
	"#{pane_id}",
	"#{session_name}",
	"#{window_index}",
	"#{pane_index}",
	"#{pane_current_command}",
	"#{pane_current_path}",
	"#{pane_title}",
	"#{pane_pid}",
].join("\t");

function fallbackBuildSmartMobileGroups(groups: PaneGroup[], limit = 12): PaneGroup[] {
	const seen = new Set<string>();
	const priority = (pane: Pane): number => {
		if (pane.isCurrent) return 5;
		if (pane.status === "needs-input" || pane.statusGlyph === "◆") return 10;
		if (pane.role === "manager" || pane.sessionName === "pi-manager" || /tmux manager/i.test(pane.title || "")) return 20;
		if (pane.isPreviousPane || pane.isRecentPane) return 30;
		if (pane.status === "active" || pane.status === "recent" || pane.statusGlyph === "●" || pane.statusGlyph === "◐") return 40;
		if (pane.relation === "child" || pane.relation === "linked") return 50;
		if (pane.status === "error" || pane.statusGlyph === "!") return 60;
		if (pane.status === "cooling" || pane.statusGlyph === "◌") return 70;
		return 90;
	};
	const panes = flattenGroups(groups)
		.map((item, index) => ({ pane: item.pane, index }))
		.filter((item) => {
			const key = item.pane.paneId || item.pane.target;
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => priority(a.pane) - priority(b.pane) || a.index - b.index)
		.slice(0, Math.max(1, Number(limit || 12)))
		.map((item) => item.pane);
	return panes.length > 0 ? [{ title: "Smart mobile shortlist", panes }] : [];
}

const buildSmartMobileGroups = coreBuildSmartMobileGroups ?? fallbackBuildSmartMobileGroups;
const MANAGER_SESSION_NAME = coreManagerSessionName ?? "pi-manager";
const MANAGER_WINDOW_NAME = "manager";

function localShellQuote(value: string): string {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function fallbackPaneTarget(pane: Pane): string {
	if (pane.target) return pane.target;
	if (pane.sessionName && pane.windowIndex !== undefined && pane.paneIndex !== undefined) return `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
	return pane.paneId || "";
}

function fallbackFormatPaneCleanMobileLabel(number: number, pane: Pane): string {
	const prefix = [`${number}.`, pane.statusGlyph, fallbackPaneTarget(pane)].filter(Boolean).join(" ");
	const description = pane.title || pane.task || pane.command || pane.cwd || pane.repo || "";
	return description ? `${prefix} — ${description}` : prefix;
}

const formatPaneCleanMobileLabel = coreFormatPaneCleanMobileLabel ?? fallbackFormatPaneCleanMobileLabel;

const NUMERIC_JUMP_TIMEOUT_MS = 650;

function fallbackHasLongerNumericMatch(prefix: string, totalCount: number): boolean {
	for (let value = 1; value <= Math.max(0, Number(totalCount || 0)); value++) {
		const text = String(value);
		if (text.length > prefix.length && text.startsWith(prefix)) return true;
	}
	return false;
}

function fallbackResolveNumericJumpInput(
	state: { buffer?: string; updatedAt?: number },
	digit: string,
	totalCount: number,
	now = Date.now(),
	timeoutMs = NUMERIC_JUMP_TIMEOUT_MS,
): { buffer: string; updatedAt: number; selectedIndex?: number; shouldJump?: boolean } {
	if (!/^[0-9]$/.test(String(digit || ""))) return { buffer: "", updatedAt: now };
	const previousBuffer = now - Number(state?.updatedAt || 0) < timeoutMs ? String(state?.buffer || "") : "";
	const buffer = `${previousBuffer}${digit}`.replace(/^0+/, "") || digit;
	const value = Number(buffer);
	const total = Math.max(0, Number(totalCount || 0));
	const selectedIndex = Number.isInteger(value) && value >= 1 && value <= total ? value - 1 : undefined;
	if (selectedIndex === undefined) return { buffer: "", updatedAt: now };
	const pending = fallbackHasLongerNumericMatch(buffer, total);
	return { buffer: pending ? buffer : "", updatedAt: now, selectedIndex, shouldJump: !pending };
}

function fallbackFinalizeNumericJumpInput(
	state: { buffer?: string; updatedAt?: number },
	totalCount: number,
	now = Date.now(),
	timeoutMs = NUMERIC_JUMP_TIMEOUT_MS,
): { selectedIndex: number; shouldJump: true } | undefined {
	const buffer = String(state?.buffer || "");
	if (!buffer || now - Number(state?.updatedAt || 0) < timeoutMs) return undefined;
	const value = Number(buffer);
	const total = Math.max(0, Number(totalCount || 0));
	if (!Number.isInteger(value) || value < 1 || value > total) return undefined;
	return { selectedIndex: value - 1, shouldJump: true };
}

const resolveNumericJumpInput = coreResolveNumericJumpInput ?? fallbackResolveNumericJumpInput;
const finalizeNumericJumpInput = coreFinalizeNumericJumpInput ?? fallbackFinalizeNumericJumpInput;

function fallbackResolvePanelViewMode(configuredView?: string, columns?: number, threshold = 100): "mobile" | "desktop" {
	if (configuredView === "mobile" || configuredView === "desktop") return configuredView;
	const width = Number(columns || 0);
	const cutoff = Math.max(1, Number(threshold || 100));
	return width > 0 && width < cutoff ? "mobile" : "desktop";
}

const resolvePanelViewMode = coreResolvePanelViewMode ?? fallbackResolvePanelViewMode;

function loadRuntimeViewState(): { view?: string; threshold?: number } {
	try {
		const parsed = JSON.parse(fs.readFileSync(VIEW_STATE_PATH, "utf8"));
		return {
			view: ["mobile", "desktop", "auto"].includes(parsed?.view) ? parsed.view : undefined,
			threshold: Number.isFinite(Number(parsed?.threshold)) && Number(parsed.threshold) > 0 ? Number(parsed.threshold) : undefined,
		};
	} catch {
		return {};
	}
}

function currentPanelViewMode(): "mobile" | "desktop" {
	const state = loadRuntimeViewState();
	return resolvePanelViewMode(state.view, process.stdout.columns || Number(process.env.COLUMNS) || 0, state.threshold ?? 100);
}

function fallbackManagerPrompt(): string {
	return [
		"You are the central tmux manager for Braydon's agent workspace.",
		"",
		"Your job is to monitor all tmux sessions, windows, and panes; identify coding agents, shells, idle panes, panes needing input, failed panes, and stale panes; and give concise mobile-friendly feedback.",
		"",
		"You may help the user switch panes, send messages to panes, spawn helper agents, and recommend cleanup. Require explicit confirmation before destructive actions including kill, interrupt, deletion, cleanup, or sending large prompts.",
		"",
		"Treat tmux as the source of process and workspace truth. Prefer preview-before-control. Use tmux-monitor status --all and tmux CLI inspection when you need current pane state. Keep responses short unless asked for detail.",
	].join("\n");
}

function fallbackManagerCommand(): string {
	return `pi --name 'tmux manager' --system-prompt ${localShellQuote(fallbackManagerPrompt())} ${localShellQuote("Open the central tmux manager. Start with a concise status summary and ask how you can help.")}`;
}

function fallbackBuildManagerSessionArgs(cwd: string): string[] {
	return ["new-session", "-d", "-s", MANAGER_SESSION_NAME, "-n", MANAGER_WINDOW_NAME, "-P", "-F", LIST_PANES_FORMAT, "-c", cwd, fallbackManagerCommand()];
}

function fallbackBuildManagerWindowArgs(cwd: string): string[] {
	return ["new-window", "-t", `${MANAGER_SESSION_NAME}:`, "-P", "-F", LIST_PANES_FORMAT, "-n", MANAGER_WINDOW_NAME, "-c", cwd, fallbackManagerCommand()];
}

const buildManagerSessionArgs = coreBuildManagerSessionArgs ?? fallbackBuildManagerSessionArgs;
const buildManagerWindowArgs = coreBuildManagerWindowArgs ?? fallbackBuildManagerWindowArgs;

function fallbackResolveManagerPane(panes: Pane[], state: PanelState): Pane | undefined {
	const managerPaneId = state.manager?.paneId;
	if (managerPaneId) {
		const byState = panes.find((pane) => pane.paneId === managerPaneId);
		if (byState) return byState;
	}
	return panes.find((pane) => pane.role === "manager" || pane.sessionName === MANAGER_SESSION_NAME || /tmux manager/i.test(pane.title || ""));
}

const resolveManagerPane = coreResolveManagerPane ?? fallbackResolveManagerPane;

function fallbackUpdateJumpHistory(state: PanelState, fromPaneId?: string, toPaneId?: string, now = Date.now()): PanelState {
	if (!fromPaneId || !toPaneId || fromPaneId === toPaneId) return state;
	state.navigation = { currentPaneId: toPaneId, previousPaneId: fromPaneId, updatedAt: now };
	return state;
}

function fallbackResolveFlipPane(panes: Pane[], state: PanelState, currentPaneId?: string): Pane | undefined {
	const previousPaneId = state.navigation?.previousPaneId;
	const lastPaneId = state.navigation?.currentPaneId;
	const preferredPaneId = currentPaneId === lastPaneId ? previousPaneId : lastPaneId;
	if (preferredPaneId && preferredPaneId !== currentPaneId) {
		const preferred = panes.find((pane) => pane.paneId === preferredPaneId);
		if (preferred) return preferred;
	}
	const fallbackPaneId = preferredPaneId === previousPaneId ? lastPaneId : previousPaneId;
	return fallbackPaneId && fallbackPaneId !== currentPaneId ? panes.find((pane) => pane.paneId === fallbackPaneId) : undefined;
}

const updateJumpHistory = coreUpdateJumpHistory ?? fallbackUpdateJumpHistory;
const resolveFlipPane = coreResolveFlipPane ?? fallbackResolveFlipPane;

function parseTmuxCommandArgs(args: string): ReturnType<typeof coreParseTmuxCommandArgs> | { action: "flip" } {
	const parsed = coreParseTmuxCommandArgs(args);
	if (parsed.action === "open" && parsed.query === "all") return { action: "open", scope: "all" };
	if (parsed.action === "open" && parsed.query === "flip") return { action: "flip" };
	if (parsed.action === "open" && parsed.query && /^(\d+|%\d+|[^\s:]+:\d+(?:\.\d+)?)$/.test(parsed.query)) {
		return { action: "jump", selector: parsed.query };
	}
	return parsed;
}

const STATE_PATH = path.join(os.homedir(), ".pi", "agent", "tmux-panel-state.json");
const VIEW_STATE_PATH = path.join(os.homedir(), ".pi", "agent", "runtime-view-switcher.json");

function loadPanelState(): PanelState {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
		return {
			panes: parsed?.panes && typeof parsed.panes === "object" ? parsed.panes : {},
			activity: parsed?.activity && typeof parsed.activity === "object" ? parsed.activity : {},
			manager: parsed?.manager && typeof parsed.manager === "object" ? parsed.manager : undefined,
			navigation: parsed?.navigation && typeof parsed.navigation === "object" ? parsed.navigation : undefined,
		};
	} catch {
		return { panes: {}, activity: {} };
	}
}

function savePanelState(state: PanelState): void {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function runTmux(pi: ExtensionAPI, args: string[]): Promise<string> {
	const result = await pi.exec("tmux", args, { timeout: 5000 });
	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || `tmux ${args.join(" ")} failed`).trim());
	}
	return result.stdout.trimEnd();
}

async function capturePaneForActivity(pi: ExtensionAPI, pane: Pane): Promise<string> {
	try {
		return await runTmux(pi, buildCaptureArgs(pane, 30));
	} catch {
		return "";
	}
}

async function loadPanes(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: PanelState): Promise<Pane[]> {
	const output = await runTmux(pi, ["list-panes", "-a", "-F", LIST_PANES_FORMAT]);
	const rawPanes = parsePaneRows(output, process.env.TMUX_PANE).map((pane) => ({
		...pane,
		isCurrent: pane.paneId === process.env.TMUX_PANE,
	}));
	const livePaneIds = new Set(rawPanes.map((pane) => pane.paneId));
	if (
		state.navigation &&
		state.navigation.currentPaneId &&
		state.navigation.previousPaneId &&
		!livePaneIds.has(state.navigation.currentPaneId) &&
		!livePaneIds.has(state.navigation.previousPaneId)
	) {
		delete state.navigation;
	}

	const now = Date.now();
	const panes = await Promise.all(
		rawPanes.map(async (pane) => {
			const capturedText = await capturePaneForActivity(pi, pane);
			const activity = computePaneActivity(pane, capturedText, state.activity[pane.paneId], now);
			state.activity[pane.paneId] = activity.activity;
			const enriched = enrichPaneMetadata(pane, state, process.env.TMUX_PANE, capturedText);
			return {
				...enriched,
				role: pane.paneId === state.manager?.paneId ? "manager" : enriched.role,
				status: activity.status,
				statusGlyph: activity.statusGlyph,
			};
		}),
	);
	savePanelState(state);
	return panes;
}

async function capturePane(pi: ExtensionAPI, pane: Pane): Promise<string> {
	try {
		return await runTmux(pi, buildCaptureArgs(pane, 80));
	} catch (error) {
		return formatCaptureError(pane, error);
	}
}

async function jumpToPane(pi: ExtensionAPI, pane: Pane): Promise<void> {
	let clientName = "";
	try {
		clientName = await runTmux(pi, ["display-message", "-p", "#{client_name}"]);
	} catch {
		clientName = "";
	}

	for (const args of buildJumpSteps(pane, clientName || undefined)) {
		await runTmux(pi, args);
	}
}

async function recordAndJumpToPane(pi: ExtensionAPI, pane: Pane, state: PanelState): Promise<void> {
	updateJumpHistory(state, process.env.TMUX_PANE, pane.paneId);
	savePanelState(state);
	await jumpToPane(pi, pane);
}

async function flipToPreviousPane(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: PanelState, panes: Pane[]): Promise<void> {
	const pane = resolveFlipPane(panes, state, process.env.TMUX_PANE);
	if (pane) {
		await recordAndJumpToPane(pi, pane, state);
		return;
	}

	try {
		const before = process.env.TMUX_PANE;
		await runTmux(pi, ["last-pane"]);
		let after = "";
		try {
			after = await runTmux(pi, ["display-message", "-p", "#{pane_id}"]);
		} catch {
			after = "";
		}
		if (after && before && after !== before) {
			updateJumpHistory(state, before, after);
			savePanelState(state);
		}
	} catch {
		ctx.ui.notify("No previous pane yet. Use /tmux list or /tmux <number> first.", "warning");
	}
}

async function sendToPane(pi: ExtensionAPI, pane: Pane, message: string): Promise<void> {
	await runTmux(pi, buildSendKeysArgs(pane, message));
}

async function tmuxSessionExists(pi: ExtensionAPI, sessionName: string): Promise<boolean> {
	const result = await pi.exec("tmux", ["has-session", "-t", sessionName], { timeout: 5000 });
	return result.code === 0;
}

async function createManagerPane(pi: ExtensionAPI, cwd: string, state: PanelState): Promise<Pane> {
	const hasManagerSession = await tmuxSessionExists(pi, MANAGER_SESSION_NAME);
	const output = await runTmux(pi, hasManagerSession ? buildManagerWindowArgs(cwd) : buildManagerSessionArgs(cwd));
	const spawned = parsePaneRows(output, process.env.TMUX_PANE)[0];
	if (!spawned?.paneId) throw new Error("tmux did not return a manager pane id");
	state.manager = { paneId: spawned.paneId, target: spawned.target, createdAt: Date.now() };
	state.panes[spawned.paneId] = {
		...(state.panes[spawned.paneId] ?? {}),
		role: "manager",
		task: "central tmux manager",
		createdAt: state.panes[spawned.paneId]?.createdAt ?? Date.now(),
	};
	savePanelState(state);
	return { ...spawned, role: "manager", repo: "tmux-manager" };
}

function visibleRows(groups: PaneGroup[], query: string): Array<{ kind: "group"; title: string } | { kind: "pane"; pane: Pane }> {
	const normalizedQuery = query.trim().toLowerCase();
	const rows: Array<{ kind: "group"; title: string } | { kind: "pane"; pane: Pane }> = [];

	for (const group of groups) {
		const matchingPanes = normalizedQuery
			? group.panes.filter((pane) =>
					[
						pane.target,
						pane.paneId,
						pane.kind,
						pane.statusGlyph,
						pane.status,
						pane.role,
						pane.workgraphTaskId,
						pane.task,
						pane.cwd,
						pane.title,
						pane.command,
						pane.repo,
					]
						.join(" ")
						.toLowerCase()
						.includes(normalizedQuery),
				)
			: group.panes;
		if (matchingPanes.length === 0) continue;
		rows.push({ kind: "group", title: group.title });
		for (const pane of matchingPanes) rows.push({ kind: "pane", pane });
	}

	return rows;
}

function createPanel(options: {
	groups: PaneGroup[];
	previewPane?: Pane;
	previewOutput?: string;
	initialQuery?: string;
	forceFullList?: boolean;
	initialActionIndex?: number;
	ignoreInitialEnterMs?: number;
	onDone: (result: PanelResult) => void;
	theme: any;
	tui: { requestRender: () => void };
}) {
	const { groups, previewPane, previewOutput, initialQuery = "", forceFullList = false, initialActionIndex = 0, ignoreInitialEnterMs = 0, onDone, theme, tui } = options;
	const openedAt = Date.now();
	let selectedPaneIndex = 0;
	let query = initialQuery;
	let searching = false;
	let actionIndex = initialActionIndex;
	let scrollOffset = 0;
	let previewScrollOffset = 0;
	let numericJump = { buffer: "", updatedAt: 0 };
	let numericJumpTimer: ReturnType<typeof setTimeout> | undefined;
	const actions: Array<{ label: string; result: (pane: Pane) => PanelResult }> = [
		{ label: "Jump", result: (pane) => ({ type: "jump", paneId: pane.paneId }) },
		{ label: "Send", result: (pane) => ({ type: "send", paneId: pane.paneId }) },
		{ label: "Back", result: () => ({ type: "back" }) },
		{ label: "Close", result: () => ({ type: "close" }) },
	];

	function panelMode(): "mobile" | "desktop" {
		return currentPanelViewMode();
	}

	function displayGroups(mode = panelMode()): PaneGroup[] {
		return mode === "mobile" && !forceFullList && !query.trim() ? buildSmartMobileGroups(groups, 12) : groups;
	}

	function paneRows() {
		return visibleRows(displayGroups(), query).filter((row): row is { kind: "pane"; pane: Pane } => row.kind === "pane");
	}

	function selectedPane(): Pane | undefined {
		return paneRows()[selectedPaneIndex]?.pane;
	}

	function clearNumericJump() {
		if (numericJumpTimer) clearTimeout(numericJumpTimer);
		numericJumpTimer = undefined;
		numericJump = { buffer: "", updatedAt: 0 };
	}

	function jumpSelectedIndex(index: number) {
		const pane = paneRows()[index]?.pane;
		if (pane) {
			clearNumericJump();
			onDone({ type: "jump", paneId: pane.paneId });
		}
	}

	function scheduleNumericJumpFinalize() {
		if (numericJumpTimer) clearTimeout(numericJumpTimer);
		numericJumpTimer = setTimeout(() => {
			const finalized = finalizeNumericJumpInput(numericJump, paneRows().length);
			if (!finalized?.shouldJump) return;
			jumpSelectedIndex(finalized.selectedIndex);
		}, NUMERIC_JUMP_TIMEOUT_MS);
	}

	function clampSelection() {
		const panes = paneRows();
		if (selectedPaneIndex >= panes.length) selectedPaneIndex = Math.max(0, panes.length - 1);
		if (selectedPaneIndex < 0) selectedPaneIndex = 0;
	}

	function selectedRowIndex(rows: Array<{ kind: "group"; title: string } | { kind: "pane"; pane: Pane }>): number {
		let paneOrdinal = -1;
		for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
			const row = rows[rowIndex];
			if (row.kind !== "pane") continue;
			paneOrdinal++;
			if (paneOrdinal === selectedPaneIndex) return rowIndex;
		}
		return 0;
	}

	function colorPaneLabel(pane: Pane, label: string, selected: boolean): string {
		if (selected) return theme.fg("accent", label);
		switch (pane.status) {
			case "active":
			case "done":
				return theme.fg("success", label);
			case "needs-input":
			case "recent":
			case "cooling":
				return theme.fg("warning", label);
			case "error":
				return theme.fg("error", label);
			case "idle":
				return theme.fg("dim", label);
			default:
				return label;
		}
	}

	function renderList(width: number): string[] {
		clampSelection();
		const mode = panelMode();
		const groupsForWidth = displayGroups(mode);
		const rows = visibleRows(groupsForWidth, query);
		let paneOrdinal = -1;
		const lines: string[] = [];
		const smart = mode === "mobile" && !forceFullList && !query.trim();
		lines.push(theme.fg("accent", theme.bold("tmux panes")) + theme.fg("dim", "  / search • enter preview • r refresh • PgUp/PgDn • esc/q close"));
		lines.push(
			theme.fg(
				"dim",
				searching
					? `search: ${query}_`
					: numericJump.buffer
						? `jump: ${numericJump.buffer}…`
						: query
							? `filter: ${query}`
							: smart
								? "smart shortlist • /tmux all for full list"
								: "filter: all panes • numbers jump directly",
			),
		);
		lines.push("");

		if (rows.length === 0) {
			scrollOffset = 0;
			lines.push(theme.fg("warning", "No panes match this filter."));
			return lines.map((line) => truncateToWidth(line, width));
		}

		const maxBodyLines = Math.max(5, (process.stdout.rows || 24) - 8);
		scrollOffset = computeScrollOffset(selectedRowIndex(rows), scrollOffset, maxBodyLines);
		const visible = rows.slice(scrollOffset, scrollOffset + maxBodyLines);
		if (scrollOffset > 0) lines.push(theme.fg("dim", `↑ ${scrollOffset} earlier row(s)`));

		for (const row of visible) {
			if (row.kind === "group") {
				lines.push(theme.fg("muted", `── ${row.title} ──`));
				continue;
			}

			paneOrdinal = rows.slice(0, rows.indexOf(row) + 1).filter((candidate) => candidate.kind === "pane").length - 1;
			const selected = paneOrdinal === selectedPaneIndex;
			const number = paneOrdinal + 1;
			const prefix = selected ? theme.fg("accent", "> ") : "  ";
			const label = mode === "mobile" ? formatPaneCleanMobileLabel(number, row.pane) : `${String(number).padStart(2)}  ${formatPaneLabel(row.pane)}`;
			lines.push(prefix + colorPaneLabel(row.pane, label, selected));
		}
		const remaining = rows.length - (scrollOffset + maxBodyLines);
		if (remaining > 0) lines.push(theme.fg("dim", `↓ ${remaining} more row(s)`));

		return lines.map((line) => truncateToWidth(line, width));
	}

	function renderFrameLineCount(): number {
		const rows = process.stdout.rows || 24;
		const columns = process.stdout.columns || 0;
		const overlayRatio = columns > 0 && columns < 100 ? 0.95 : 0.9;
		return Math.max(8, Math.floor(rows * overlayRatio) - 2);
	}

	function previewViewportSize(): number {
		return Math.max(5, renderFrameLineCount() - 7);
	}

	function renderPreview(width: number): string[] {
		const pane = previewPane;
		if (!pane) return [theme.fg("warning", "No pane selected.")];
		const lines: string[] = [];
		lines.push(theme.fg("accent", theme.bold(`preview ${pane.target} ${pane.paneId}`)));
		lines.push(theme.fg("dim", `${pane.kind} • ${pane.cwd}`));
		if (pane.title) lines.push(theme.fg("dim", pane.title));
		lines.push("");

		const actionLine = actions
			.map((action, index) => {
				const text = `[${action.label}]`;
				return index === actionIndex ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text);
			})
			.join(" ");
		lines.push(actionLine + theme.fg("dim", "  ↑↓/PgUp/PgDn scroll • tab action • esc back"));
		lines.push(theme.fg("muted", "─".repeat(Math.max(1, Math.min(width, 80)))));

		const captured = previewOutput?.trimEnd() || "(no recent output)";
		const capturedLines = captured.split("\n");
		const viewport = previewViewportSize();
		previewScrollOffset = computeManualScrollOffset(previewScrollOffset, 0, capturedLines.length, viewport);
		if (previewScrollOffset > 0) lines.push(theme.fg("dim", `↑ ${previewScrollOffset} earlier line(s)`));
		for (const line of capturedLines.slice(previewScrollOffset, previewScrollOffset + viewport)) {
			lines.push(line || " ");
		}
		const remaining = capturedLines.length - (previewScrollOffset + viewport);
		if (remaining > 0) lines.push(theme.fg("dim", `↓ ${remaining} more line(s)`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	return {
		render(width: number): string[] {
			const lines = previewPane ? renderPreview(width) : renderList(width);
			return normalizeRenderLines(lines, renderFrameLineCount());
		},
		invalidate() {},
		handleInput(data: string) {
			if (previewPane) {
				const capturedLineCount = (previewOutput?.trimEnd() || "(no recent output)").split("\n").length;
				const page = previewViewportSize();
				if (matchesKey(data, Key.escape) || data === "q") onDone({ type: "back" });
				else if (matchesKey(data, Key.up)) {
					previewScrollOffset = computeManualScrollOffset(previewScrollOffset, -1, capturedLineCount, page);
					tui.requestRender();
				} else if (matchesKey(data, Key.down)) {
					previewScrollOffset = computeManualScrollOffset(previewScrollOffset, 1, capturedLineCount, page);
					tui.requestRender();
				} else if (matchesKey(data, Key.pageUp)) {
					previewScrollOffset = computeManualScrollOffset(previewScrollOffset, -page, capturedLineCount, page);
					tui.requestRender();
				} else if (matchesKey(data, Key.pageDown)) {
					previewScrollOffset = computeManualScrollOffset(previewScrollOffset, page, capturedLineCount, page);
					tui.requestRender();
				} else if (matchesKey(data, Key.tab)) {
					actionIndex = (actionIndex + 1) % actions.length;
					tui.requestRender();
				} else if (matchesKey(data, Key.enter)) {
					if (shouldIgnoreInitialPreviewEnter(openedAt, Date.now(), ignoreInitialEnterMs)) {
						tui.requestRender();
						return;
					}
					onDone(actions[actionIndex].result(previewPane));
				}
				return;
			}

			if (searching) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
					searching = false;
				} else if (matchesKey(data, Key.backspace)) {
					query = query.slice(0, -1);
				} else if (data.length === 1 && data >= " " && data !== "\x7f") {
					query += data;
				}
				selectedPaneIndex = 0;
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.escape) || data === "q") {
				clearNumericJump();
				onDone({ type: "close" });
			} else if (data === "r") {
				clearNumericJump();
				onDone({ type: "refresh" });
			} else if (data === "/") {
				clearNumericJump();
				searching = true;
				tui.requestRender();
			} else if (matchesKey(data, Key.up)) {
				clearNumericJump();
				selectedPaneIndex--;
				clampSelection();
				tui.requestRender();
			} else if (matchesKey(data, Key.down)) {
				clearNumericJump();
				selectedPaneIndex++;
				clampSelection();
				tui.requestRender();
			} else if (matchesKey(data, Key.pageUp)) {
				clearNumericJump();
				selectedPaneIndex -= Math.max(5, (process.stdout.rows || 24) - 8);
				clampSelection();
				tui.requestRender();
			} else if (matchesKey(data, Key.pageDown)) {
				clearNumericJump();
				selectedPaneIndex += Math.max(5, (process.stdout.rows || 24) - 8);
				clampSelection();
				tui.requestRender();
			} else if (matchesKey(data, Key.enter)) {
				const finalized = finalizeNumericJumpInput(numericJump, paneRows().length, Date.now(), 0);
				if (finalized?.shouldJump) {
					jumpSelectedIndex(finalized.selectedIndex);
					return;
				}
				clearNumericJump();
				const pane = selectedPane();
				if (pane) onDone({ type: "preview", paneId: pane.paneId });
			} else if (/^[0-9]$/.test(data)) {
				const result = resolveNumericJumpInput(numericJump, data, paneRows().length);
				numericJump = { buffer: result.buffer, updatedAt: result.updatedAt };
				if (result.selectedIndex !== undefined) selectedPaneIndex = result.selectedIndex;
				if (result.shouldJump && result.selectedIndex !== undefined) {
					jumpSelectedIndex(result.selectedIndex);
					return;
				}
				if (numericJump.buffer) scheduleNumericJumpFinalize();
				tui.requestRender();
			}
		},
	};
}

function formatNumberedPaneList(groups: PaneGroup[]): string {
	const lines: string[] = [];
	for (const group of groups) {
		lines.push(`── ${group.title} ──`);
		for (const item of flattenGroups([{ title: group.title, panes: group.panes }])) {
			const globalNumber = flattenGroups(groups).find((candidate) => candidate.pane.paneId === item.pane.paneId)?.number ?? item.number;
			lines.push(formatPaneCleanMobileLabel(globalNumber, item.pane));
		}
		lines.push("");
	}
	lines.push("Commands:");
	lines.push("  /tmux preview <number|pane-id|target>");
	lines.push("  /tmux jump <number|pane-id|target>");
	lines.push("  /tmux send <number|pane-id|target> <message>");
	lines.push("  /tmux link <number|pane-id|target> [role]");
	lines.push("  /tmux wg <number|pane-id|target> <task-id>");
	lines.push("  /tmux spawn pi <task>");
	return lines.join("\n").trimEnd();
}

async function showPanel(
	ctx: ExtensionCommandContext,
	groups: PaneGroup[],
	state: { previewPane?: Pane; previewOutput?: string; query?: string; forceFullList?: boolean; initialActionIndex?: number; ignoreInitialEnterMs?: number },
) {
	return ctx.ui.custom<PanelResult | undefined>(
		(tui, theme, _keybindings, done) =>
			createPanel({
				groups,
				previewPane: state.previewPane,
				previewOutput: state.previewOutput,
				initialQuery: state.query,
				forceFullList: state.forceFullList,
				initialActionIndex: state.initialActionIndex,
				ignoreInitialEnterMs: state.ignoreInitialEnterMs,
				theme,
				tui,
				onDone: done,
			}),
		{
			overlay: true,
			overlayOptions: getOverlayOptions(process.stdout.columns),
		},
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("mgr", {
		description: "Open or create the central tmux manager agent",
		handler: async (_args, ctx) => {
			if (!process.env.TMUX) {
				ctx.ui.notify("/mgr is only available inside tmux.", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/mgr requires interactive TUI mode.", "warning");
				return;
			}

			const state = loadPanelState();
			let panes = await loadPanes(pi, ctx, state);
			let managerPane = resolveManagerPane(panes, state);
			if (!managerPane) {
				managerPane = await createManagerPane(pi, ctx.cwd, state);
				ctx.ui.notify(`Created central manager in ${managerPane.target}`, "info");
				panes = await loadPanes(pi, ctx, state);
				managerPane = resolveManagerPane(panes, state) ?? managerPane;
			} else if (managerPane.paneId !== state.manager?.paneId) {
				state.manager = { paneId: managerPane.paneId, target: managerPane.target, createdAt: state.manager?.createdAt ?? Date.now() };
				state.panes[managerPane.paneId] = {
					...(state.panes[managerPane.paneId] ?? {}),
					role: "manager",
					task: "central tmux manager",
					createdAt: state.panes[managerPane.paneId]?.createdAt ?? Date.now(),
				};
				savePanelState(state);
			}

			let previewPane: Pane | undefined = managerPane;
			let previewOutput: string | undefined = await capturePane(pi, managerPane);
			while (true) {
				const groups = groupPanes(panes, ctx.cwd);
				const result = await showPanel(ctx, groups, { previewPane, previewOutput, initialActionIndex: 1, ignoreInitialEnterMs: 900 });
				if (!result || result.type === "close" || result.type === "back") return;
				if (result.type === "refresh") {
					panes = await loadPanes(pi, ctx, state);
					previewPane = resolveManagerPane(panes, state) ?? managerPane;
					previewOutput = previewPane ? await capturePane(pi, previewPane) : undefined;
					continue;
				}
				if (result.type === "jump") {
					await recordAndJumpToPane(pi, managerPane, state);
					return;
				}
				if (result.type === "send") {
					const message = await ctx.ui.input(`Send to manager ${managerPane.target}`, "message to send");
					if (message?.trim()) {
						await sendToPane(pi, managerPane, message.trim());
						ctx.ui.notify(`Sent to manager ${managerPane.target}`, "info");
					}
					previewOutput = await capturePane(pi, managerPane);
				}
			}
		},
	});

	pi.registerCommand("flip", {
		description: "Flip back to the previous tmux pane",
		handler: async (_args, ctx) => {
			if (!process.env.TMUX) {
				ctx.ui.notify("/flip is only available inside tmux.", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/flip requires interactive TUI mode.", "warning");
				return;
			}
			const state = loadPanelState();
			const panes = await loadPanes(pi, ctx, state);
			await flipToPreviousPane(pi, ctx, state, panes);
		},
	});

	pi.registerCommand("tmux", {
		description: "Open a preview-first tmux pane switcher overlay",
		handler: async (args, ctx) => {
			if (!process.env.TMUX) {
				ctx.ui.notify("/tmux is only available inside tmux.", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tmux requires interactive TUI mode.", "warning");
				return;
			}

			const state = loadPanelState();
			let panes = await loadPanes(pi, ctx, state);
			let groups = groupPanes(panes, ctx.cwd);
			let flat = flattenGroups(groups);
			const parsed = parseTmuxCommandArgs(args);
			let previewPane: Pane | undefined;
			let previewOutput: string | undefined;
			let query = parsed.action === "open" ? (parsed.query ?? "") : "";
			const forceFullList = parsed.action === "open" && parsed.scope === "all";

			const resolveRequestedPane = (selector?: string): Pane | undefined => {
				const item = resolvePaneSelector(flat, selector);
				if (!item) ctx.ui.notify(`No tmux pane matches: ${selector || "(missing selector)"}`, "warning");
				return item?.pane;
			};

			if (parsed.action === "list") {
				await ctx.ui.editor("tmux panes", formatNumberedPaneList(groups));
				return;
			}

			if (parsed.action === "preview") {
				previewPane = resolveRequestedPane(parsed.selector);
				if (!previewPane) return;
				previewOutput = await capturePane(pi, previewPane);
			}

			if (parsed.action === "flip") {
				await flipToPreviousPane(pi, ctx, state, panes);
				return;
			}

			if (parsed.action === "jump") {
				const pane = resolveRequestedPane(parsed.selector);
				if (pane) await recordAndJumpToPane(pi, pane, state);
				return;
			}

			if (parsed.action === "send") {
				const pane = resolveRequestedPane(parsed.selector);
				if (!pane) return;
				const message = parsed.message?.trim() || (await ctx.ui.input(`Send to ${pane.target}`, "message to send"))?.trim();
				if (message) {
					await sendToPane(pi, pane, message);
					ctx.ui.notify(`Sent to ${pane.target}`, "info");
				}
				return;
			}

			if (parsed.action === "link") {
				const pane = resolveRequestedPane(parsed.selector);
				if (!pane) return;
				state.panes[pane.paneId] = {
					...(state.panes[pane.paneId] ?? {}),
					parentPaneId: process.env.TMUX_PANE,
					role: parsed.role?.trim() || state.panes[pane.paneId]?.role || "linked",
					createdAt: state.panes[pane.paneId]?.createdAt ?? Date.now(),
				};
				savePanelState(state);
				ctx.ui.notify(`Linked ${pane.target} as ${state.panes[pane.paneId].role}`, "info");
				return;
			}

			if (parsed.action === "unlink") {
				const pane = resolveRequestedPane(parsed.selector);
				if (!pane) return;
				delete state.panes[pane.paneId];
				savePanelState(state);
				ctx.ui.notify(`Unlinked ${pane.target}`, "info");
				return;
			}

			if (parsed.action === "wg") {
				const pane = resolveRequestedPane(parsed.selector);
				if (!pane || !parsed.taskId?.trim()) {
					if (pane) ctx.ui.notify("Usage: /tmux wg <pane> <task-id>", "warning");
					return;
				}
				state.panes[pane.paneId] = {
					...(state.panes[pane.paneId] ?? {}),
					workgraphTaskId: parsed.taskId.trim(),
					createdAt: state.panes[pane.paneId]?.createdAt ?? Date.now(),
				};
				savePanelState(state);
				ctx.ui.notify(`Tagged ${pane.target} with Workgraph task ${parsed.taskId.trim()}`, "info");
				return;
			}

			if (parsed.action === "spawn") {
				const kind = parsed.kind === "shell" ? "shell" : "pi";
				const task = parsed.task?.trim() || (kind === "pi" ? (await ctx.ui.input("Spawn visible pi agent", "task"))?.trim() : "shell");
				if (!task) return;
				const output = await runTmux(pi, buildSpawnWindowArgs(ctx.cwd, kind, task));
				const spawned = parsePaneRows(output, process.env.TMUX_PANE)[0];
				if (spawned?.paneId) {
					state.panes[spawned.paneId] = {
						parentPaneId: process.env.TMUX_PANE,
						role: kind,
						task,
						createdAt: Date.now(),
					};
					savePanelState(state);
					ctx.ui.notify(`Spawned ${kind} in ${spawned.target}`, "info");
				} else {
					ctx.ui.notify(`Spawned ${kind}`, "info");
				}
				return;
			}

			while (true) {
				const groups = groupPanes(panes, ctx.cwd);
				const result = await showPanel(ctx, groups, { previewPane, previewOutput, query, forceFullList });
				if (!result || result.type === "close") return;

				if (result.type === "refresh") {
					panes = await loadPanes(pi, ctx, state);
					previewPane = undefined;
					previewOutput = undefined;
					continue;
				}

				if (result.type === "back") {
					previewPane = undefined;
					previewOutput = undefined;
					continue;
				}

				const pane = panes.find((candidate) => candidate.paneId === result.paneId);
				if (!pane) {
					ctx.ui.notify(`Pane disappeared: ${result.paneId}`, "warning");
					panes = await loadPanes(pi, ctx, state);
					previewPane = undefined;
					previewOutput = undefined;
					continue;
				}

				if (result.type === "preview") {
					previewPane = pane;
					previewOutput = await capturePane(pi, pane);
					continue;
				}

				if (result.type === "jump") {
					await recordAndJumpToPane(pi, pane, state);
					return;
				}

				if (result.type === "send") {
					const message = await ctx.ui.input(`Send to ${pane.target}`, "message to send");
					if (message?.trim()) {
						await sendToPane(pi, pane, message.trim());
						ctx.ui.notify(`Sent to ${pane.target}`, "info");
					}
					previewPane = undefined;
					previewOutput = undefined;
				}
			}
		},
	});
}
