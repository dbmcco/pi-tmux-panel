function inferKind(command, title) {
  const cmd = (command || '').toLowerCase();
  const paneTitle = (title || '').toLowerCase();

  if (cmd.includes('codex')) return 'codex';
  if (cmd.includes('claude')) return 'claude';
  if (cmd.includes('opencode')) return 'opencode';
  if (cmd.includes('kilocode')) return 'kilocode';
  if (cmd === 'node' && paneTitle.includes('pi')) return 'pi';
  if (paneTitle.includes('pi ·') || paneTitle.startsWith('π')) return 'pi';
  if (['zsh', 'bash', 'fish', 'sh', 'nu'].includes(cmd)) return 'shell';
  if (/^\d+\.\d+\.\d+/.test(cmd)) return 'claude';
  return cmd || 'unknown';
}

function repoLabel(cwd) {
  if (!cwd) return '?';
  const normalized = cwd.replace(/\/+$/, '');
  const home = process.env.HOME || '/Users/braydon';
  if (normalized === home) return '~';
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function parsePaneRows(output, currentPaneId) {
  return String(output || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [target, paneId, sessionName, windowIndex, paneIndex, command, cwd, title, panePid] = line.split('\t');
      const pane = {
        target,
        paneId,
        sessionName,
        windowIndex,
        paneIndex,
        command,
        cwd,
        title,
        panePid,
        kind: inferKind(command, title),
        repo: repoLabel(cwd),
        isCurrent: paneId === currentPaneId,
      };
      return pane;
    });
}

function isRelatedPane(pane, currentCwd) {
  if (!currentCwd || !pane.cwd || pane.isCurrent) return false;
  const current = currentCwd.replace(/\/+$/, '');
  const cwd = pane.cwd.replace(/\/+$/, '');
  return cwd === current || cwd.startsWith(`${current}/`);
}

function groupPanes(panes, currentCwd) {
  const groups = [
    { title: 'Current', panes: panes.filter((pane) => pane.isCurrent) },
    { title: 'Related', panes: panes.filter((pane) => isRelatedPane(pane, currentCwd)) },
    {
      title: 'Other active agents',
      panes: panes.filter((pane) => !pane.isCurrent && !isRelatedPane(pane, currentCwd) && pane.kind !== 'shell'),
    },
    {
      title: 'Shells / other panes',
      panes: panes.filter((pane) => !pane.isCurrent && !isRelatedPane(pane, currentCwd) && pane.kind === 'shell'),
    },
  ];
  return groups.filter((group) => group.panes.length > 0);
}

function buildCaptureArgs(pane, lines = 80) {
  return ['capture-pane', '-t', pane.paneId, '-p', '-e', '-S', `-${lines}`];
}

function buildJumpSteps(pane, clientName) {
  const windowTarget = `${pane.sessionName}:${pane.windowIndex}`;
  const switchArgs = ['switch-client'];
  if (clientName) switchArgs.push('-c', clientName);
  switchArgs.push('-t', windowTarget);
  return [switchArgs, ['select-window', '-t', windowTarget], ['select-pane', '-t', pane.paneId]];
}

function buildSendKeysArgs(pane, message) {
  return ['send-keys', '-t', pane.paneId, message, 'Enter'];
}

function formatPaneLabel(pane) {
  const target = (pane.target || '?').padEnd(11);
  const kind = (pane.kind || '?').padEnd(7);
  const repo = (pane.repo || '?').padEnd(18);
  const title = pane.title || pane.command || '';
  const meta = [pane.status, pane.role, pane.workgraphTaskId].filter(Boolean).join(' ');
  const suffix = pane.isCurrent ? '  ← you are here' : '';
  return `${target}${kind}${repo}${meta ? `${meta} ` : ''}${title}${suffix}`;
}

function paneMetaParts(pane) {
  const parts = [pane.kind];
  if (pane.status) parts.push(pane.status);
  if (pane.role) parts.push(pane.role);
  if (pane.workgraphTaskId) parts.push(pane.workgraphTaskId);
  parts.push(pane.repo);
  return parts.filter(Boolean).join(' ');
}

function formatPaneCompactLabel(number, pane) {
  const title = pane.title || pane.command || '';
  const suffix = pane.isCurrent ? ' ← here' : '';
  return `${number}. ${pane.target} ${paneMetaParts(pane)} — ${title}${suffix}`;
}

function flattenGroups(groups) {
  const items = [];
  for (const group of groups) {
    for (const pane of group.panes) {
      items.push({ number: items.length + 1, groupTitle: group.title, pane });
    }
  }
  return items;
}

function resolvePaneSelector(flatItems, selector) {
  const normalized = String(selector || '').trim();
  if (!normalized) return undefined;
  const number = Number(normalized);
  if (Number.isInteger(number) && number > 0) return flatItems.find((item) => item.number === number);
  return flatItems.find((item) => item.pane.paneId === normalized || item.pane.target === normalized);
}

