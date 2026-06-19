# Mobile Clean View and Global Manager Design

## Goal

Make pi-tmux-panel better on mobile by keeping chat engagement simple, making pane switching quick, and adding a global visible manager agent that can monitor and coordinate all tmux panes.

## Scope

This slice updates the existing pi extension only. It does not change pi core, hide pi thinking traces globally, or create a background daemon.

## Features

### Clean mobile tmux view

`/tmux list` and narrow terminal labels should default to a compact, chat-friendly view:

```text
1. ● current pi experiments
2. ◆ agent codex paia-program
3. ◐ mgr pi tmux-manager
```

The clean mobile label keeps only the pane number, activity glyph, relation/current hint, kind, and repo. It hides title text, task text, Workgraph IDs, role metadata, and long command/status detail. The existing detailed labels remain available in wide overlay rendering and pane preview.

### Fast switching

`/tmux <number|pane-id|target>` should act as a shortcut for `/tmux jump <selector>`. This supports quick mobile flipping without typing `jump`.

### Global manager command

`/mgr` opens or jumps to one central visible manager agent for all tmux sessions.

If a manager pane already exists, `/mgr` jumps to it. If not, it creates a dedicated tmux session/window named `pi-manager`, starts pi with a manager prompt, records its pane id in tmux-panel state, and jumps to it.

The manager is global, not per-pane or per-session. It is visible in tmux and can be killed/inspected like any other pane.

## Manager prompt

The manager agent is instructed to:

- Monitor all tmux sessions, windows, and panes.
- Identify agents, shells, idle panes, panes needing input, failed panes, and stale panes.
- Give concise mobile-friendly feedback.
- Help the user switch, send messages, spawn helpers, and clean up panes.
- Require confirmation before destructive actions such as kill, interrupt, or cleanup.
- Treat tmux as the source of process/workspace truth.

## State

Extend `~/.pi/agent/tmux-panel-state.json` with:

```json
{
  "manager": {
    "paneId": "%123",
    "target": "pi-manager:0.0",
    "createdAt": 1781812345678
  }
}
```

If the stored manager pane no longer exists, `/mgr` creates a replacement.

## Testing

Add pure helper tests for:

- clean mobile label formatting
- `/tmux <selector>` parsing as quick jump
- manager prompt creation
- manager session/window command construction
- manager pane resolution from state and pane list

Verify extension load, no global shortcuts, global sync, and push.
