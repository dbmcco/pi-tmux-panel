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

function mobilePanePriority(pane) {
  if (pane.isCurrent) return 5;
  if (pane.status === 'needs-input' || pane.statusGlyph === '◆') return 10;
  if (pane.status === 'error' || pane.statusGlyph === '!') return 20;
  if (pane.status === 'active' || pane.status === 'recent' || pane.statusGlyph === '●' || pane.statusGlyph === '◐') return 30;
  if (pane.role === 'manager' || pane.sessionName === 'pi-manager' || /tmux manager/i.test(pane.title || '')) return 40;
  if (pane.status === 'cooling' || pane.statusGlyph === '◌') return 60;
  if (pane.status === 'done' || pane.statusGlyph === '✓') return 80;
  return 90;
}

function buildSmartMobileGroups(groups, limit = 12) {
  const seen = new Set();
  const panes = flattenGroups(groups)
    .map((item, index) => ({ pane: item.pane, index }))
    .filter((item) => {
      const key = item.pane.paneId || item.pane.target;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => mobilePanePriority(a.pane) - mobilePanePriority(b.pane) || a.index - b.index)
    .slice(0, Math.max(1, Number(limit || 12)))
    .map((item) => item.pane);
  return panes.length > 0 ? [{ title: 'Smart mobile shortlist', panes }] : [];
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
  const meta = [pane.statusGlyph, pane.status, pane.role, pane.workgraphTaskId].filter(Boolean).join(' ');
  const suffix = pane.isCurrent ? '  ← you are here' : '';
  return `${target}${kind}${repo}${meta ? `${meta} ` : ''}${title}${suffix}`;
}

function paneMetaParts(pane) {
  const parts = [pane.statusGlyph, pane.kind].filter(Boolean);
  if (pane.status) parts.push(pane.status);
  if (pane.role) parts.push(pane.role);
  if (pane.workgraphTaskId) parts.push(pane.workgraphTaskId);
  parts.push(pane.repo);
  return parts.filter(Boolean).join(' ');
}

function paneTarget(pane) {
  if (pane.target) return pane.target;
  if (pane.sessionName && pane.windowIndex !== undefined && pane.paneIndex !== undefined) {
    return `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
  }
  return pane.paneId || '';
}

function formatPaneCompactLabel(number, pane) {
  const title = pane.title || pane.command || '';
  const suffix = pane.isCurrent ? ' ← here' : '';
  return `${number}. ${paneTarget(pane)} ${paneMetaParts(pane)} — ${title}${suffix}`;
}

function paneDescription(pane) {
  return pane.title || pane.task || pane.command || pane.cwd || pane.repo || '';
}

function formatPaneCleanMobileLabel(number, pane) {
  const parts = [`${number}.`, pane.statusGlyph, paneTarget(pane)].filter(Boolean).join(' ');
  const description = paneDescription(pane);
  return description ? `${parts} — ${description}` : parts;
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
  return flatItems.find((item) => item.pane.paneId === normalized || paneTarget(item.pane) === normalized);
}

function parseTmuxCommandArgs(args) {
  const trimmed = String(args || '').trim();
  if (!trimmed) return { action: 'open' };
  const [action, selector, ...rest] = trimmed.split(/\s+/);
  if (action === 'list') return { action: 'list' };
  if (action === 'all') return { action: 'open', scope: 'all' };
  if (action === 'flip') return { action: 'flip' };
  if (action === 'preview' || action === 'jump') return { action, selector };
  if (/^(\d+|%\d+|[^\s:]+:\d+(?:\.\d+)?)$/.test(trimmed)) return { action: 'jump', selector: trimmed };
  if (action === 'send') return { action, selector, message: rest.join(' ') };
  if (action === 'link') return { action: 'link', selector, role: rest.join(' ') || undefined };
  if (action === 'unlink') return { action: 'unlink', selector };
  if (action === 'wg') return { action: 'wg', selector, taskId: rest.join(' ') || undefined };
  if (action === 'spawn') return { action: 'spawn', kind: selector || 'pi', task: rest.join(' ') };
  if (action === 'delegate') return { action: 'spawn', kind: 'pi', task: [selector, ...rest].filter(Boolean).join(' ') };
  return { action: 'open', query: trimmed };
}

const DEFAULT_ACTIVITY_THRESHOLDS = {
  activeMs: 60_000,
  recentMs: 5 * 60_000,
  coolingMs: 20 * 60_000,
};

function statusGlyph(status) {
  return {
    active: '●',
    recent: '◐',
    cooling: '◌',
    idle: '○',
    'needs-input': '◆',
    done: '✓',
    error: '!',
    unknown: '?',
  }[status] || '?';
}

function hashText(text) {
  let hash = 5381;
  const value = String(text || '');
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function statusOverrideFromText(pane, capturedText) {
  const text = `${pane.title || ''}\n${capturedText || ''}`.toLowerCase();
  if (/password:|\b(confirm|allow|deny|continue\?|proceed\?|select one|waiting for input|press enter)\b/.test(text)) return 'needs-input';
  if (/\b(traceback|exception|panic|failed|failure|fatal|error:|command not found)\b/.test(text)) return 'error';
  if (/\b(done|complete|completed|success|succeeded|finished|ready)\b/.test(text)) return 'done';
  return undefined;
}

function inferPaneStatus(pane, capturedText) {
  const override = statusOverrideFromText(pane, capturedText);
  if (override) return override;
  if (pane.kind === 'shell') return 'idle';
  if (['pi', 'codex', 'claude', 'opencode', 'kilocode'].includes(pane.kind)) return 'active';
  return 'unknown';
}

function computePaneActivity(pane, capturedText, previousActivity, now = Date.now(), thresholds = DEFAULT_ACTIVITY_THRESHOLDS) {
  const contentHash = hashText(capturedText || '');
  const isFirstSeen = !previousActivity || !previousActivity.lastHash;
  const changed = !isFirstSeen && previousActivity.lastHash !== contentHash;
  const lastChangedAt = changed ? now : previousActivity?.lastChangedAt ?? now;
  const override = statusOverrideFromText(pane, capturedText);
  let status;

  if (override) {
    status = override;
  } else if (isFirstSeen) {
    status = pane.kind === 'shell' ? 'idle' : 'unknown';
  } else if (changed) {
    status = 'active';
  } else {
    const age = Math.max(0, now - lastChangedAt);
    if (age < thresholds.activeMs) status = 'active';
    else if (age < thresholds.recentMs) status = 'recent';
    else if (age < thresholds.coolingMs) status = 'cooling';
    else status = 'idle';
  }

  return {
    status,
    statusGlyph: statusGlyph(status),
    activity: {
      lastHash: contentHash,
      lastChangedAt,
      lastSeenAt: now,
      lastStatus: status,
    },
  };
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

const MANAGER_SESSION_NAME = 'pi-manager';
const MANAGER_WINDOW_NAME = 'manager';

function buildManagerPrompt() {
  return [
    'You are the central tmux manager for Braydon\'s agent workspace.',
    '',
    'Your job is to monitor all tmux sessions, windows, and panes; identify coding agents, shells, idle panes, panes needing input, failed panes, and stale panes; and give concise mobile-friendly feedback.',
    '',
    'You may help the user switch panes, send messages to panes, spawn helper agents, and recommend cleanup. Require explicit confirmation before destructive actions including kill, interrupt, deletion, cleanup, or sending large prompts.',
    '',
    'Treat tmux as the source of process and workspace truth. Prefer preview-before-control. Use tmux-monitor status --all and tmux CLI inspection when you need current pane state. Keep responses short unless asked for detail.',
  ].join('\n');
}

function buildManagerCommand() {
  return `pi --name 'tmux manager' --system-prompt ${shellQuote(buildManagerPrompt())} ${shellQuote('Open the central tmux manager. Start with a concise status summary and ask how you can help.')}`;
}

function buildManagerSessionArgs(cwd) {
  return [
    'new-session',
    '-d',
    '-s',
    MANAGER_SESSION_NAME,
    '-n',
    MANAGER_WINDOW_NAME,
    '-P',
    '-F',
    LIST_PANES_FORMAT,
    '-c',
    cwd,
    buildManagerCommand(),
  ];
}

function buildManagerWindowArgs(cwd) {
  return [
    'new-window',
    '-t',
    `${MANAGER_SESSION_NAME}:`,
    '-P',
    '-F',
    LIST_PANES_FORMAT,
    '-n',
    MANAGER_WINDOW_NAME,
    '-c',
    cwd,
    buildManagerCommand(),
  ];
}

function resolveManagerPane(panes, state) {
  const managerPaneId = state?.manager?.paneId;
  if (managerPaneId) {
    const byState = panes.find((pane) => pane.paneId === managerPaneId);
    if (byState) return byState;
  }
  return panes.find(
    (pane) => pane.role === 'manager' || pane.sessionName === MANAGER_SESSION_NAME || /tmux manager/i.test(pane.title || ''),
  );
}

function updateJumpHistory(state, fromPaneId, toPaneId, now = Date.now()) {
  if (!fromPaneId || !toPaneId || fromPaneId === toPaneId) return state;
  state.navigation = {
    currentPaneId: toPaneId,
    previousPaneId: fromPaneId,
    updatedAt: now,
  };
  return state;
}

function resolveFlipPane(panes, state, currentPaneId) {
  const previousPaneId = state?.navigation?.previousPaneId;
  const lastPaneId = state?.navigation?.currentPaneId;
  const preferredPaneId = currentPaneId === lastPaneId ? previousPaneId : lastPaneId;
  if (preferredPaneId && preferredPaneId !== currentPaneId) {
    const preferred = panes.find((pane) => pane.paneId === preferredPaneId);
    if (preferred) return preferred;
  }
  const fallbackPaneId = preferredPaneId === previousPaneId ? lastPaneId : previousPaneId;
  return fallbackPaneId && fallbackPaneId !== currentPaneId ? panes.find((pane) => pane.paneId === fallbackPaneId) : undefined;
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

function normalizeRenderLines(lines, targetLineCount) {
  const target = Math.max(0, Number(targetLineCount || 0));
  if (target <= 0) return lines;
  const normalized = lines.slice(0, target);
  while (normalized.length < target) normalized.push('');
  return normalized;
}

function shouldIgnoreInitialPreviewEnter(openedAt, now = Date.now(), guardMs = 650) {
  if (!openedAt) return false;
  return Math.max(0, now - openedAt) < guardMs;
}

module.exports = {
  inferKind,
  repoLabel,
  parsePaneRows,
  groupPanes,
  buildSmartMobileGroups,
  buildCaptureArgs,
  buildJumpSteps,
  buildSendKeysArgs,
  formatPaneLabel,
  formatPaneCompactLabel,
  formatPaneCleanMobileLabel,
  flattenGroups,
  resolvePaneSelector,
  parseTmuxCommandArgs,
  getOverlayOptions,
  inferPaneStatus,
  enrichPaneMetadata,
  computePaneActivity,
  statusGlyph,
  hashText,
  shellQuote,
  buildSpawnCommand,
  buildSpawnWindowArgs,
  buildManagerPrompt,
  buildManagerCommand,
  buildManagerSessionArgs,
  buildManagerWindowArgs,
  resolveManagerPane,
  updateJumpHistory,
  resolveFlipPane,
  MANAGER_SESSION_NAME,
  LIST_PANES_FORMAT,
  computeScrollOffset,
  computeManualScrollOffset,
  formatCaptureError,
  normalizeRenderLines,
  shouldIgnoreInitialPreviewEnter,
};
