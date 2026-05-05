import { promises as fsPromises, watch, type FSWatcher } from 'fs';
import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { AgentManager, AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import type { AgentEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import {
  type AgentLogEntry as LogEntry,
  type AgentLogFilterType as FilterType,
  AGENT_LOG_COLORS as COLOR,
  AGENT_LOG_FILTER_CYCLE as FILTER_CYCLE,
  AGENT_LOG_FILTER_LABELS as FILTER_LABELS,
  parseAgentJsonl,
} from './agent-logs-shared.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 500;

export interface AgentLogsPanelDeps {
  readonly agentManager: Pick<AgentManager, 'list'>;
  readonly workingDirectory: string;
}


// ---------------------------------------------------------------------------
// AgentLogsPanel
// ---------------------------------------------------------------------------

export class AgentLogsPanel extends ScrollableListPanel<LogEntry> {
  // ── Agent state ─────────────────────────────────────────────────────────
  private agents: AgentRecord[] = [];
  private selectedAgentIndex = 0;

  // ── Log state ────────────────────────────────────────────────────────────
  private allEntries: LogEntry[] = []; // raw parsed JSONL for selected agent
  private filteredEntries: LogEntry[] = []; // after filter applied
  private lastFileSize = 0;

  // ── Modes ────────────────────────────────────────────────────────────────
  private autoFollow = true;
  private paused = false;
  private filter: FilterType = 'all';

  // ── Infrastructure ───────────────────────────────────────────────────────
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fsWatcher: FSWatcher | null = null;
  private unsubs: Array<() => void> = [];
  private readonly agentEvents: UiEventFeed<AgentEvent>;

  constructor(agentEvents: UiEventFeed<AgentEvent>, private readonly deps: AgentLogsPanelDeps) {
    super('agent-logs', 'Agents', 'A', 'agent');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.agentEvents = agentEvents;
    this._refreshAgents();
    this._startPolling();
    this._subscribeEvents();
  }

  // ── ScrollableListPanel<LogEntry> contract ────────────────────────────────

  protected getItems(): readonly LogEntry[] {
    return this.filteredEntries;
  }

  protected renderItem(entry: LogEntry, _index: number, _selected: boolean, width: number): Line {
    return this._renderEntry(entry, width);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  override onActivate(): void {
    super.onActivate();
    this._refreshAgents();
    this._pollCurrentAgent();
  }

  override onDeactivate(): void {
    super.onDeactivate();
  }

  override onDestroy(): void {
    this._stopPolling();
    this._unsubscribeEvents();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  handleInput(key: string): boolean {
    switch (key) {
      case 'tab':
      case '\t': // Tab — cycle to next agent
        this._selectNextAgent();
        return true;
      case ' ': // Space — pause/resume
        this._togglePause();
        return true;
      case 'f': // f — cycle filter
        this._cycleFilter();
        return true;
      case 'g': // g — jump to top
        this.selectedIndex = 0;
        this.autoFollow = false;
        this.markDirty();
        return true;
      case 'G': // G — jump to bottom / re-enable auto-follow
        this.autoFollow = true;
        this._clampScroll();
        this.markDirty();
        return true;
      default:
        return super.handleInput(key);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render(width: number, height: number): Line[] {
    this.needsRender = false;
    const footerLines = [
      buildPanelLine(width, [
        [' Tab', DEFAULT_PANEL_PALETTE.info], [' next agent', DEFAULT_PANEL_PALETTE.dim],
        ['   Space', DEFAULT_PANEL_PALETTE.info], [' pause', DEFAULT_PANEL_PALETTE.dim],
        ['   f', DEFAULT_PANEL_PALETTE.info], [' filter', DEFAULT_PANEL_PALETTE.dim],
        ['   g/G', DEFAULT_PANEL_PALETTE.info], [' scroll', DEFAULT_PANEL_PALETTE.dim],
      ]),
    ];

    const summaryLines = [
      buildPanelLine(width, [
        [' Agents ', DEFAULT_PANEL_PALETTE.label],
        [String(this.agents.length), DEFAULT_PANEL_PALETTE.value],
        ['   Filter ', DEFAULT_PANEL_PALETTE.label],
        [FILTER_LABELS[this.filter], DEFAULT_PANEL_PALETTE.info],
        ['   Mode ', DEFAULT_PANEL_PALETTE.label],
        [this.paused ? 'paused' : this.autoFollow ? 'auto-follow' : 'manual', this.paused ? DEFAULT_PANEL_PALETTE.warn : this.autoFollow ? DEFAULT_PANEL_PALETTE.good : DEFAULT_PANEL_PALETTE.dim],
      ]),
    ];

    if (this.agents.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Agents',
        intro: 'View-only live session stream for running agents, with per-agent switching and filtered event tails.',
        sections: [
          { title: 'Summary', lines: summaryLines },
          {
            lines: buildEmptyState(
              width,
              ' No agents running',
              'Spawn or attach to an agent session and its structured logs will appear here.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        footerLines,
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const selectedAgent = this._selectedAgent();
    const selectorLine = this._renderAgentSelector(width);
    if (selectedAgent) {
      summaryLines.push(buildPanelLine(width, [
        [' Selected ', DEFAULT_PANEL_PALETTE.label],
        [selectedAgent.id, DEFAULT_PANEL_PALETTE.info],
        ['   Status ', DEFAULT_PANEL_PALETTE.label],
        [selectedAgent.status, selectedAgent.status === 'running' ? DEFAULT_PANEL_PALETTE.good : selectedAgent.status === 'failed' ? DEFAULT_PANEL_PALETTE.bad : DEFAULT_PANEL_PALETTE.dim],
      ]));
    }

    if (this.filteredEntries.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Agents',
        intro: 'View-only live session stream for running agents, with per-agent switching and filtered event tails.',
        sections: [
          { title: 'Summary', lines: summaryLines },
          { title: 'Agents', lines: [selectorLine] },
          {
            lines: buildEmptyState(
              width,
              ` No ${this.filter === 'all' ? '' : `${this.filter} `}log entries yet`,
              'Once the selected agent writes session events, they will appear here and can be filtered by type.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        footerLines,
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const focusIndex = this.autoFollow
      ? Math.max(0, this.filteredEntries.length - 1)
      : Math.min(this.selectedIndex, Math.max(0, this.filteredEntries.length - 1));
    const summarySection = { title: 'Summary', lines: summaryLines } as const;
    const agentsSection = { title: 'Agents', lines: [selectorLine] } as const;
    const logStreamSection = resolveScrollablePanelSection(width, height, {
      intro: 'Tail per-agent JSONL session logs, filter entries, and switch between running or completed agents.',
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summarySection, agentsSection],
      section: {
        title: 'Log Stream',
        scrollableLines: this.filteredEntries.map((entry) => this._renderEntry(entry, width)),
        selectedIndex: focusIndex,
        scrollOffset: this.scrollStart,
        minRows: 8,
      },
    });
    this.scrollStart = logStreamSection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ' Agents',
      intro: 'View-only live session stream for running agents, with per-agent switching and filtered event tails.',
      sections: [
        summarySection,
        agentsSection,
        logStreamSection.section,
      ],
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  // ── Private: polling ─────────────────────────────────────────────────────

  private _startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      if (!this.paused) {
        this._pollCurrentAgent();
      }
    }, POLL_INTERVAL_MS);
    // Also do an immediate read
    this._pollCurrentAgent();
  }

  private _stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._stopWatcher();
  }

  private _pollCurrentAgent(): void {
    void this._pollCurrentAgentAsync();
  }

  private async _pollCurrentAgentAsync(): Promise<void> {
    const agent = this._selectedAgent();
    if (!agent) return;

    const sessionFile = this._sessionFilePath(agent.id);
    try {
      await fsPromises.access(sessionFile);
    } catch {
      return;
    }

    try {
      const content = await fsPromises.readFile(sessionFile, 'utf-8');
      if (content.length === this.lastFileSize) return;
      this.lastFileSize = content.length;

      // Re-parse all lines (simple: no partial-line tracking needed at 500ms)
      this.allEntries = parseAgentJsonl(content);
      this._applyFilter();
      if (this.autoFollow) {
        this.selectedIndex = Math.max(0, this.filteredEntries.length - 1);
      }
      this.markDirty();
    } catch {
      // Non-fatal: file may be mid-write
    }
  }

  // ── Private: fs.watch (supplemental) ─────────────────────────────────────

  private _watchAgent(agentId: string): void {
    this._stopWatcher();
    const sessionFile = this._sessionFilePath(agentId);
    // Start watching immediately; the watcher setup itself is synchronous,
    // the file-existence check is skipped to avoid blocking — if the file
    // does not yet exist watch() will throw and we catch it below.
    try {
      this.fsWatcher = watch(sessionFile, () => {
        if (!this.paused) {
          this._pollCurrentAgent();
        }
      });
    } catch {
      // Non-fatal: polling covers us
    }
  }

  private _stopWatcher(): void {
    if (this.fsWatcher) {
      try { this.fsWatcher.close(); } catch { /* ignore */ }
      this.fsWatcher = null;
    }
  }

  // ── Private: event subscriptions ─────────────────────────────────────────

  private _subscribeEvents(): void {
    const onSpawned = (data: { id: string; task: string }) => {
      void data;
      this._refreshAgents();
      // Auto-select the newest agent if none selected or all done
      const running = this.agents.filter(a => a.status === 'running' || a.status === 'pending');
      if (running.length === 1) {
        const idx = this.agents.findIndex(a => a.id === running[0]!.id);
        if (idx >= 0) this._selectAgent(idx);
      }
      this.markDirty();
    };

    const onComplete = (data: { id: string }) => {
      void data;
      this._refreshAgents();
      this.markDirty();
    };

    const onError = (data: { id: string; error: Error }) => {
      void data;
      this._refreshAgents();
      this.markDirty();
    };

    this.unsubs.push(
      this.agentEvents.on('AGENT_SPAWNING', (payload) => onSpawned({ id: payload.agentId, task: payload.task })),
      this.agentEvents.on('AGENT_COMPLETED', (payload) => onComplete({ id: payload.agentId })),
      this.agentEvents.on('AGENT_FAILED', (payload) => onError({ id: payload.agentId, error: new Error(payload.error) })),
    );
  }

  private _unsubscribeEvents(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  // ── Private: agent management ─────────────────────────────────────────────

  private _refreshAgents(): void {
    const prev = this._selectedAgent();
    this.agents = this.deps.agentManager.list()
      .sort((a, b) => b.startedAt - a.startedAt); // newest first

    // Try to keep same agent selected
    if (prev) {
      const idx = this.agents.findIndex(a => a.id === prev.id);
      this.selectedAgentIndex = idx >= 0 ? idx : 0;
    } else {
      this.selectedAgentIndex = 0;
    }

    // Re-watch if agent changed
    const current = this._selectedAgent();
    if (current) {
      this._watchAgent(current.id);
      this._reloadAgent(current);
    }
  }

  private _selectAgent(index: number): void {
    if (index < 0 || index >= this.agents.length) return;
    this.selectedAgentIndex = index;
    this.allEntries = [];
    this.filteredEntries = [];
    this.lastFileSize = 0;
    this.selectedIndex = 0;
    this.scrollStart = 0;
    this.autoFollow = true;
    const agent = this._selectedAgent();
    if (agent) {
      this._watchAgent(agent.id);
      this._reloadAgent(agent);
    }
    this.markDirty();
  }

  private _selectNextAgent(): void {
    if (this.agents.length === 0) return;
    this._selectAgent((this.selectedAgentIndex + 1) % this.agents.length);
  }

  private _selectedAgent(): AgentRecord | null {
    return this.agents[this.selectedAgentIndex] ?? null;
  }

  private _reloadAgent(agent: AgentRecord): void {
    void this._reloadAgentAsync(agent);
  }

  private async _reloadAgentAsync(agent: AgentRecord): Promise<void> {
    const sessionFile = this._sessionFilePath(agent.id);
    try {
      await fsPromises.access(sessionFile);
    } catch {
      this.allEntries = [];
      this.filteredEntries = [];
      this.lastFileSize = 0;
      this.markDirty();
      return;
    }
    try {
      const content = await fsPromises.readFile(sessionFile, 'utf-8');
      this.lastFileSize = content.length;
      this.allEntries = parseAgentJsonl(content);
      this._applyFilter();
      if (this.autoFollow) {
        this.selectedIndex = Math.max(0, this.filteredEntries.length - 1);
      }
      this.markDirty();
    } catch {
      this.allEntries = [];
      this.filteredEntries = [];
      this.markDirty();
    }
  }

  private _sessionFilePath(agentId: string): string {
    return `${this.deps.workingDirectory}/.goodvibes/tui/sessions/${agentId}.jsonl`;
  }

  // ── Private: filter ───────────────────────────────────────────────────────

  private _applyFilter(): void {
    if (this.filter === 'all') {
      this.filteredEntries = [...this.allEntries];
      return;
    }
    this.filteredEntries = this.allEntries.filter(e => {
      if (this.filter === 'assistant') return e.type === 'assistant';
      if (this.filter === 'tool') return e.type === 'tool';
      if (this.filter === 'error') return e.type === 'error';
      return true;
    });
  }

  private _cycleFilter(): void {
    const idx = FILTER_CYCLE.indexOf(this.filter);
    this.filter = FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length]!;
    this._applyFilter();
    if (this.autoFollow) {
      this.selectedIndex = Math.max(0, this.filteredEntries.length - 1);
    }
    this.markDirty();
  }

  private _togglePause(): void {
    this.paused = !this.paused;
    this.markDirty();
  }

  private _clampScroll(): void {
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredEntries.length - 1));
  }

  // ── Private: rendering helpers ─────────────────────────────────────────────

  /** Top header bar: title + filter label + mode indicators */
  private _renderHeader(width: number): Line {
    const title = ' Agent Logs ';
    const filterLabel = `[${FILTER_LABELS[this.filter]}] `;
    const pause = this.paused ? ' PAUSED ' : '';
    const follow = this.autoFollow ? ' AUTO-FOLLOW ' : '';
    const keyhints = '  Tab:next  Space:pause  f:filter  g/G:scroll ';
    return buildStyledPanelLine(width, [
      { text: title, fg: COLOR.header_accent, bold: true },
      { text: filterLabel, fg: COLOR.filter_active },
      { text: pause, fg: COLOR.paused },
      { text: follow, fg: COLOR.auto_follow },
      { text: keyhints, fg: COLOR.header_label },
    ]);
  }

  /** Agent selector bar: shows running agents with cycle indicator */
  private _renderAgentSelector(width: number): Line {
    const prefix = ' Agents: ';
    const segments: Array<{ text: string; fg: string; bold?: boolean }> = [
      { text: prefix, fg: COLOR.header_label },
    ];
    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i]!;
      const isSelected = i === this.selectedAgentIndex;
      const statusColor = this._agentStatusColor(agent.status);
      const shortId = agent.id.replace('agent-', '');
      const label = isSelected
        ? `[${shortId}:${agent.status}] `
        : `${shortId}:${agent.status}  `;
      segments.push({
        text: label,
        fg: isSelected ? COLOR.agent_selected : statusColor,
        bold: isSelected,
      });
    }
    return buildStyledPanelLine(width, segments);
  }

  private _renderNoAgents(width: number): Line {
    const msg = ' No agents running. ';
    return buildStyledPanelLine(width, [{ text: msg, fg: COLOR.dim }]);
  }

  private _renderSeparator(width: number): Line {
    return buildStyledPanelLine(width, [{ text: '─'.repeat(width), fg: COLOR.separator }]);
  }

  private _renderEmpty(width: number, bodyHeight: number): Line[] {
    const lines: Line[] = [];
    const msg = this.agents.length === 0
      ? ' No agents running '
      : ` No ${this.filter === 'all' ? '' : this.filter + ' '}log entries yet `;
    const offset = Math.max(0, Math.floor((width - msg.length) / 2));
    const textLine = buildStyledPanelLine(width, [
      { text: ' '.repeat(offset), fg: COLOR.dim },
      { text: msg, fg: COLOR.dim },
    ]);
    lines.push(textLine);
    while (lines.length < bodyHeight) {
      lines.push(createEmptyLine(width));
    }
    return lines;
  }

  private _renderEntry(entry: LogEntry, width: number): Line {
    // Indent non-session entries
    const prefix = entry.type === 'session_start' ? '' : '  ';
    const fullText = prefix + entry.text;
    return buildStyledPanelLine(width, [{ text: fullText, fg: entry.color, bold: entry.bold }]);
  }

  private _agentStatusColor(status: AgentRecord['status']): string {
    switch (status) {
      case 'running': return COLOR.agent_running;
      case 'pending': return COLOR.agent_pending;
      case 'completed': return COLOR.agent_done;
      case 'failed': return COLOR.agent_error;
      case 'cancelled': return COLOR.agent_done;
      default: return COLOR.dim;
    }
  }
}
