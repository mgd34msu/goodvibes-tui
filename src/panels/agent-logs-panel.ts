import { readFileSync, existsSync, watch, type FSWatcher } from 'fs';
import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { AgentManager } from '../tools/agent/index.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import type { EventBus } from '../core/event-bus.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FilterType = 'all' | 'assistant' | 'tool' | 'error';

interface LogEntry {
  raw: Record<string, unknown>;
  type: string;
  text: string;
  color: string;
  bold: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 500;

const FILTER_LABELS: Record<FilterType, string> = {
  all: 'All',
  assistant: 'Assistant',
  tool: 'Tool',
  error: 'Error',
};

const FILTER_CYCLE: FilterType[] = ['all', 'assistant', 'tool', 'error'];

// ANSI 256-color codes / hex for coloring
const COLOR = {
  header_bg: '235',
  header_fg: '250',
  header_accent: '#00ffff',
  header_label: '244',
  agent_selected: '#00ffff',
  agent_running: '#00ff87',
  agent_pending: '220',
  agent_done: '244',
  agent_error: '#ff5f5f',
  assistant: '255',
  tool: '#00e5ff',
  error: '#ff5f5f',
  dim: '240',
  paused: '220',
  auto_follow: '#00ff87',
  session_start: '238',
  separator: '237',
  filter_active: '#00ffff',
  filter_inactive: '244',
} as const;

// ---------------------------------------------------------------------------
// AgentLogsPanel
// ---------------------------------------------------------------------------

export class AgentLogsPanel extends BasePanel {
  // ── Agent state ─────────────────────────────────────────────────────────
  private agents: AgentRecord[] = [];
  private selectedAgentIndex = 0;

  // ── Log state ────────────────────────────────────────────────────────────
  private allEntries: LogEntry[] = []; // raw parsed JSONL for selected agent
  private filteredEntries: LogEntry[] = []; // after filter applied
  private lastFileSize = 0;
  private scrollOffset = 0;

  // ── Modes ────────────────────────────────────────────────────────────────
  private autoFollow = true;
  private paused = false;
  private filter: FilterType = 'all';

  // ── Infrastructure ───────────────────────────────────────────────────────
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fsWatcher: FSWatcher | null = null;
  private unsubs: Array<() => void> = [];
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    super('agent-logs', 'Agent Logs', 'A', 'agent');
    this.eventBus = eventBus;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  override onActivate(): void {
    super.onActivate();
    this._refreshAgents();
    this._startPolling();
    this._subscribeEvents();
  }

  override onDeactivate(): void {
    this._stopPolling();
    this._unsubscribeEvents();
  }