function parseTmuxCommandArgs(args) {
  const trimmed = String(args || '').trim();
  if (!trimmed) return { action: 'open' };
  const [action, selector, ...rest] = trimmed.split(/\s+/);
  if (action === 'list') return { action: 'list' };
  if (action === 'preview' || action === 'jump') return { action, selector };
  if (action === 'send') return { action, selector, message: rest.join(' ') };
  if (action === 'link') return { action: 'link', selector, role: rest.join(' ') || undefined };
  if (action === 'unlink') return { action: 'unlink', selector };
  if (action === 'wg') return { action: 'wg', selector, taskId: rest.join(' ') || undefined };
  if (action === 'spawn') return { action: 'spawn', kind: selector || 'pi', task: rest.join(' ') };
  if (action === 'delegate') return { action: 'spawn', kind: 'pi', task: [selector, ...rest].filter(Boolean).join(' ') };
  return { action: 'open', query: trimmed };
}

function inferPaneStatus(pane, capturedText) {
  const text = `${pane.title || ''}\n${capturedText || ''}`.toLowerCase();
  if (/password:|\b(confirm|allow|deny|continue\?|proceed\?|select one|waiting for input)\b/.test(text)) return 'needs-input';
  if (/\b(done|complete|completed|success|finished)\b/.test(text)) return 'done';
  if (pane.kind === 'shell') return 'idle';
  if (['pi', 'codex', 'claude', 'opencode', 'kilocode'].includes(pane.kind)) return 'active';
  return 'unknown';
}

function enrichPaneMetadata(pane, state, currentPaneId, capturedText) {
  const meta = state?.panes?.[pane.paneId] || {};
  const relation = meta.parentPaneId === currentPaneId ? 'child' : meta.parentPaneId ? 'linked' : undefined;
  return {
    ...pane,
    status: inferPaneStatus(pane, capturedText),
    relation,
    parentPaneId: meta.parentPaneId,
    role: meta.role,
    workgraphTaskId: meta.workgraphTaskId,
    task: meta.task,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function truncateWindowName(value) {
  return String(value || 'agent')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48) || 'agent';
}

function buildSpawnCommand(kind, task) {
  if (kind === 'shell') return process.env.SHELL || 'zsh';
  const name = truncateWindowName(task || 'tmux agent');
  return `pi --name ${shellQuote(name)} ${shellQuote(task || name)}`;
}

const LIST_PANES_FORMAT = [
  '#{session_name}:#{window_index}.#{pane_index}',
  '#{pane_id}',
  '#{session_name}',
  '#{window_index}',
  '#{pane_index}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{pane_title}',
  '#{pane_pid}',
].join('\t');

function buildSpawnWindowArgs(cwd, kind, task) {
  const namePrefix = kind === 'shell' ? 'shell' : 'pi';
  return [
    'new-window',
    '-P',
    '-F',
    LIST_PANES_FORMAT,
    '-n',
    `${namePrefix}: ${truncateWindowName(task || 'agent')}`,
    '-c',
    cwd,
    buildSpawnCommand(kind, task),
  ];
}

function getOverlayOptions(columns) {
  const width = Number(columns || 0);
  if (width > 0 && width < 100) {
    return { anchor: 'center', width: '100%', maxHeight: '95%', margin: 0 };
  }
  return { anchor: 'right-center', width: '58%', minWidth: 64, maxHeight: '90%', margin: 1 };
}

function computeScrollOffset(selectedRowIndex, currentOffset, viewportSize) {
  const viewport = Math.max(0, Number(viewportSize || 0));
  if (viewport <= 0) return 0;
  const selected = Math.max(0, Number(selectedRowIndex || 0));
  const offset = Math.max(0, Number(currentOffset || 0));
  if (selected < offset) return selected;
  if (selected >= offset + viewport) return selected - viewport + 1;
  return offset;
}

function computeManualScrollOffset(currentOffset, delta, totalRows, viewportSize) {
  const total = Math.max(0, Number(totalRows || 0));
  const viewport = Math.max(0, Number(viewportSize || 0));
  if (viewport <= 0 || total <= viewport) return 0;
  const maxOffset = Math.max(0, total - viewport);
  const next = Math.max(0, Number(currentOffset || 0) + Number(delta || 0));
  return Math.min(maxOffset, next);
}

function formatCaptureError(pane, errorMessage) {
  const message = errorMessage instanceof Error ? errorMessage.message : String(errorMessage || 'Unknown capture error');
  return `Preview failed for ${pane.target} (${pane.paneId})\n${message}`;
}

module.exports = {
  inferKind,
  repoLabel,
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
  shellQuote,
  buildSpawnCommand,
  buildSpawnWindowArgs,
  LIST_PANES_FORMAT,
  computeScrollOffset,
  computeManualScrollOffset,
  formatCaptureError,
};
