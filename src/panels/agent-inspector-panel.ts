// ---------------------------------------------------------------------------
// AgentInspectorPanel — detailed view of a specific agent's messages and tool
// calls, with expandable tool call details, scroll, and agent selector.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { AgentManager, AgentRecord } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import type { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents/message-bus';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
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
import { truncateDisplay } from '../utils/terminal-width.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import {
  type AgentDisplayRow as DisplayRow,
  type AgentInspectorEntryKind as EntryKind,
  type AgentTimelineEntry as TimelineEntry,
  agentKindStyle,
  agentStatusColor,
  formatAgentDuration as formatMs,
  formatAgentTime as shortTime,
  jsonlToTimeline,
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
} as const;

// ---------------------------------------------------------------------------
// AgentInspectorPanel
// ---------------------------------------------------------------------------

export interface AgentInspectorPanelDeps {
  readonly agentManager: Pick<AgentManager, 'list' | 'getStatus'>;
  readonly agentMessageBus: Pick<AgentMessageBus, 'getMessages'>;
  readonly workingDirectory: string;
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
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Row cache — cleared on markDirty(), computed once per render cycle
  private _cachedRows: DisplayRow[] | null = null;

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
                ? 'Spawn an agent to inspect its live and historical timeline.'
                : 'Press Tab to cycle through available agents and open one in the inspector.',
              [],
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
              'The selected agent has not emitted any visible timeline entries yet.',
              [],
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
    const summarySection = { title: 'Summary', lines: summaryLines } as const;
    const agentsSection = { title: 'Agents', lines: [selectorLine] } as const;
    const timelineSection = resolveScrollablePanelSection(width, height, {
      intro: 'Inspect a selected agent timeline, tool activity, expanded details, and live/historical message flow.',
      footerLines: [
        buildPanelLine(width, [[` L${this.cursorIndex + 1}/${allRows.length}`, DEFAULT_PANEL_PALETTE.dim], ['   Tab', DEFAULT_PANEL_PALETTE.info], [' cycle agents', DEFAULT_PANEL_PALETTE.dim], ['   Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim]]),
      ],
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summarySection, agentsSection],
      section: {
        title: 'Timeline',
        scrollableLines: allRows.map((row, index) => this._renderTimelineRow(width, row, index === this.cursorIndex)),
        selectedIndex: this.cursorIndex,
        scrollOffset: this.scrollOffset,
        minRows: 8,
      },
    });
    this.scrollOffset = timelineSection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ` Inspector [${agents.length} agent${agents.length !== 1 ? 's' : ''}]`,
      intro: 'Inspect a selected agent timeline, tool activity, expanded details, and live/historical message flow.',
      sections: [
        summarySection,
        agentsSection,
        timelineSection.section,
      ],
      footerLines: [
        buildPanelLine(width, [[` L${this.cursorIndex + 1}/${allRows.length}`, DEFAULT_PANEL_PALETTE.dim], ['   Tab', DEFAULT_PANEL_PALETTE.info], [' cycle agents', DEFAULT_PANEL_PALETTE.dim], ['   Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim]]),
      ],
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
    const taskDisplay = taskPreview.length > maxTask
      ? taskPreview.slice(0, maxTask - 1) + '\u2026'
      : taskPreview;
    return buildPanelLine(width, [
      [' Status ', DEFAULT_PANEL_PALETTE.label],
      [rec.status.toUpperCase(), rec.status === 'running' ? DEFAULT_PANEL_PALETTE.good : rec.status === 'failed' ? DEFAULT_PANEL_PALETTE.bad : DEFAULT_PANEL_PALETTE.dim],
      ['   Duration ', DEFAULT_PANEL_PALETTE.label],
      [formatMs(elapsed), DEFAULT_PANEL_PALETTE.value],
      ['   Tools ', DEFAULT_PANEL_PALETTE.label],
      [String(rec.toolCallCount), DEFAULT_PANEL_PALETTE.info],
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
    const bg = isCursor ? '#1a2233' : '';
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
}
