// ---------------------------------------------------------------------------
// AgentInspectorPanel — detailed view of a specific agent's messages and tool
// calls, with expandable tool call details, scroll, and agent selector.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { AgentManager, AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import type { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import {
  buildEmptyState,
  buildPanelLine,
  buildSelectablePanelLine,
  type StyledPanelSegment,
  buildStyledPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import {
  type ConfirmState,
  handleConfirmInput,
} from './confirm-state.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  type AgentDisplayRow as DisplayRow,
  type AgentInspectorEntryKind as EntryKind,
  type AgentTimelineEntry as TimelineEntry,
  agentKindStyle,
  agentStatusColor,
  formatAgentDuration as formatMs,
  formatAgentTime as shortTime,
  jsonlToTimeline,
  AGENT_TERMINAL_STATUSES,
  AGENT_STALL_THRESHOLD_MS,
} from './agent-inspector-shared.ts';

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
  stalled:     '#f59e0b',   // amber — stalled-agent warning
  cursorBg:    '#1a2233',   // timeline cursor row background
} as const;

// ---------------------------------------------------------------------------
// AgentInspectorPanel
// ---------------------------------------------------------------------------

// AGENT_TERMINAL_STATUSES and AGENT_STALL_THRESHOLD_MS imported from agent-inspector-shared.ts

