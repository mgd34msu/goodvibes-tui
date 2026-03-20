// ---------------------------------------------------------------------------
// AgentInspectorPanel — detailed view of a specific agent's messages and tool
// calls, with expandable tool call details, scroll, and agent selector.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { AgentManager } from '../tools/agent/index.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import { AgentMessageBus } from '../agents/message-bus.ts';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Constants & colour palette
// ---------------------------------------------------------------------------

const REFRESH_MS = 500;
const MAX_JSONL_ENTRIES = 200;

const COLOR = {
  // Header / chrome
  headerBg:    '#1a1a2e',
  headerFg:    '#ffffff',
  statusBar:   '#222233',
  statusFg:    '#aaaaaa',
  separator:   '#333355',

  // Timeline roles
  user:        '#cc88ff',   // purple
  assistant:   '#ffffff',   // white
  tool:        '#00ccff',   // cyan
  toolResult:  '#66ddff',   // light cyan
  error:       '#ff6666',   // red
  system:      '#888888',   // dim grey
  timestamp:   '#555577',

  // Status badges
  pending:     '#ffcc44',
  running:     '#44ffcc',
  completed:   '#44ff88',
  failed:      '#ff4444',
  cancelled:   '#888888',

  // Selector / labels
  label:       '#8888bb',
  value:       '#ccccdd',
  selected:    '#ffee88',
  dimmed:      '#555566',
  expandHint:  '#445566',
} as const;

// ---------------------------------------------------------------------------
// Timeline entry types
// ---------------------------------------------------------------------------

type EntryKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'session' | 'error';