  override onDestroy(): void {
    this._stopPolling();
    this._unsubscribeEvents();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  handleInput(key: string): boolean {
    switch (key) {
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
        this.scrollOffset = 0;
        this.autoFollow = false;
        this.markDirty();
        return true;
      case 'G': // G — jump to bottom / re-enable auto-follow
        this.autoFollow = true;
        this._clampScroll(0);
        this.markDirty();
        return true;
      case 'k': // k / up
      case '\x1b[A':
        this.autoFollow = false;
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        this.markDirty();
        return true;
      case 'j': // j / down
      case '\x1b[B':
        this.scrollOffset++;
        this.markDirty();
        return true;
      default:
        return false;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];

    // Header (1 line)
    lines.push(this._renderHeader(width));

    // Agent selector (1 line, shown if any agents exist)
    if (this.agents.length > 0) {
      lines.push(this._renderAgentSelector(width));
    } else {
      lines.push(this._renderNoAgents(width));
    }

    // Separator
    lines.push(this._renderSeparator(width));

    const bodyHeight = height - 3; // header + selector + separator
    if (bodyHeight <= 0) return lines;

    if (this.agents.length === 0 || this.filteredEntries.length === 0) {
      lines.push(...this._renderEmpty(width, bodyHeight));
      return lines;
    }

    // Clamp scroll
    const maxScroll = Math.max(0, this.filteredEntries.length - bodyHeight);
    if (this.autoFollow) {
      this.scrollOffset = maxScroll;
    } else {
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    }

    const visible = this.filteredEntries.slice(
      this.scrollOffset,
      this.scrollOffset + bodyHeight,
    );

    for (const entry of visible) {
      lines.push(this._renderEntry(entry, width));
    }

    // Pad remaining rows
    while (lines.length < height) {
      lines.push(createEmptyLine(width));
    }

    return lines;
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
    const agent = this._selectedAgent();
    if (!agent) return;

    const sessionFile = this._sessionFilePath(agent.id);
    if (!existsSync(sessionFile)) return;

    try {
      const content = readFileSync(sessionFile, 'utf-8');
      if (content.length === this.lastFileSize) return;
      this.lastFileSize = content.length;

      // Re-parse all lines (simple: no partial-line tracking needed at 500ms)
      this.allEntries = this._parseJsonl(content);
      this._applyFilter();
      if (this.autoFollow) {
        this.scrollOffset = Math.max(0, this.filteredEntries.length - 1);
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
    if (!existsSync(sessionFile)) return;
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
      this.eventBus.on('subagent:spawned', onSpawned),
      this.eventBus.on('subagent:complete', onComplete),
      this.eventBus.on('subagent:error', onError),
    );
  }

  private _unsubscribeEvents(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  // ── Private: agent management ─────────────────────────────────────────────

  private _refreshAgents(): void {
    const prev = this._selectedAgent();
    this.agents = AgentManager.getInstance().list()
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
    this.scrollOffset = 0;
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
    const sessionFile = this._sessionFilePath(agent.id);
    if (!existsSync(sessionFile)) {
      this.allEntries = [];
      this.filteredEntries = [];
      this.lastFileSize = 0;
      return;
    }
    try {
      const content = readFileSync(sessionFile, 'utf-8');
      this.lastFileSize = content.length;
      this.allEntries = this._parseJsonl(content);
      this._applyFilter();
      if (this.autoFollow) {
        this.scrollOffset = Math.max(0, this.filteredEntries.length - 1);
      }
    } catch {
      this.allEntries = [];
      this.filteredEntries = [];
    }
  }

  private _sessionFilePath(agentId: string): string {
    return `${process.cwd()}/.goodvibes/tui/sessions/${agentId}.jsonl`;
  }

  // ── Private: JSONL parsing ─────────────────────────────────────────────────

  private _parseJsonl(content: string): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        entries.push(this._toLogEntry(obj));
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  }

  private _toLogEntry(obj: Record<string, unknown>): LogEntry {
    const type = typeof obj['type'] === 'string' ? obj['type'] : 'unknown';

    switch (type) {
      case 'meta':
      case 'session_start': {
        const agentId = String(obj['agentId'] ?? '');
        const model = String(obj['model'] ?? '');
        const provider = String(obj['provider'] ?? '');
        const ts = String(obj['timestamp'] ?? '').replace('T', ' ').replace(/\.\d+Z$/, '');
        return {
          raw: obj,
          type: 'session_start',
          text: `[${ts}] Session started  agent=${agentId}  model=${model}  provider=${provider}`,
          color: COLOR.session_start,
          bold: false,
        };
      }
      case 'assistant': {
        const content = String(obj['content'] ?? obj['text'] ?? '');
        return {
          raw: obj,
          type: 'assistant',
          text: content,
          color: COLOR.assistant,
          bold: false,
        };
      }
      case 'tool_call': {
        const tool = String(obj['tool'] ?? obj['name'] ?? '');
        const args = obj['args'] ?? obj['arguments'] ?? {};
        const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
        return {
          raw: obj,
          type: 'tool',
          text: `[tool] ${tool}  ${argsStr.slice(0, 120)}`,
          color: COLOR.tool,
          bold: false,
        };
      }
      case 'tool_result': {
        const tool = String(obj['tool'] ?? obj['name'] ?? '');
        const result = obj['result'] ?? obj['output'] ?? '';
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        return {
          raw: obj,
          type: 'tool',
          text: `[result] ${tool}  ${resultStr.slice(0, 120)}`,
          color: COLOR.tool,
          bold: false,
        };
      }
      case 'error': {
        const msg = String(obj['error'] ?? obj['message'] ?? obj['msg'] ?? JSON.stringify(obj));
        return {
          raw: obj,
          type: 'error',
          text: `[error] ${msg}`,
          color: COLOR.error,
          bold: true,
        };
      }
      default: {
        // Generic: render as compact JSON or text
        const text = typeof obj['text'] === 'string'
          ? obj['text']
          : typeof obj['content'] === 'string'
            ? obj['content']
            : `[${type}] ${JSON.stringify(obj).slice(0, 120)}`;
        return {
          raw: obj,
          type,
          text,
          color: COLOR.dim,
          bold: false,
        };
      }
    }
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
      this.scrollOffset = Math.max(0, this.filteredEntries.length - 1);
    }
    this.markDirty();
  }

  private _togglePause(): void {
    this.paused = !this.paused;
    this.markDirty();
  }

  private _clampScroll(height: number): void {
    const maxScroll = Math.max(0, this.filteredEntries.length - height);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
  }

  // ── Private: rendering helpers ─────────────────────────────────────────────

  /** Top header bar: title + filter label + mode indicators */
  private _renderHeader(width: number): Line {
    const line = createEmptyLine(width);
    let x = 0;

    // Title
    const title = ' Agent Logs ';
    for (const ch of title) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg: COLOR.header_accent, bold: true });
    }

