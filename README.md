# pi-tmux-panel

A [pi](https://pi.dev) extension for tmux-heavy agent coordination.

It adds a `/tmux` command that opens a preview-first tmux pane switcher inside pi, plus mobile-friendly subcommands for listing, quick jumping, flipping between panes, previewing, sending, linking, tagging, spawning visible pi/shell panes, and opening a global `/mgr` tmux manager agent.

## Install

From GitHub:

```bash
pi install git:github.com/dbmcco/pi-tmux-panel
```

For local development:

```bash
mkdir -p ~/.pi/agent/extensions/tmux-panel
ln -sf "$PWD/index.ts" ~/.pi/agent/extensions/tmux-panel/index.ts
ln -sf "$PWD/tmux-core.cjs" ~/.pi/agent/extensions/tmux-panel/tmux-core.cjs
```

Then in pi:

```text
/reload
/tmux
```

# tmux-panel pi extension

Adds a `/tmux` command that opens a preview-first tmux pane switcher inside pi.

## Usage

Desktop overlay:

```text
/tmux
```

Mobile-friendly command flow:

```text
/tmux
/tmux all
/tmux list
/tmux <number|pane-id|target>
/flip
/tmux flip
/tmux preview <number|pane-id|target>
/tmux jump <number|pane-id|target>
/tmux send <number|pane-id|target> <message>
/tmux link <number|pane-id|target> [role]
/tmux unlink <number|pane-id|target>
/tmux wg <number|pane-id|target> <task-id>
/tmux spawn pi <task>
/tmux spawn shell [name]
/tmux delegate <task>
/mgr
```

Examples:

```text
/tmux list
/tmux 3
/flip
/tmux preview 3
/tmux jump %129
/tmux send infra:2.1 please summarize status
/tmux link 3 reviewer
/tmux wg 3 WG-123
/tmux spawn pi review the auth changes
/tmux delegate scout the tmux extension code
/mgr
```

## Behavior

- Opens a right-side overlay on wide terminals.
- Opens a full-width centered overlay on narrow/mobile terminals.
- `/tmux` honors Pi's runtime view setting: `/view desktop` uses desktop rows, while `/view mobile` uses mobile rows.
- On narrow/mobile terminals, `/tmux` defaults to a smart cockpit shortlist so the global pane list does not overwhelm chat flow.
- Smart mobile order favors current pane, panes needing input, manager, recently used/flip targets, active agents, linked/same-work panes, then lower-priority error/done/idle panes.
- `/tmux all` forces the full global pane list when needed.
- Uses mobile labels on narrow terminals and `/tmux list` that show pane target plus useful description/title, e.g. `1. ● infra:1.1 — pi · experiments`.
- Number keys jump directly. Multi-digit numbers are buffered briefly, so typing `23` jumps to pane 23 instead of selecting 2 then 3.
- `/tmux <selector>` quick-jumps for fast mobile pane switching.
- `/flip` and `/tmux flip` toggle back to the previous pane recorded by `/tmux`, `/mgr` Jump, or overlay Jump, with tmux native last-pane fallback when no extension history exists.
- Lists tmux panes grouped by current pane, related cwd, other agents, and shells.
- Uses tmux metadata for identity before preview: session/window/pane, `%pane_id`, command, cwd, title.
- `Enter` previews recent pane output.
- Jumping is an explicit preview action, not the default list action.
- Numbered selectors work in overlay lists and `/tmux` subcommands.
- Scans recent output from every pane on `/tmux` open and refresh.
- Shows colored activity glyphs and long-decay status:
  - `● active` — output changed within ~60s
  - `◐ recent` — output changed within ~5m
  - `◌ cooling` — output changed within ~20m
  - `○ idle` — no output change for 20m+
  - `◆ needs-input` — prompt/confirmation/password-looking output
  - `✓ done` — completion-looking output
  - `! error` — error/failure-looking output
  - `? unknown` — first scan/no activity baseline yet
- Improved agent type detection for pi, codex, claude, opencode, kilocode, and shells.
- Can associate panes with the current pane via `/tmux link`.
- Can display Workgraph task IDs via `/tmux wg`; this is display-only and does not mutate Workgraph.
- Can explicitly spawn visible pi/shell panes via `/tmux spawn`.
- `/mgr` opens a preview/control panel for the global manager agent; use `Jump` to go to it or `Send` to interact without leaving the current pane.
- No global keyboard shortcuts are registered.

## State

Pane metadata is stored at:

```text
~/.pi/agent/tmux-panel-state.json
```

The state file records optional parent pane, role, task, Workgraph task tags, activity decay metadata keyed by stable `%pane_id`, jump history for `/flip`, and the global manager pane id/target.

## Keys

List mode:

| Key | Action |
|---|---|
| `↑` / `↓` | Select pane; list scrolls to keep selection visible |
| `PageUp` / `PageDown` | Move by one visible page |
| `/` | Search/filter |
| `Enter` | Preview selected pane |
| `r` | Refresh panes |
| `1`-`9` | Move selection to visible pane number |
| `Esc` / `q` | Close overlay |

Preview mode:

| Key | Action |
|---|---|
| `↑` / `↓` | Scroll preview output by one line |
| `PageUp` / `PageDown` | Scroll preview output by one page |
| `Tab` | Cycle action buttons |
| `Enter` | Activate selected action |
| `Esc` / `q` | Return to list |

Preview actions:

- `Jump` — switch current tmux client to the pane.
- `Send` — prompt for a message, then send it plus Enter to the pane.
- `Back` — return to list.
- `Close` — close overlay.

## Manager

```text
/mgr
```

`/mgr` opens or creates a single global manager agent for all tmux sessions, then shows it in a preview-first panel. From that panel you can:

- `Jump` into the manager pane.
- `Send` a message to the manager without leaving your current pane.
- `Back`/`Close` without switching.

The manager lives in a visible tmux session/window named `pi-manager:manager`, uses a dedicated manager system prompt, and can inspect/control all panes through normal tmux/pi tools. Destructive actions remain confirmation-gated by prompt policy.

## Verification

```bash
node --test ~/.pi/agent/extensions/tmux-panel/test/tmux-core.test.cjs
pi -e ~/.pi/agent/extensions/tmux-panel/index.ts --list-models >/tmp/tmux-panel-load.txt
```