interface TimelineEntry {
  kind: EntryKind;
  timestamp: number;    // Unix ms
  label: string;        // role / tool name
  content: string;      // primary display text
  detail?: string;      // args / result — shown when expanded
  expanded: boolean;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderText(
  width: number,
  text: string,
  fg: string,
  bg: string,
  bold = false,
  dim = false,
): Line {
  const cells: Line = [];
  const truncated = text.length > width ? text.slice(0, width) : text;
  for (const ch of truncated) {
    cells.push(createStyledCell(ch, { fg, bg, bold, dim }));
  }
  while (cells.length < width) {
    cells.push(createStyledCell(' ', { fg: '', bg }));
  }
  return cells.slice(0, width);
}

function statusColor(status: string): string {
  switch (status) {
    case 'pending':   return COLOR.pending;
    case 'running':   return COLOR.running;
    case 'completed': return COLOR.completed;
    case 'failed':    return COLOR.failed;
    case 'cancelled': return COLOR.cancelled;
    default:          return COLOR.system;
  }
}

function formatMs(ms: number): string {
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function shortTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ---------------------------------------------------------------------------
// JSONL parsing — agent session log
// ---------------------------------------------------------------------------

type JsonlRow = Record<string, unknown>;

function jsonlToTimeline(rows: JsonlRow[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const row of rows) {
    const type = String(row.type ?? 'unknown');
    const rawTs = row.timestamp;
    const ts = typeof rawTs === 'string'
      ? Date.parse(rawTs)
      : typeof rawTs === 'number'
        ? rawTs
        : Date.now();

    switch (type) {
      case 'tool_execution': {
        const toolName = String(row.toolName ?? 'tool');
        const argsStr = row.args !== undefined
          ? JSON.stringify(row.args, null, 2)
          : undefined;
        const resultStr = row.result !== undefined
          ? JSON.stringify(row.result, null, 2)
          : undefined;
        const detail = [argsStr ? `Args:\n${argsStr}` : '', resultStr ? `Result:\n${resultStr}` : '']
          .filter(Boolean).join('\n\n');
        entries.push({
          kind: 'tool_call',
          timestamp: ts,
          label: toolName,
          content: `[tool] ${toolName}` + (row.durationMs !== undefined ? ` (${row.durationMs}ms)` : ''),
          detail: detail || undefined,
          expanded: false,
        });
        break;
      }

      case 'llm_response': {
        const toolCount = Number(row.toolCallCount ?? 0);
        const charLen = Number(row.contentLength ?? 0);
        entries.push({
          kind: 'assistant',
          timestamp: ts,
          label: 'assistant',
          content: `[assistant] ${charLen} chars, ${toolCount} tool calls`,
          expanded: false,
        });
        break;
      }

      case 'session_start': {
        entries.push({
          kind: 'session',
          timestamp: ts,
          label: 'session',
          content: `[session start] ${String(row.agentId ?? '')}`,
          expanded: false,
        });
        break;
      }

      case 'session_end': {
        entries.push({
          kind: 'session',
          timestamp: ts,
          label: 'session',
          content: `[session end] ${String(row.status ?? 'unknown')}`,
          expanded: false,
        });
        break;
      }

      case 'error': {
        entries.push({
          kind: 'error',
          timestamp: ts,
          label: 'error',
          content: `[error] ${String(row.message ?? row.error ?? 'unknown error')}`,
          expanded: false,
        });
        break;
      }

      default: {
        // Unknown JSONL row type — render as a dim session line
        entries.push({
          kind: 'session',
          timestamp: ts,
          label: type,
          content: `[${type}]`,
          expanded: false,
        });
        break;
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// AgentInspectorPanel
// ---------------------------------------------------------------------------

export class AgentInspectorPanel extends BasePanel {
  // The agent currently being inspected
  private selectedAgentId: string | null = null;

  // Flattened timeline for the selected agent
  private timeline: TimelineEntry[] = [];

  // Scroll state
  private scrollOffset = 0;

  // Cursor index for expand/collapse
  private cursorIndex = 0;

  // Refresh timer (active only while panel is active)
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Row cache — cleared on markDirty(), computed once per render cycle
  private _cachedRows: DisplayRow[] | null = null;

  constructor() {
    super('inspector', 'Inspector', 'I', 'agent');
  }

  // -------------------------------------------------------------------------
  // Row cache
  // -------------------------------------------------------------------------

  private _getCachedRows(): DisplayRow[] {
    if (!this._cachedRows) this._cachedRows = this._buildVisibleRows();
    return this._cachedRows;
  }

  override markDirty(): void {
    this._cachedRows = null;
    super.markDirty();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Focus this panel on a specific agent by ID. */
  inspectAgent(agentId: string): void {
    this.selectedAgentId = agentId;
    this.scrollOffset = 0;
    this.cursorIndex = 0;
    this.timeline = [];
    this.markDirty();
    this._refreshTimeline().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onActivate(): void {
    this.needsRender = true;
    this._startRefresh();
  }

  override onDeactivate(): void {
    this._stopRefresh();
  }

  override onDestroy(): void {
    this._stopRefresh();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    switch (key) {
      case 'up':       this._moveCursor(-1); return true;
      case 'down':     this._moveCursor(1);  return true;
      case 'pageup':   this._scroll(-10);    return true;
      case 'pagedown': this._scroll(10);     return true;
      case 'return':   this._toggleExpand(); return true;
      case 'tab':      this._nextAgent();    return true;
      default:         return false;
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    if (height <= 0 || width <= 0) return lines;

    const manager = AgentManager.getInstance();
    const agents = manager.list();

    // ── Header bar ──────────────────────────────────────────────────────────
    lines.push(this._renderHeader(width, agents.length));

    if (height <= 1) return lines.slice(0, height);

    // ── Agent selector bar ──────────────────────────────────────────────────
    lines.push(this._renderSelector(width, agents));

    if (height <= 2) return lines.slice(0, height);

    // ── No agent selected / no agents ───────────────────────────────────────
    const rec = this.selectedAgentId
      ? manager.getStatus(this.selectedAgentId)
      : null;

    if (!rec) {
      const msg = agents.length === 0
        ? ' No agents running. Spawn an agent to inspect.'
        : ' No agent selected. Press Tab to cycle agents.';
      lines.push(renderText(width, msg, COLOR.dimmed, '', false, true));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    // ── Agent info bar ──────────────────────────────────────────────────────
    lines.push(this._renderAgentInfo(width, rec));

    if (height <= 3) return lines.slice(0, height);

    // ── Timeline ────────────────────────────────────────────────────────────
    const timelineHeight = height - 4; // header + selector + info + status bar
    const contentLines = this._renderTimeline(width, timelineHeight);
    for (const l of contentLines) lines.push(l);
    while (lines.length < height - 1) lines.push(createEmptyLine(width));

    // ── Status bar ──────────────────────────────────────────────────────────
    lines.push(this._renderStatusBar(width));

    return lines.slice(0, height);
  }

  // -------------------------------------------------------------------------
  // Private — rendering
  // -------------------------------------------------------------------------

  private _renderHeader(width: number, agentCount: number): Line {
    const title = ` Inspector [${agentCount} agent${agentCount !== 1 ? 's' : ''}]`;
    return renderText(width, title, COLOR.headerFg, COLOR.headerBg, true);
  }

  private _renderSelector(
    width: number,
    agents: AgentRecord[],
  ): Line {
    if (agents.length === 0) {
      return renderText(width, ' (no agents)', COLOR.dimmed, COLOR.statusBar, false, true);
    }

    const cells: Line = [];
    const prefix = ' ';
    for (const ch of prefix) {
      cells.push(createStyledCell(ch, { fg: COLOR.statusFg, bg: COLOR.statusBar }));
    }

    for (const agent of agents) {
      const isSelected = agent.id === this.selectedAgentId;
      const shortId = agent.id.slice(-8);
      const badge = ` ${shortId} `;
      const fg = isSelected ? COLOR.selected : COLOR.dimmed;
      const bold = isSelected;

      for (const ch of badge) {
        if (cells.length >= width - 1) break;
        cells.push(createStyledCell(ch, { fg, bg: COLOR.statusBar, bold }));
      }

      if (cells.length < width - 1) {
        cells.push(createStyledCell('|', { fg: COLOR.separator, bg: COLOR.statusBar }));
      }
    }

    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '', bg: COLOR.statusBar }));
    }

    return cells.slice(0, width);
  }

  private _renderAgentInfo(
    width: number,
    rec: AgentRecord,
  ): Line {
    const now = Date.now();
    const elapsed = (rec.completedAt ?? now) - rec.startedAt;
    const statusFg = statusColor(rec.status);
    const taskPreview = rec.task.split('\n')[0] ?? '';
    const maxTask = Math.max(0, width - 40);
    const taskDisplay = taskPreview.length > maxTask
      ? taskPreview.slice(0, maxTask - 1) + '\u2026'
      : taskPreview;

    const cells: Line = [];

    // Status badge
    const badge = ` ${rec.status.toUpperCase()} `;
    for (const ch of badge) {
      cells.push(createStyledCell(ch, { fg: statusFg, bg: COLOR.headerBg, bold: true }));
    }

    // Separator
    cells.push(createStyledCell(' ', { fg: '', bg: COLOR.headerBg }));

    // Duration
    const dur = `${formatMs(elapsed)} `;
    for (const ch of dur) {
      cells.push(createStyledCell(ch, { fg: COLOR.label, bg: COLOR.headerBg }));
    }

    // Tool count
    const tools = `T:${rec.toolCallCount} `;
    for (const ch of tools) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg: COLOR.tool, bg: COLOR.headerBg }));
    }

    // Task preview
    for (const ch of taskDisplay) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg: COLOR.value, bg: COLOR.headerBg }));
    }

    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '', bg: COLOR.headerBg }));
    }

    return cells.slice(0, width);
  }

  private _renderTimeline(width: number, height: number): Line[] {
    const lines: Line[] = [];
    if (height <= 0) return lines;

    // Merge bus messages into a flat view
    const allEntries = this._getCachedRows();

    if (allEntries.length === 0) {
      lines.push(renderText(width, ' No messages yet.', COLOR.dimmed, '', false, true));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    // Clamp cursor
    const maxCursor = allEntries.length - 1;
    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, maxCursor));

    // Auto-scroll to keep cursor visible
    if (this.cursorIndex < this.scrollOffset) {
      this.scrollOffset = this.cursorIndex;
    }
    if (this.cursorIndex >= this.scrollOffset + height) {
      this.scrollOffset = this.cursorIndex - height + 1;
    }

    const visibleRows = allEntries.slice(this.scrollOffset, this.scrollOffset + height);

    for (let i = 0; i < visibleRows.length && lines.length < height; i++) {
      const row = visibleRows[i]!;
      const absIdx = this.scrollOffset + i;
      const isCursor = absIdx === this.cursorIndex;
      lines.push(this._renderTimelineRow(width, row, isCursor));
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines;
  }

  private _renderStatusBar(width: number): Line {
    const total = this._getCachedRows().length;
    const hint = '  Tab: cycle agents  ↑↓: scroll  Enter: expand/collapse';
    const pos = ` L${this.cursorIndex + 1}/${total}`;
    const text = pos + hint;
    return renderText(width, text, COLOR.statusFg, COLOR.statusBar);
  }

  // -------------------------------------------------------------------------
  // Timeline row rendering
  // -------------------------------------------------------------------------

  private _renderTimelineRow(
    width: number,
    row: DisplayRow,
    isCursor: boolean,
  ): Line {
    const cells: Line = [];
    const bg = isCursor ? '#1a2233' : '';

    // Cursor indicator
    cells.push(createStyledCell(isCursor ? '>' : ' ', { fg: COLOR.selected, bg, bold: isCursor }));

    // Timestamp (8 chars)
    const ts = shortTime(row.timestamp);
    for (const ch of ts) {
      cells.push(createStyledCell(ch, { fg: COLOR.timestamp, bg, dim: true }));
    }
    cells.push(createStyledCell(' ', { fg: '', bg }));

    // Role / kind prefix
    const { fg, prefix } = kindStyle(row.kind);
    for (const ch of prefix) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg, bg, bold: true }));
    }
    cells.push(createStyledCell(' ', { fg: '', bg }));

    // Content text
    const usedWidth = cells.length;
    const remaining = Math.max(0, width - usedWidth);
    const text = row.content.length > remaining
      ? row.content.slice(0, remaining - 1) + '\u2026'
      : row.content;

    for (const ch of text) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg: COLOR.value, bg }));
    }

    // Expand indicator (if has detail)
    if (row.hasDetail && cells.length < width - 1) {
      const hint = row.expanded ? ' [-]' : ' [+]';
      const hintStart = Math.max(cells.length, width - hint.length);
      // Pad to hint start
      while (cells.length < hintStart) {
        cells.push(createStyledCell(' ', { fg: '', bg }));
      }
      for (const ch of hint) {
        if (cells.length >= width) break;
        cells.push(createStyledCell(ch, { fg: COLOR.expandHint, bg, dim: true }));
      }
    }

    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '', bg }));
    }
    return cells.slice(0, width);
  }

  // -------------------------------------------------------------------------
  // Private — data
  // -------------------------------------------------------------------------

  /**
   * Build the flat list of DisplayRow items from timeline + expanded detail
   * sub-rows. This is what the renderer walks.
   */
  private _buildVisibleRows(): DisplayRow[] {
    const rows: DisplayRow[] = [];

    // Merge bus messages (live) + JSONL (historical), sorted by timestamp
    const busEntries = this._busToTimeline();
    const merged = [...this.timeline, ...busEntries]
      .sort((a, b) => a.timestamp - b.timestamp);

    // Deduplicate: bus messages that already appear in JSONL will have
    // approximate timestamps. We just show all — bus msgs tend to have
    // unique content.
    for (const entry of merged) {
      rows.push({
        kind: entry.kind,
        timestamp: entry.timestamp,
        content: entry.content,
        hasDetail: !!entry.detail,
        expanded: entry.expanded,
        entryRef: entry,
      });

      // If expanded and has detail — insert sub-rows
      if (entry.expanded && entry.detail) {
        const detailLines = entry.detail.split('\n');
        for (const dl of detailLines) {
          rows.push({
            kind: 'tool_result',
            timestamp: entry.timestamp,
            content: dl,
            hasDetail: false,
            expanded: false,
            entryRef: null,
          });
        }
      }
    }

    return rows;
  }

  private _busToTimeline(): TimelineEntry[] {
    if (!this.selectedAgentId) return [];
    const messages = AgentMessageBus.getInstance().getMessages(this.selectedAgentId);
    const DEDUP_WINDOW_MS = 2000;
    const seen = new Map<string, number>(); // hash -> last timestamp
    const result: TimelineEntry[] = [];
    for (const msg of messages) {
      const isFromUser = msg.from === 'orchestrator' || msg.from === 'system';
      const kind: EntryKind = isFromUser ? 'user' : 'assistant';
      const contentSnippet = msg.content.slice(0, 50);
      const dedupKey = `${kind}:${contentSnippet}`;
      const lastSeen = seen.get(dedupKey);
      if (lastSeen !== undefined && msg.timestamp - lastSeen < DEDUP_WINDOW_MS) {
        continue;
      }
      seen.set(dedupKey, msg.timestamp);
      result.push({
        kind,
        timestamp: msg.timestamp,
        label: msg.from,
        content: msg.content.length > 200
          ? msg.content.slice(0, 197) + '\u2026'
          : msg.content,
        expanded: false,
      } satisfies TimelineEntry);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Private — refresh
  // -------------------------------------------------------------------------

  private async _refreshTimeline(): Promise<void> {
    if (!this.selectedAgentId) return;
    try {
      const sessionFile = join(
        process.cwd(),
        '.goodvibes', 'tui', 'sessions',
        `agent-${this.selectedAgentId}.jsonl`,
      );
      const raw = await readFile(sessionFile, 'utf-8');
      const logLines = raw.trim().split('\n').filter(Boolean);
      const rows = logLines
        .slice(-MAX_JSONL_ENTRIES)
        .map((line) => {
          try { return JSON.parse(line) as JsonlRow; }
          catch { return null; }
        })
        .filter((r): r is JsonlRow => r !== null);
      this.timeline = jsonlToTimeline(rows);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.debug('AgentInspectorPanel: failed to load session log', { error: String(err) });
      }
      this.timeline = [];
    }
    this.markDirty();
  }

  private _startRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      this._refreshTimeline().catch(() => {});
    }, REFRESH_MS);
  }

  private _stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private — navigation
  // -------------------------------------------------------------------------

  private _moveCursor(delta: number): void {
    const rows = this._getCachedRows();
    if (rows.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(rows.length - 1, this.cursorIndex + delta));
    this.markDirty();
  }

  private _scroll(delta: number): void {
    this._moveCursor(delta);
  }

  private _toggleExpand(): void {
    const rows = this._getCachedRows();
    const row = rows[this.cursorIndex];
    if (!row?.entryRef || !row.hasDetail) return;
    row.entryRef.expanded = !row.entryRef.expanded;
    this.markDirty();
  }

  private _nextAgent(): void {
    const agents = AgentManager.getInstance().list();
    if (agents.length === 0) return;

    if (!this.selectedAgentId) {
      this.inspectAgent(agents[0]!.id);
      return;
    }

    const idx = agents.findIndex(a => a.id === this.selectedAgentId);
    const next = agents[(idx + 1) % agents.length];
    if (next) {
      this.inspectAgent(next.id);
    }
  }
}

// ---------------------------------------------------------------------------
// DisplayRow — flattened row for the renderer (timeline + detail sub-rows)
// ---------------------------------------------------------------------------

interface DisplayRow {
  kind: EntryKind;
  timestamp: number;
  content: string;
  hasDetail: boolean;
  expanded: boolean;
  /** Pointer back to the TimelineEntry so expand/collapse can mutate it. */
  entryRef: TimelineEntry | null;
}

// ---------------------------------------------------------------------------
// Kind style map
// ---------------------------------------------------------------------------

function kindStyle(kind: EntryKind): { fg: string; prefix: string } {
  switch (kind) {
    case 'user':        return { fg: COLOR.user,       prefix: '[user]     ' };
    case 'assistant':   return { fg: COLOR.assistant,  prefix: '[assistant]' };
    case 'tool_call':   return { fg: COLOR.tool,       prefix: '[tool]     ' };
    case 'tool_result': return { fg: COLOR.toolResult, prefix: '  \u2514     ' };
    case 'session':     return { fg: COLOR.system,     prefix: '[session]  ' };
    case 'error':       return { fg: COLOR.error,      prefix: '[error]    ' };
    default:            return { fg: COLOR.dimmed,     prefix: '[?]        ' };
  }
}