    // Filter label
    const filterLabel = `[${FILTER_LABELS[this.filter]}] `;
    for (const ch of filterLabel) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg: COLOR.filter_active });
    }

    // Right-side mode indicators
    const pause = this.paused ? ' PAUSED ' : '';
    const follow = this.autoFollow ? ' AUTO-FOLLOW ' : '';
    const keyhints = '  Tab:next  Space:pause  f:filter  g/G:scroll ';
    const right = `${pause}${follow}${keyhints}`;
    const rightStart = width - right.length;

    for (let i = 0; i < right.length; i++) {
      const rx = rightStart + i;
      if (rx < 0 || rx >= width) continue;
      const ch = right[i]!;
      let fg: string = COLOR.header_label;
      if (pause && i < pause.length) fg = COLOR.paused;
      else if (follow && i >= pause.length && i < pause.length + follow.length) fg = COLOR.auto_follow;
      line[rx] = createStyledCell(ch, { fg });
    }

    return line;
  }

  /** Agent selector bar: shows running agents with cycle indicator */
  private _renderAgentSelector(width: number): Line {
    const line = createEmptyLine(width);
    let x = 0;

    const prefix = ' Agents: ';
    for (const ch of prefix) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg: COLOR.header_label });
    }

    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i]!;
      const isSelected = i === this.selectedAgentIndex;
      const statusColor = this._agentStatusColor(agent.status);
      const shortId = agent.id.replace('agent-', '');
      const label = isSelected
        ? `[${shortId}:${agent.status}] `
        : `${shortId}:${agent.status}  `;

      for (const ch of label) {
        if (x >= width) break;
        line[x++] = createStyledCell(ch, {
          fg: isSelected ? COLOR.agent_selected : statusColor,
          bold: isSelected,
        });
      }
    }

    return line;
  }

  private _renderNoAgents(width: number): Line {
    const line = createEmptyLine(width);
    const msg = ' No agents running. ';
    let x = 0;
    for (const ch of msg) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg: COLOR.dim });
    }
    return line;
  }

  private _renderSeparator(width: number): Line {
    const line = createEmptyLine(width);
    for (let i = 0; i < width; i++) {
      line[i] = createStyledCell('─', { fg: COLOR.separator });
    }
    return line;
  }

  private _renderEmpty(width: number, bodyHeight: number): Line[] {
    const lines: Line[] = [];
    const msg = this.agents.length === 0
      ? ' No agents running '
      : ` No ${this.filter === 'all' ? '' : this.filter + ' '}log entries yet `;
    const emptyLine = createEmptyLine(width);
    const textLine = createEmptyLine(width);
    const offset = Math.max(0, Math.floor((width - msg.length) / 2));
    let x = offset;
    for (const ch of msg) {
      if (x >= width) break;
      textLine[x++] = createStyledCell(ch, { fg: COLOR.dim });
    }
    lines.push(textLine);
    while (lines.length < bodyHeight) {
      lines.push(createEmptyLine(width));
    }
    void emptyLine;
    return lines;
  }

  private _renderEntry(entry: LogEntry, width: number): Line {
    const line = createEmptyLine(width);
    // Indent non-session entries
    const prefix = entry.type === 'session_start' ? '' : '  ';
    const fullText = prefix + entry.text;
    let x = 0;
    for (const ch of fullText) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg: entry.color, bold: entry.bold });
    }
    return line;
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