export interface AgentInspectorPanelDeps {
  readonly agentManager: Pick<AgentManager, 'list' | 'getStatus' | 'cancel'>;
  readonly agentMessageBus: Pick<AgentMessageBus, 'getMessages'>;
  readonly workingDirectory: string;
  /** Cancel the agent by id. Uses the same orphan-free path as WRFC. Returns true if cancelled. */
  readonly cancelAgent: (agentId: string) => boolean;
  /**
   * Request a compositor repaint. The 500ms refresh timer and other async
   * update paths call this (via markDirty) so live agent output is painted
   * while the main thread is idle — render() is otherwise only invoked on
   * input/turn/resize, which makes a running agent's timeline look frozen.
   * Optional: when omitted the panel still marks dirty and repaints on the
   * next event.
   */
  readonly requestRender?: () => void;
}

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
  private refreshTimerId: ReturnType<typeof setInterval> | null = null;

  // Row cache — cleared on markDirty(), computed once per render cycle
  private _cachedRows: DisplayRow[] | null = null;

  /** Pending cancel confirmation — subject is the agent id to cancel. */
  private confirmCancel: ConfirmState<string> | null = null;

  /** True while this panel is the active view — gates async repaint requests. */
  private _active = false;

  constructor(private readonly deps: AgentInspectorPanelDeps) {
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
    // T17: a bare markDirty() does not repaint — render() only runs on
    // input/turn/resize. While active, ask the compositor for a frame so
    // timer/async refreshes (live streaming output) are not stuck off-screen.
    if (this._active) this.deps.requestRender?.();
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
    this._refreshTimeline().catch((err) => { logger.debug('agent inspector timeline refresh failed', { err }); });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onActivate(): void {
    this._active = true;
    this.needsRender = true;
    this._startRefresh();
  }

  override onDeactivate(): void {
    this._active = false;
    this._stopRefresh();
  }

  override onDestroy(): void {
    this._stopRefresh();
    super.onDestroy();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    // Confirm-cancel flow takes priority — same contract as WRFC panel.
    if (this.confirmCancel) {
      const result = handleConfirmInput(this.confirmCancel, key);
      if (result === 'confirmed') {
        const rec = this.selectedAgentId
          ? this.deps.agentManager.getStatus(this.selectedAgentId)
          : null;
        if (rec && !AGENT_TERMINAL_STATUSES.has(rec.status)) {
          this.deps.cancelAgent(rec.id);
        }
        this.confirmCancel = null;
        this.markDirty();
        return true;
      }
      if (result === 'cancelled') {
        this.confirmCancel = null;
        this.markDirty();
      }
      // absorbed: confirm stays pending
      return true;
    }

    switch (key) {
      case 'up':       this._moveCursor(-1);         return true;
      case 'down':     this._moveCursor(1);           return true;
      case 'pageup':   this._scroll(-10);             return true;
      case 'pagedown': this._scroll(10);              return true;
      case 'return':   this._toggleExpand();          return true;
      case 'tab':      this._nextAgent();             return true;
      case 'c':        this._beginCancelConfirm();    return true;
      default:         return false;
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    if (height <= 0 || width <= 0) return [];

    const manager = this.deps.agentManager;
    const agents = manager.list();
    const rec = this.selectedAgentId
      ? manager.getStatus(this.selectedAgentId)
      : null;
    const selectorLine = this._renderSelector(width, agents);
    const summaryLines = [
      buildPanelLine(width, [
        [' Agents ', DEFAULT_PANEL_PALETTE.label],
        [String(agents.length), DEFAULT_PANEL_PALETTE.value],
        ['   Selected ', DEFAULT_PANEL_PALETTE.label],
        [this.selectedAgentId ? this.selectedAgentId.slice(-8) : 'none', this.selectedAgentId ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim],
      ]),
    ];

    if (!rec) {
      return buildPanelWorkspace(width, height, {
        title: ` Inspector [${agents.length} agent${agents.length !== 1 ? 's' : ''}]`,
        intro: 'Inspect a selected agent timeline, tool activity, expanded details, and live/historical message flow.',
        sections: [
          { title: 'Summary', lines: summaryLines },
          { title: 'Agents', lines: [selectorLine] },
          {
            lines: buildEmptyState(
              width,
              agents.length === 0 ? ' No agents running' : ' No agent selected',
              agents.length === 0
                ? 'Spawn an agent to inspect its live and historical timeline, tool calls, and output.'
                : 'Press Tab to cycle through available agents and open one in the inspector.',
              agents.length === 0
                ? [{ command: '/spawn <task>', summary: 'launch an agent, then Tab here to inspect its timeline' }]
                : [{ command: 'Tab', summary: 'select the first available agent' }],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        footerLines: [
          buildPanelLine(width, [[' Tab', DEFAULT_PANEL_PALETTE.info], [' cycle agents', DEFAULT_PANEL_PALETTE.dim], ['   Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim]]),
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    summaryLines.push(this._renderAgentInfoSummary(width, rec));
    const now = Date.now();
    const isStalled = this._isAgentStalled(rec, now);
    if (isStalled) {
      summaryLines.push(buildPanelLine(width, [['  STALLED', COLOR.stalled], [' — no activity for 5+ minutes', DEFAULT_PANEL_PALETTE.dim]]));
    }
    const allRows = this._getCachedRows();
    if (allRows.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ` Inspector [${agents.length} agent${agents.length !== 1 ? 's' : ''}]`,
        intro: 'Inspect a selected agent timeline, tool activity, expanded details, and live/historical message flow.',
        sections: [
          { title: 'Summary', lines: summaryLines },
          { title: 'Agents', lines: [selectorLine] },
          {
            lines: buildEmptyState(
              width,
              ' No messages yet',
              rec.status === 'running'
                ? 'The selected agent is running but has not emitted visible timeline entries yet — live output streams in as it works.'
                : 'The selected agent has not emitted any visible timeline entries.',
              rec.status === 'running'
                ? [{ command: 'c', summary: 'cancel this running agent if it appears stalled' }]
                : [{ command: 'Tab', summary: 'cycle to another agent with timeline activity' }],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        footerLines: [
          buildPanelLine(width, [[' Tab', DEFAULT_PANEL_PALETTE.info], [' cycle agents', DEFAULT_PANEL_PALETTE.dim], ['   Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim]]),
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, allRows.length - 1));
    const selectedRec = this.selectedAgentId
      ? this.deps.agentManager.getStatus(this.selectedAgentId)
      : null;
    const cancellable = selectedRec && !AGENT_TERMINAL_STATUSES.has(selectedRec.status);
    const summarySection = { title: 'Summary', lines: summaryLines } as const;
    const agentsSection = { title: 'Agents', lines: [selectorLine] } as const;

    // Confirm-cancel overlay section.
    const confirmSection = this.confirmCancel ? {
      title: 'Confirm Cancel',
      lines: [
        buildPanelLine(width, [
          [' Cancel agent "', DEFAULT_PANEL_PALETTE.warn],
          [this.confirmCancel.label, DEFAULT_PANEL_PALETTE.value],
          ['"?', DEFAULT_PANEL_PALETTE.warn],
        ]),
        buildPanelLine(width, [
          [' y', DEFAULT_PANEL_PALETTE.info], ['  confirm', DEFAULT_PANEL_PALETTE.dim],
          ['   Enter', DEFAULT_PANEL_PALETTE.info], ['  confirm', DEFAULT_PANEL_PALETTE.dim],
          ['   n / Esc', DEFAULT_PANEL_PALETTE.info], ['  cancel', DEFAULT_PANEL_PALETTE.dim],
        ]),
      ],
    } : null;

    const cancelHintFg = cancellable ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim;
    const footerLine = buildPanelLine(width, [
      [` L${this.cursorIndex + 1}/${allRows.length}`, DEFAULT_PANEL_PALETTE.dim],
      ['   Tab', DEFAULT_PANEL_PALETTE.info], [' cycle agents', DEFAULT_PANEL_PALETTE.dim],
      ['   Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim],
      ['   Enter', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim],
      ['   c', cancelHintFg], [cancellable ? ' cancel' : ' cancel (n/a)', DEFAULT_PANEL_PALETTE.dim],
    ]);

    const timelineSection = resolveScrollablePanelSection(width, height, {
      intro: 'Inspect a selected agent timeline, tool activity, expanded details, and live/historical message flow.',
      footerLines: [footerLine],
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summarySection, agentsSection],
      section: {
        title: 'Timeline',
        scrollableLines: allRows.map((row, index) => this._renderTimelineRow(width, row, index === this.cursorIndex)),
        selectedIndex: this.cursorIndex,
        scrollOffset: this.scrollOffset,
        minRows: 8,
      },
      afterSections: confirmSection ? [confirmSection] : undefined,
    });
    this.scrollOffset = timelineSection.scrollOffset;

    const sections = [
      summarySection,
      agentsSection,
      timelineSection.section,
      ...(confirmSection ? [confirmSection] : []),
    ];

    return buildPanelWorkspace(width, height, {
      title: ` Inspector [${agents.length} agent${agents.length !== 1 ? 's' : ''}]`,
      intro: 'Inspect a selected agent timeline, tool activity, expanded details, and live/historical message flow.',
      sections,
      footerLines: [footerLine],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  private _renderSelector(
    width: number,
    agents: AgentRecord[],
  ): Line {
    if (agents.length === 0) {
      return buildStyledPanelLine(width, [
        { text: ' (no agents)', fg: COLOR.dimmed, bg: COLOR.statusBar, dim: true },
      ]);
    }
    const segments: StyledPanelSegment[] = [{ text: ' ', fg: COLOR.statusFg, bg: COLOR.statusBar }];
    for (const agent of agents) {
      const isSelected = agent.id === this.selectedAgentId;
      const shortId = agent.id.slice(-8);
      const badge = ` ${shortId} `;
      segments.push({
        text: badge,
        fg: isSelected ? COLOR.selected : COLOR.dimmed,
        bg: COLOR.statusBar,
        bold: isSelected,
      });
      segments.push({ text: '│', fg: COLOR.separator, bg: COLOR.statusBar });
    }
    return buildStyledPanelLine(width, segments);
  }

  private _renderAgentInfoSummary(width: number, rec: AgentRecord): Line {
    const now = Date.now();
    const elapsed = (rec.completedAt ?? now) - rec.startedAt;
    const taskPreview = rec.task.split('\n')[0] ?? '';
    const maxTask = Math.max(0, width - 40);
    const taskDisplay = truncateDisplay(taskPreview, maxTask);
    return buildPanelLine(width, [
      [' Status ', DEFAULT_PANEL_PALETTE.label],
      [rec.status.toUpperCase(), rec.status === 'running' ? DEFAULT_PANEL_PALETTE.good : rec.status === 'failed' ? DEFAULT_PANEL_PALETTE.bad : DEFAULT_PANEL_PALETTE.dim],
      ['   Duration ', DEFAULT_PANEL_PALETTE.label],
      [formatMs(elapsed), DEFAULT_PANEL_PALETTE.value],
      ['   Tools ', DEFAULT_PANEL_PALETTE.label],
      [String(rec.toolCallCount), DEFAULT_PANEL_PALETTE.info],
      // SDK 0.23.0: show addendum indicator when WRFC injected a constraint addendum
      ...(rec.systemPromptAddendum
        ? [['   Addendum ', DEFAULT_PANEL_PALETTE.label] as [string, string], ['yes', DEFAULT_PANEL_PALETTE.info] as [string, string]]
        : []),
      ['   Task ', DEFAULT_PANEL_PALETTE.label],
      [taskDisplay, DEFAULT_PANEL_PALETTE.value],
    ]);
  }

  // -------------------------------------------------------------------------
  // Timeline row rendering
  // -------------------------------------------------------------------------

  private _renderTimelineRow(
    width: number,
    row: DisplayRow,
    isCursor: boolean,
  ): Line {
    const bg = isCursor ? COLOR.cursorBg : '';
    const ts = shortTime(row.timestamp);
    const { fg, prefix } = agentKindStyle(row.kind, COLOR);
    const hint = row.hasDetail ? (row.expanded ? ' ▾' : ' ▸') : '';
    const prefixText = `${isCursor ? '▸' : ' '} ${ts} ${prefix} `;
    const reserved = prefixText.length + hint.length;
    const contentBudget = Math.max(0, width - reserved);
    const text = truncateDisplay(row.content, contentBudget);

    return buildSelectablePanelLine(width, [
      { text: isCursor ? '▸' : ' ', fg: COLOR.selected, bg, bold: isCursor },
      { text: ' ', fg: COLOR.value, bg },
      { text: ts, fg: COLOR.timestamp, bg, dim: true },
      { text: ' ', fg: COLOR.value, bg },
      { text: prefix, fg, bg, bold: true },
      { text: ' ', fg: COLOR.value, bg },
      { text: text, fg: COLOR.value, bg },
      { text: hint.length > 0 ? hint.padStart(Math.max(hint.length, width - (prefixText.length + text.length))) : '', fg: COLOR.expandHint, bg, dim: true },
    ], { selected: isCursor, selectedBg: bg, fillFg: isCursor ? COLOR.selected : '' });
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
    const merged = [...this.timeline, ...busEntries];

    // T13: the JSONL timeline only records coarse per-turn summaries
    // ([assistant] N chars, M tool calls) and never the model's actual text,
    // so a mid-turn agent looks idle here. Surface the selected agent's live
    // streaming output while it runs, and its final output once terminal.
    const liveRec = this.selectedAgentId
      ? this.deps.agentManager.getStatus(this.selectedAgentId)
      : null;
    if (liveRec) {
      const liveEntry = this._buildLiveOutputEntry(liveRec);
      if (liveEntry) merged.push(liveEntry);
    }

    merged.sort((a, b) => a.timestamp - b.timestamp);

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
    const messages = this.deps.agentMessageBus.getMessages(this.selectedAgentId);
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
        content: truncateDisplay(msg.content, 200),
        expanded: false,
      } satisfies TimelineEntry);
    }
    return result;
  }

  /**
   * Build a synthetic timeline entry exposing the selected agent's live model
   * output. While the agent runs this is the streaming token buffer
   * (tail-truncated like AgentDetailModal); once it terminates it is the final
   * assistant text (expandable). Exactly one is produced — the SDK clears
   * streamingContent on completion — so live and final rows never coexist.
   * Returns null when there is nothing to show.
   */
  private _buildLiveOutputEntry(rec: AgentRecord): TimelineEntry | null {
    const STREAM_MAX_CHARS = 500;
    if (rec.status === 'running' && rec.streamingContent) {
      const sc = rec.streamingContent;
      const truncated = sc.length > STREAM_MAX_CHARS;
      const tail = (truncated ? sc.slice(-STREAM_MAX_CHARS) : sc)
        .replace(/\s+/g, ' ')
        .trim();
      return {
        kind: 'assistant',
        timestamp: Date.now(),
        label: 'streaming',
        content: `(live) ${truncated ? '…' : ''}${tail}`,
        expanded: false,
      } satisfies TimelineEntry;
    }
    if (AGENT_TERMINAL_STATUSES.has(rec.status) && rec.fullOutput) {
      const fo = rec.fullOutput;
      const firstLine = (fo.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
      return {
        kind: 'assistant',
        timestamp: rec.completedAt ?? Date.now(),
        label: 'output',
        content: `(final) ${firstLine}`,
        detail: fo,
        expanded: false,
      } satisfies TimelineEntry;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Private — refresh
  // -------------------------------------------------------------------------

  private async _refreshTimeline(): Promise<void> {
    if (!this.selectedAgentId) return;
    try {
      const sessionFile = join(
        this.deps.workingDirectory,
        '.goodvibes', 'tui', 'sessions',
        `${this.selectedAgentId}.jsonl`,
      );
      const raw = await readFile(sessionFile, 'utf-8');
      const logLines = raw.trim().split('\n').filter(Boolean);
      const rows = logLines
        .slice(-MAX_JSONL_ENTRIES)
        .map((line) => {
          try { return JSON.parse(line) as Record<string, unknown>; }
          catch { return null; }
        })
        .filter((r): r is Record<string, unknown> => r !== null);
      this.timeline = jsonlToTimeline(rows);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.debug('AgentInspectorPanel: failed to load session log', { error: summarizeError(err) });
      }
      this.timeline = [];
    }
    this.markDirty();
  }

  private _startRefresh(): void {
    if (this.refreshTimerId) return;
    this.refreshTimerId = this.registerTimer(setInterval(() => {
      this._refreshTimeline().catch((err) => { logger.debug('agent inspector timeline refresh tick failed', { err }); });
    }, REFRESH_MS));
  }

  private _stopRefresh(): void {
    if (this.refreshTimerId) {
      this.clearTimer(this.refreshTimerId);
      this.refreshTimerId = null;
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
    const agents = this.deps.agentManager.list();
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

  // -------------------------------------------------------------------------
  // Private — cancel + stall
  // -------------------------------------------------------------------------

  /** Initiate cancel-confirm flow for the selected agent (noop if terminal or none selected). */
  private _beginCancelConfirm(): void {
    if (!this.selectedAgentId) return;
    const rec = this.deps.agentManager.getStatus(this.selectedAgentId);
    if (!rec || AGENT_TERMINAL_STATUSES.has(rec.status)) return;
    const firstLine = rec.task.split('\n')[0];
    const label = firstLine ? truncateDisplay(firstLine, 40) : rec.id.slice(-8);
    this.confirmCancel = { subject: rec.id, label };
    this.markDirty();
  }

  /** Returns whether an agent is considered stalled (non-terminal, running past threshold). */
  private _isAgentStalled(rec: AgentRecord, now: number): boolean {
    if (AGENT_TERMINAL_STATUSES.has(rec.status)) return false;
    return (now - rec.startedAt) >= AGENT_STALL_THRESHOLD_MS;
  }

  /**
   * Count of all tracked agents that are stalled (non-terminal, no activity
   * for AGENT_STALL_THRESHOLD_MS). Exposed so callers can aggregate a
   * stalledAgentCount for cockpit / roster read-models.
   */
  getStalledAgentCount(): number {
    const now = Date.now();
    return this.deps.agentManager.list().filter(rec => this._isAgentStalled(rec, now)).length;
  }
}
