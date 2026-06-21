# Single `/tmux` Cockpit Design

Date: 2026-06-20
Branch: `design/single-tmux-cockpit`
Status: Parked for backlog

## Problem

Braydon does not want to remember `/tmux` subcommands. The extension should behave like one cockpit: open `/tmux`, then discover and operate everything from inside the panel.

Current behavior has useful commands (`/tmux all`, `/tmux preview`, `/tmux send`, `/mgr`, etc.), but it asks the user to remember too many entrypoints. This is especially painful on mobile.

## Product Principle

One command:

```text
/tmux
```

Everything else is discoverable in the UI.

`/mgr` may remain as a compatibility alias, but it should not be a separate product surface. The manager/reviewer is an interaction layer inside the `/tmux` cockpit.

## Non-goals

- Do not make pi own tmux.
- Do not replace tmux as the process/view layer.
- Do not call a model on every render or keypress.
- Do not remove existing subcommands immediately; they can remain as hidden/power-user compatibility paths.

## Modes Inside `/tmux`

The `/tmux` overlay should expose modes as visible tabs/actions, not slash subcommands:

```text
[Panes] [Needs] [Brief] [Ask] [Settings]
```

Keyboard access should be mnemonic but discoverable:

- `Tab` / `Shift+Tab`: move between top-level modes or action chips.
- `/`: search/filter within the current mode.
- number keys: direct jump to visible pane numbers.
- `Enter`: primary action for selected item.
- `?`: help overlay showing available keys.

## Panes Mode

Default fast cockpit view.

Responsibilities:

- list panes with current desktop/mobile rendering rules
- preview selected pane
- jump by number
- send to selected pane
- refresh
- show current/recent/related context

No model call required.

## Needs Mode

A focused attention list.

Inputs:

- tmux facts
- tmux-monitor facts if available
- deterministic explicit signals: current pane, recent navigation, linked panes, manager tags
- cached reviewer assessments when available

Output:

- panes likely requiring attention
- evidence snippet for each row

No model call required to open, but may display cached model labels.

## Brief Mode

On-demand reviewer summary.

Question answered:

> What should I look at right now?

This is where model-mediated judgment belongs. It should use collected facts and cached monitor summaries, then return a concise, evidence-backed brief.

The brief must not auto-act. Suggested actions require explicit user confirmation.

## Ask Mode

A small chat interaction layer scoped to the tmux workspace or selected pane.

Examples:

```text
Is syn:3.1 stuck or working?
Which pane should I check next?
Summarize what this selected pane is asking for.
```

Ask mode can call a reviewer model, but only on demand.

## Settings Mode

Expose important toggles without requiring command memory:

- mobile/desktop rendering state
- smart shortlist vs all panes
- model reviewer on/off
- tmux-monitor integration status
- destructive confirmations enabled

## Manager Compatibility

`/mgr` should become an alias into the cockpit, not a separate surface.

Preferred mapping:

```text
/mgr -> /tmux opens Brief or Ask mode
```

A persistent visible manager pane can remain available as a cockpit action:

```text
Panes/Brief action: [Open manager pane]
```

But it should be secondary, not the default mental model.

## Model-Mediated Boundary

Deterministic code owns:

- tmux pane discovery
- identity (`session:window.pane`)
- current client pane/path
- preview/jump/send mechanics
- number buffering
- overlay rendering
- confirmation gates
- state persistence
- loading facts from tmux-monitor

Model/reviewer owns:

- ambiguous pane status interpretation
- workspace attention summary
- stuck vs long-running judgment
- natural-language explanation
- recommendation ordering when evidence is ambiguous

Avoid adding more deterministic semantic heuristics unless recorded as explicit deviations.

## tmux-monitor Role

`tmux-monitor` should act as sensors/cache:

- continuously observe panes
- keep recent output summaries
- track agent type and last activity
- expose cheap facts quickly to `/tmux`

`/tmux` should prefer tmux-monitor facts when available but degrade gracefully to direct tmux inspection.

## Backlog Implementation Slices

1. Add in-panel help (`?`) and mode header scaffolding.
2. Convert existing panel action row into a reusable action/mode navigation model.
3. Add `Needs` mode using existing facts only.
4. Add `/mgr` alias into `/tmux` Brief/Ask mode.
5. Add `Brief` mode with explicit on-demand reviewer call.
6. Add `Ask` mode scoped to selected pane/workspace.
7. Add tmux-monitor adapter for facts/summaries.
8. Hide-but-preserve subcommands as compatibility paths.

## Acceptance Criteria

- User can type only `/tmux` and discover all common functionality.
- No required memory of subcommands for normal use.
- Mobile flow remains chat-first and usable with number jumps.
- Desktop flow remains efficient and full-fidelity.
- Manager/reviewer calls happen only on explicit user action.
- Existing `/tmux <number>`, `/tmux all`, `/tmux send`, and `/mgr` continue to work during migration.
