# Pi Tmux Panel Implementation Plan

> **For agentic workers:** This is a small user-level pi extension implementation. Use TDD for pure helper behavior, then verify extension loading and interactive command registration. This global extension lives outside a project repo, so do not edit `/Users/braydon/projects` for this slice.

**Goal:** Add a `/tmux` command to pi that opens a key-conflict-safe overlay for listing tmux panes, previewing pane output, and explicitly jumping/sending to a selected pane.

**Architecture:** Keep tmux discovery and command construction in a pure CommonJS helper module that can be tested with Node's built-in test runner. Keep the pi extension in `index.ts`, with no global shortcuts; the `/tmux` command opens a focused overlay so keys are scoped only while the panel is active.

**Tech Stack:** pi extension API, `@earendil-works/pi-tui` custom components, tmux CLI, Node `node:test`.

## Global Constraints

- User-level extension path: `/Users/braydon/.pi/agent/extensions/tmux-panel/`.
- No global keyboard shortcuts in MVP; open only via `/tmux`.
- Preview-first behavior: list `Enter` previews, jump is an explicit preview action.
- Use stable `%pane_id` internally for capture/send/select-pane.
- Workgraph/driftdriver integration in this slice is link/display only; do not mutate Workgraph tasks.
- Visible spawning must require an explicit `/tmux spawn ...` command; no auto-spawning.
- Do not edit the experiments workspace root.

---

### Task 1: Core tmux helper tests and implementation

**Files:**
- Create: `/Users/braydon/.pi/agent/extensions/tmux-panel/test/tmux-core.test.cjs`
- Create: `/Users/braydon/.pi/agent/extensions/tmux-panel/tmux-core.cjs`

**Interfaces:**
- Produces `parsePaneRows(output, currentPaneId)`, `groupPanes(panes, currentCwd)`, `buildJumpSteps(pane, clientName)`, `buildCaptureArgs(pane, lines)`, `buildSendKeysArgs(pane, message)`, `formatPaneLabel(pane)`.

Steps:
1. Write failing Node tests for parsing, grouping, and tmux command args.
2. Run `node --test /Users/braydon/.pi/agent/extensions/tmux-panel/test/tmux-core.test.cjs` and verify failure due missing module/functions.
3. Implement `tmux-core.cjs` minimally.
4. Re-run the test command and verify pass.

### Task 2: Pi extension command and overlay

**Files:**
- Create: `/Users/braydon/.pi/agent/extensions/tmux-panel/index.ts`
- Modify: `/Users/braydon/.pi/agent/extensions/tmux-panel/README.md`

**Interfaces:**
- Consumes helper functions from Task 1.
- Produces `/tmux` extension command.

Steps:
1. Register `/tmux` only; do not register shortcuts.
2. Discover panes with `tmux list-panes -a` using tab-separated fields.
3. Render a right-side overlay list grouped as Current, Related, Agents, Shells / Other.
4. In list mode: arrows select, `/` starts search, Enter returns preview action, `r` refreshes, `Esc`/`q` closes.
5. In preview mode: show recent capture, `Esc` returns to list, `Tab` cycles action buttons, Enter activates selected action.
6. Implement Jump via explicit action using `tmux switch-client` + `tmux select-window` + `tmux select-pane`.
7. Implement Send via explicit action and `ctx.ui.input`, then `tmux send-keys -t %paneId message Enter`.

### Task 3: Mobile command flow

**Files:**
- Modify: `/Users/braydon/.pi/agent/extensions/tmux-panel/tmux-core.cjs`
- Modify: `/Users/braydon/.pi/agent/extensions/tmux-panel/index.ts`
- Modify: `/Users/braydon/.pi/agent/extensions/tmux-panel/README.md`

**Interfaces:**
- Produces `/tmux list`, `/tmux preview`, `/tmux jump`, and `/tmux send`.

Steps:
1. Add failing tests for selector resolution, compact labels, subcommand parsing, and responsive overlay options.
2. Implement minimal helpers and extension flow.
3. Verify all tests pass and command registration still works.

### Task 4: Orchestrator-lite status, links, Workgraph tags, and visible spawn

**Files:**
- Modify: `/Users/braydon/.pi/agent/extensions/tmux-panel/test/tmux-core.test.cjs`
- Modify: `/Users/braydon/.pi/agent/extensions/tmux-panel/tmux-core.cjs`
- Modify: `/Users/braydon/.pi/agent/extensions/tmux-panel/index.ts`
- Modify: `/Users/braydon/.pi/agent/extensions/tmux-panel/README.md`

**Interfaces:**
- Produces `/tmux link <selector> [role]`, `/tmux unlink <selector>`, `/tmux wg <selector> <task-id>`, `/tmux spawn pi <task>`, `/tmux spawn shell [name]`.
- Stores metadata in `/Users/braydon/.pi/agent/tmux-panel-state.json`.

Steps:
1. Add failing tests for improved type detection, status inference, metadata formatting, command parsing, and spawn command construction.
2. Implement pure helpers.
3. Implement state load/save and pane enrichment in the extension.
4. Implement explicit link/unlink/wg/spawn command handlers.
5. Verify tests, extension load, command registration, no global shortcut registration, and `%pane_id` usage.

### Task 5: Verification

**Files:**
- Existing files above.

Steps:
1. Run unit tests: `node --test /Users/braydon/.pi/agent/extensions/tmux-panel/test/tmux-core.test.cjs`.
2. Run a syntax/load smoke test using `pi -e /Users/braydon/.pi/agent/extensions/tmux-panel/index.ts --list-models` or an equivalent non-agent-loading command.
3. Verify `/Users/braydon/.pi/agent/extensions/tmux-panel/index.ts` contains no `registerShortcut` call.
4. Verify tmux command generation uses `%pane_id` for capture/send/select-pane.
