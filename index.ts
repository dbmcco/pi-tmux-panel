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

type PanelState = { panes: Record<string, PaneMetadata>; activity: Record<string, ActivityMetadata> };

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
	buildCaptureArgs,
	buildJumpSteps,
	buildSendKeysArgs,
	formatPaneLabel,
	formatPaneCompactLabel,
	flattenGroups,
	resolvePaneSelector,
	parseTmuxCommandArgs,
	getOverlayOptions,
	enrichPaneMetadata,
	buildSpawnWindowArgs,
	computeScrollOffset,
	computeManualScrollOffset,
	formatCaptureError,
	normalizeRenderLines,
	computePaneActivity: coreComputePaneActivity,
} = core as {
	parsePaneRows: (output: string, currentPaneId?: string) => Pane[];
	groupPanes: (panes: Pane[], currentCwd?: string) => PaneGroup[];
	buildCaptureArgs: (pane: Pane, lines?: number) => string[];
	buildJumpSteps: (pane: Pane, clientName?: string) => string[][];
	buildSendKeysArgs: (pane: Pane, message: string) => string[];
	formatPaneLabel: (pane: Pane) => string;
	formatPaneCompactLabel: (number: number, pane: Pane) => string;
	flattenGroups: (groups: PaneGroup[]) => Array<{ number: number; groupTitle: string; pane: Pane }>;
	resolvePaneSelector: (
		flatItems: Array<{ number: number; groupTitle: string; pane: Pane }>,
		selector?: string,
	) => { number: number; groupTitle: string; pane: Pane } | undefined;
	parseTmuxCommandArgs: (args: string) =>
		| { action: "open"; query?: string }
		| { action: "list" }
		| { action: "preview" | "jump"; selector?: string }
		| { action: "send"; selector?: string; message?: string }
		| { action: "link"; selector?: string; role?: string }
		| { action: "unlink"; selector?: string }
		| { action: "wg"; selector?: string; taskId?: string }
		| { action: "spawn"; kind?: string; task?: string };
	getOverlayOptions: (columns?: number) => Record<string, unknown>;
	enrichPaneMetadata: (pane: Pane, state: PanelState, currentPaneId?: string, capturedText?: string) => Pane;
	buildSpawnWindowArgs: (cwd: string, kind: string, task?: string) => string[];
	computeScrollOffset: (selectedRowIndex: number, currentOffset: number, viewportSize: number) => number;
	computeManualScrollOffset: (currentOffset: number, delta: number, totalRows: number, viewportSize: number) => number;
	formatCaptureError: (pane: Pane, errorMessage: unknown) => string;
	normalizeRenderLines: (lines: string[], targetLineCount: number) => string[];
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

const computePaneActivity = coreComputePaneActivity ?? fallbackComputePaneActivity;

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

const STATE_PATH = path.join(os.homedir(), ".pi", "agent", "tmux-panel-state.json");

function loadPanelState(): PanelState {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
		return {
			panes: parsed?.panes && typeof parsed.panes === "object" ? parsed.panes : {},
			activity: parsed?.activity && typeof parsed.activity === "object" ? parsed.activity : {},
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
	const now = Date.now();
	const panes = await Promise.all(
		rawPanes.map(async (pane) => {
			const capturedText = await capturePaneForActivity(pi, pane);
			const activity = computePaneActivity(pane, capturedText, state.activity[pane.paneId], now);
			state.activity[pane.paneId] = activity.activity;
			return {
				...enrichPaneMetadata(pane, state, process.env.TMUX_PANE, capturedText),
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

async function sendToPane(pi: ExtensionAPI, pane: Pane, message: string): Promise<void> {
	await runTmux(pi, buildSendKeysArgs(pane, message));
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
	onDone: (result: PanelResult) => void;
	theme: any;
	tui: { requestRender: () => void };
}) {
	const { groups, previewPane, previewOutput, initialQuery = "", onDone, theme, tui } = options;
	let selectedPaneIndex = 0;
	let query = initialQuery;
	let searching = false;
	let actionIndex = 0;
	let scrollOffset = 0;
	let previewScrollOffset = 0;
	const actions: Array<{ label: string; result: (pane: Pane) => PanelResult }> = [
		{ label: "Jump", result: (pane) => ({ type: "jump", paneId: pane.paneId }) },
		{ label: "Send", result: (pane) => ({ type: "send", paneId: pane.paneId }) },
		{ label: "Back", result: () => ({ type: "back" }) },
		{ label: "Close", result: () => ({ type: "close" }) },
	];

	function paneRows() {
		return visibleRows(groups, query).filter((row): row is { kind: "pane"; pane: Pane } => row.kind === "pane");
	}

	function selectedPane(): Pane | undefined {
		return paneRows()[selectedPaneIndex]?.pane;
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
		const rows = visibleRows(groups, query);
		let paneOrdinal = -1;
		const lines: string[] = [];
		lines.push(theme.fg("accent", theme.bold("tmux panes")) + theme.fg("dim", "  / search • enter preview • r refresh • PgUp/PgDn • esc/q close"));
		lines.push(theme.fg("dim", searching ? `search: ${query}_` : query ? `filter: ${query}` : "filter: all panes • numbers move selection"));
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
			const label = width < 90 ? formatPaneCompactLabel(number, row.pane) : `${String(number).padStart(2)}  ${formatPaneLabel(row.pane)}`;
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

			if (matchesKey(data, Key.escape) || data === "q") onDone({ type: "close" });
			else if (data === "r") onDone({ type: "refresh" });
			else if (data === "/") {
				searching = true;
				tui.requestRender();
			} else if (matchesKey(data, Key.up)) {
				selectedPaneIndex--;
				clampSelection();
				tui.requestRender();
			} else if (matchesKey(data, Key.down)) {
				selectedPaneIndex++;
				clampSelection();
				tui.requestRender();
			} else if (matchesKey(data, Key.pageUp)) {
				selectedPaneIndex -= Math.max(5, (process.stdout.rows || 24) - 8);
				clampSelection();
				tui.requestRender();
			} else if (matchesKey(data, Key.pageDown)) {
				selectedPaneIndex += Math.max(5, (process.stdout.rows || 24) - 8);
				clampSelection();
				tui.requestRender();
			} else if (matchesKey(data, Key.enter)) {
				const pane = selectedPane();
				if (pane) onDone({ type: "preview", paneId: pane.paneId });
			} else if (/^[1-9]$/.test(data)) {
				const index = Number(data) - 1;
				if (index < paneRows().length) {
					selectedPaneIndex = index;
					tui.requestRender();
				}
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
			lines.push(formatPaneCompactLabel(globalNumber, item.pane));
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

async function showPanel(ctx: ExtensionCommandContext, groups: PaneGroup[], state: { previewPane?: Pane; previewOutput?: string; query?: string }) {
	return ctx.ui.custom<PanelResult | undefined>(
		(tui, theme, _keybindings, done) =>
			createPanel({
				groups,
				previewPane: state.previewPane,
				previewOutput: state.previewOutput,
				initialQuery: state.query,
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

			if (parsed.action === "jump") {
				const pane = resolveRequestedPane(parsed.selector);
				if (pane) await jumpToPane(pi, pane);
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
				const result = await showPanel(ctx, groups, { previewPane, previewOutput, query });
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
					await jumpToPane(pi, pane);
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
