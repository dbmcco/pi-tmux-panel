const assert = require('node:assert/strict');
const test = require('node:test');

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
  inferPaneStatus,
  enrichPaneMetadata,
  buildSpawnCommand,
  buildSpawnWindowArgs,
  shellQuote,
  computeScrollOffset,
  computeManualScrollOffset,
  formatCaptureError,
} = require('../tmux-core.cjs');

const sampleRows = [
  'infra:1.1\t%128\tinfra\t1\t1\tnode\t/Users/braydon/projects/experiments\tpi · experiments\t111',
  'infra:2.1\t%129\tinfra\t2\t1\tzsh\t/Users/braydon\tmac.lan\t222',
  'paia:7.1\t%125\tpaia\t7\t1\tcodex-aarch64-a\t/Users/braydon/projects/experiments/paia-program\tpaia-program | 5h 84% left\t333',
  'syn:6.1\t%096\tsyn\t6\t1\tnode\t/Users/braydon/projects/work/synth\tpi · synth\t444',
].join('\n');

test('parsePaneRows extracts stable pane identity and inferred kind', () => {
  const panes = parsePaneRows(sampleRows, '%128');

  assert.equal(panes.length, 4);
  assert.deepEqual(
    panes.map((pane) => ({ target: pane.target, paneId: pane.paneId, kind: pane.kind, isCurrent: pane.isCurrent })),
    [
      { target: 'infra:1.1', paneId: '%128', kind: 'pi', isCurrent: true },
      { target: 'infra:2.1', paneId: '%129', kind: 'shell', isCurrent: false },
      { target: 'paia:7.1', paneId: '%125', kind: 'codex', isCurrent: false },
      { target: 'syn:6.1', paneId: '%096', kind: 'pi', isCurrent: false },
    ],
  );
});

test('groupPanes places current pane first, then related panes, then agents, then shell/other', () => {
  const panes = parsePaneRows(sampleRows, '%128');
  const groups = groupPanes(panes, '/Users/braydon/projects/experiments');

  assert.deepEqual(groups.map((group) => group.title), ['Current', 'Related', 'Other active agents', 'Shells / other panes']);
  assert.deepEqual(groups[0].panes.map((pane) => pane.target), ['infra:1.1']);
  assert.deepEqual(groups[1].panes.map((pane) => pane.target), ['paia:7.1']);
  assert.deepEqual(groups[2].panes.map((pane) => pane.target), ['syn:6.1']);
  assert.deepEqual(groups[3].panes.map((pane) => pane.target), ['infra:2.1']);
});

test('buildCaptureArgs captures recent output by stable pane id', () => {
  const pane = parsePaneRows(sampleRows, '%128')[1];

  assert.deepEqual(buildCaptureArgs(pane, 80), ['capture-pane', '-t', '%129', '-p', '-e', '-S', '-80']);
});

test('buildJumpSteps switches the current client to session/window and selects stable pane id', () => {
  const pane = parsePaneRows(sampleRows, '%128')[2];

  assert.deepEqual(buildJumpSteps(pane, '/dev/ttys011'), [
    ['switch-client', '-c', '/dev/ttys011', '-t', 'paia:7'],
    ['select-window', '-t', 'paia:7'],
    ['select-pane', '-t', '%125'],
  ]);
});

test('buildSendKeysArgs sends literal message and Enter to stable pane id', () => {
  const pane = parsePaneRows(sampleRows, '%128')[3];

  assert.deepEqual(buildSendKeysArgs(pane, 'please summarize status'), [
    'send-keys',
    '-t',
    '%096',
    'please summarize status',
    'Enter',
  ]);
});

test('formatPaneLabel gives useful identity without preview', () => {
  const panes = parsePaneRows(sampleRows, '%128');

  assert.equal(formatPaneLabel(panes[0]), 'infra:1.1  pi     experiments       pi · experiments  ← you are here');
  assert.equal(formatPaneLabel(panes[2]), 'paia:7.1   codex  paia-program      paia-program | 5h 84% left');
});

test('flattenGroups assigns stable mobile-friendly ordinals across visible panes', () => {
  const panes = parsePaneRows(sampleRows, '%128');
  const groups = groupPanes(panes, '/Users/braydon/projects/experiments');

  assert.deepEqual(
    flattenGroups(groups).map((item) => `${item.number}:${item.pane.target}`),
    ['1:infra:1.1', '2:paia:7.1', '3:syn:6.1', '4:infra:2.1'],
  );
});

test('resolvePaneSelector supports ordinal, pane id, and target labels', () => {
  const panes = parsePaneRows(sampleRows, '%128');
  const groups = groupPanes(panes, '/Users/braydon/projects/experiments');
  const flat = flattenGroups(groups);

  assert.equal(resolvePaneSelector(flat, '2').pane.target, 'paia:7.1');
  assert.equal(resolvePaneSelector(flat, '%096').pane.target, 'syn:6.1');
  assert.equal(resolvePaneSelector(flat, 'infra:2.1').pane.paneId, '%129');
  assert.equal(resolvePaneSelector(flat, 'missing'), undefined);
});

test('formatPaneCompactLabel keeps mobile list readable', () => {
  const panes = parsePaneRows(sampleRows, '%128');

  assert.equal(formatPaneCompactLabel(2, panes[2]), '2. paia:7.1 codex paia-program — paia-program | 5h 84% left');
});

test('parseTmuxCommandArgs supports mobile subcommands', () => {
  assert.deepEqual(parseTmuxCommandArgs(''), { action: 'open' });
  assert.deepEqual(parseTmuxCommandArgs('list'), { action: 'list' });
  assert.deepEqual(parseTmuxCommandArgs('preview 3'), { action: 'preview', selector: '3' });
  assert.deepEqual(parseTmuxCommandArgs('jump %129'), { action: 'jump', selector: '%129' });
  assert.deepEqual(parseTmuxCommandArgs('send infra:2.1 hello there'), {
    action: 'send',
    selector: 'infra:2.1',
    message: 'hello there',
  });
});

test('getOverlayOptions uses full-width centered overlay on narrow terminals', () => {
  assert.deepEqual(getOverlayOptions(80), {
    anchor: 'center',
    width: '100%',
    maxHeight: '95%',
    margin: 0,
  });
  assert.deepEqual(getOverlayOptions(140), {
    anchor: 'right-center',
    width: '58%',
    minWidth: 64,
    maxHeight: '90%',
    margin: 1,
  });
});

test('inferPaneStatus classifies agents, shells, and input prompts', () => {
  const panes = parsePaneRows(sampleRows, '%128');

  assert.equal(inferPaneStatus(panes[0]), 'active');
  assert.equal(inferPaneStatus(panes[1]), 'idle');
  assert.equal(inferPaneStatus(panes[2]), 'active');
  assert.equal(inferPaneStatus(panes[2], 'Password:'), 'needs-input');
  assert.equal(inferPaneStatus({ ...panes[2], title: 'done' }), 'done');
});

test('enrichPaneMetadata attaches parent, role, task, and status display fields', () => {
  const pane = parsePaneRows(sampleRows, '%128')[2];
  const state = {
    panes: {
      '%125': {
        parentPaneId: '%128',
        role: 'reviewer',
        workgraphTaskId: 'WG-123',
        task: 'review auth changes',
      },
    },
  };

  const enriched = enrichPaneMetadata(pane, state, '%128');

  assert.equal(enriched.relation, 'child');
  assert.equal(enriched.role, 'reviewer');
  assert.equal(enriched.workgraphTaskId, 'WG-123');
  assert.equal(enriched.task, 'review auth changes');
  assert.equal(enriched.status, 'active');
  assert.equal(formatPaneCompactLabel(2, enriched), '2. paia:7.1 codex active reviewer WG-123 paia-program — paia-program | 5h 84% left');
});

test('parseTmuxCommandArgs supports link, unlink, wg, and visible spawn commands', () => {
  assert.deepEqual(parseTmuxCommandArgs('link 2 reviewer'), { action: 'link', selector: '2', role: 'reviewer' });
  assert.deepEqual(parseTmuxCommandArgs('unlink %125'), { action: 'unlink', selector: '%125' });
  assert.deepEqual(parseTmuxCommandArgs('wg paia:7.1 WG-123'), { action: 'wg', selector: 'paia:7.1', taskId: 'WG-123' });
  assert.deepEqual(parseTmuxCommandArgs('spawn pi review auth changes'), {
    action: 'spawn',
    kind: 'pi',
    task: 'review auth changes',
  });
  assert.deepEqual(parseTmuxCommandArgs('delegate implement search'), {
    action: 'spawn',
    kind: 'pi',
    task: 'implement search',
  });
});

test('buildSpawnCommand and buildSpawnWindowArgs create explicit visible tmux agent commands', () => {
  assert.equal(shellQuote("it's ok"), "'it'\\''s ok'");
  assert.equal(buildSpawnCommand('pi', 'review auth changes'), "pi --name 'review auth changes' 'review auth changes'");
  assert.equal(buildSpawnCommand('shell', 'scratch'), process.env.SHELL || 'zsh');
  assert.deepEqual(buildSpawnWindowArgs('/repo/path', 'pi', 'review auth changes'), [
    'new-window',
    '-P',
    '-F',
    '#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{pane_pid}',
    '-n',
    'pi: review auth changes',
    '-c',
    '/repo/path',
    "pi --name 'review auth changes' 'review auth changes'",
  ]);
});

test('computeScrollOffset keeps selected row visible in a clipped viewport', () => {
  assert.equal(computeScrollOffset(0, 0, 5), 0);
  assert.equal(computeScrollOffset(4, 0, 5), 0);
  assert.equal(computeScrollOffset(5, 0, 5), 1);
  assert.equal(computeScrollOffset(12, 8, 5), 8);
  assert.equal(computeScrollOffset(7, 8, 5), 7);
  assert.equal(computeScrollOffset(3, 20, 0), 0);
});

test('computeManualScrollOffset clamps preview scrolling to available output', () => {
  assert.equal(computeManualScrollOffset(0, -1, 100, 10), 0);
  assert.equal(computeManualScrollOffset(0, 5, 100, 10), 5);
  assert.equal(computeManualScrollOffset(95, 10, 100, 10), 90);
  assert.equal(computeManualScrollOffset(10, -20, 100, 10), 0);
  assert.equal(computeManualScrollOffset(3, 10, 8, 10), 0);
});

test('formatCaptureError turns preview capture failures into displayable text', () => {
  const pane = parsePaneRows(sampleRows, '%128')[2];

  assert.equal(
    formatCaptureError(pane, 'can\'t find pane: %125'),
    "Preview failed for paia:7.1 (%125)\ncan't find pane: %125",
  );
});
