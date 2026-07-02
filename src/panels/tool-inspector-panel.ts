// ---------------------------------------------------------------------------
// ToolInspectorPanel — chronological list of tool calls with args/results.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { ToolEvent, TurnEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import type { PanelIntegrationContext } from './types.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelWorkspaceSection,
} from './polish.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { formatDuration } from '../utils/format-duration.ts';

// Panel-specific accents only; shared tones come from DEFAULT_PANEL_PALETTE so
// theme changes propagate. selectedBg->selectBg, errorFg->bad are shared keys.
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  selected: '#00ffff',
  toolFg:   '#00ccff',
  argsFg:   '#aaaaaa',
});

const MAX_ENTRIES = 500;

interface ToolCallRecord {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Wall-clock time the call was received from the LLM (queued, not yet executing). */
  startMs: number;
  /**
   * Real execution-start time from TOOL_EXECUTING.startedAt — used for duration
   * math when present so displayed durations reflect actual run time rather
   * than time spent in permission/hook queueing. Falls back to `startMs` when
   * a call completes without ever reaching TOOL_EXECUTING (e.g. denied before
   * execution).
   */
  execStartMs?: number;
  endMs?: number;
  result?: unknown;
  error?: string;
  cancelled?: boolean;
  expanded: boolean;
  approved?: boolean;
  outputClass?: string;
  resultSummary?: string;
}

type FilterMode = 'all' | string;

type FlatRow =
  | { kind: 'call'; recordIndex: number; text: string }
  | { kind: 'detail'; text: string; isError: boolean };

function shortTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function formatMs(ms: number): string {
  return formatDuration(ms);
}

function truncateJson(val: unknown, maxLen = 120): string {
  const s = JSON.stringify(val) ?? 'null';
  return truncateDisplay(s, maxLen);
}

function summarizeResult(result: unknown): string | undefined {
  // SDK OBS-05 (0.21.31+): TOOL_SUCCEEDED/TOOL_FAILED.result is a ToolResultSummary
  // { kind: 'text' | 'json' | 'binary' | 'error' | 'empty'; byteSize: number; preview?: string }.
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.preview === 'string' && record.preview.trim()) {
    const compact = record.preview.replace(/\s+/g, ' ').trim();
    return truncateDisplay(compact, 72);
  }
  if (typeof record.kind === 'string' && typeof record.byteSize === 'number') {
    return `${record.kind} (${record.byteSize}B)`;
  }
  return undefined;
}

function statusLabel(rec: ToolCallRecord): string {
  if (rec.endMs === undefined) return 'running';
  if (rec.cancelled) return 'cancelled';
  if (rec.error) return 'error';
  return 'completed';
}

function statusColor(rec: ToolCallRecord): string {
  if (rec.endMs === undefined) return DEFAULT_PANEL_PALETTE.warn;
  if (rec.cancelled) return DEFAULT_PANEL_PALETTE.dim;
  if (rec.error) return DEFAULT_PANEL_PALETTE.bad;
  return DEFAULT_PANEL_PALETTE.good;
}

function detectOutputClass(tool: string, args: Record<string, unknown>): string {
  const name = tool.toLowerCase();
  if (name.includes('read') || name.includes('find') || name.includes('inspect') || name.includes('grep')) return 'read';
  if (name.includes('write') || name.includes('edit') || name.includes('patch')) return 'write';
  if (name.includes('exec') || name.includes('shell') || name.includes('bash') || typeof args.command === 'string') return 'execute';
  if (name.includes('fetch') || name.includes('http') || name.includes('remote')) return 'network';
  return 'analyze';
}

export class ToolInspectorPanel extends BasePanel {
  private records: ToolCallRecord[] = [];
  private filterMode: FilterMode = 'all';
  private unsubs: Array<() => void> = [];
  private cursorIndex = 0;
  private scrollOffset = 0;
  private autoScroll = true;
  private _flatCache: FlatRow[] | null = null;
  /** Pending confirm for 'c' clear — destructive (drops call history), so it goes through the project-standard confirm contract. */
  private _confirm: ConfirmState<'clear'> | null = null;
  /** Set by handleInput('a') when the selected call is awaiting a permission decision; consumed by handlePanelIntegrationAction. */
  private _pendingApprovalJump = false;

  constructor(
    private readonly toolEvents: UiEventFeed<ToolEvent>,
    private readonly turnEvents: UiEventFeed<TurnEvent>,
  ) {
    super('tools', 'Tools', 'X', 'ai');
    this._attachBus();
  }

  override onActivate(): void {
    this.needsRender = true;
  }

  override onDeactivate(): void {
    super.onDeactivate();
  }

  override onDestroy(): void {
    this._detachBus();
  }

  override markDirty(): void {
    this._flatCache = null;
    super.markDirty();
  }

  handleInput(key: string): boolean {
    const confirmResult = handleConfirmInput(this._confirm, key);
    if (confirmResult === 'confirmed') {
      this.records = [];
      this._confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this._confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    switch (key) {
      case 'up':       this._move(-1);           this.autoScroll = false; return true;
      case 'down':     this._move(1);            return true;
      case 'pageup':   this._move(-10);          this.autoScroll = false; return true;
      case 'pagedown': this._move(10);           return true;
      case 'return':   this._toggleExpand();     return true;
      case 'c': {
        if (this.records.length === 0) return false;
        this._confirm = { subject: 'clear', label: `${this.records.length} tool call${this.records.length === 1 ? '' : 's'}`, verb: 'Clear' };
        this.markDirty();
        return true;
      }
      case 'g':        this.autoScroll = true;   this.markDirty(); return true;
      case 'f':        this._cycleFilter();      return true;
      case 'a': {
        const rec = this._selectedRecord();
        if (!rec || rec.approved !== undefined || rec.endMs !== undefined) return false;
        this._pendingApprovalJump = true;
        return true;
      }
      default:         return false;
    }
  }

  /**
   * Cross-panel hook — invoked immediately after handleInput('a') returns true
   * for a call still awaiting a permission decision. Jumps to the Approval
   * panel; the actual PanelManager reference is only available here.
   */
  handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (!this._pendingApprovalJump) return false;
    this._pendingApprovalJump = false;
    ctx.panelManager.open('approval');
    return true;
  }

  render(width: number, height: number): Line[] {
    if (height <= 0 || width <= 0) return [];

    const running = this.records.filter(r => r.endMs === undefined).length;
    const distinctTools = new Set(this.records.map((r) => r.tool)).size;
    const filterLabel = this.filterMode === 'all' ? '' : ` [${this.filterMode}]`;
    const title = ` Tools [${this.records.length} calls${running > 0 ? `, ${running} running` : ''}]${filterLabel}`;
    // Context-aware footer: only advertise keys that do something in the current
    // state — filter needs >1 tool, clear/end need at least one call.
    const footerSegments: Array<[string, string, string?]> = [
      [' Up/Down', DEFAULT_PANEL_PALETTE.info], [' scroll', DEFAULT_PANEL_PALETTE.dim],
      ['   Enter', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim],
    ];
    if (distinctTools > 1) {
      footerSegments.push(['   f', DEFAULT_PANEL_PALETTE.info], [' filter', DEFAULT_PANEL_PALETTE.dim]);
    }
    if (this.records.length > 0) {
      footerSegments.push(['   c', DEFAULT_PANEL_PALETTE.info], [' clear', DEFAULT_PANEL_PALETTE.dim]);
      footerSegments.push(['   g', DEFAULT_PANEL_PALETTE.info], [this.autoScroll ? ' end (live)' : ' jump to end', DEFAULT_PANEL_PALETTE.dim]);
    }
    const selectedRecordForFooter = this._selectedRecord();
    if (selectedRecordForFooter && selectedRecordForFooter.approved === undefined && selectedRecordForFooter.endMs === undefined) {
      footerSegments.push(['   a', DEFAULT_PANEL_PALETTE.info], [' review approval', DEFAULT_PANEL_PALETTE.dim]);
    }
    const footerLines = [buildPanelLine(width, footerSegments)];

    if (this._confirm) {
      return buildPanelWorkspace(width, height, {
        title,
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this._confirm) }],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const flat = this._getFlat();

    if (this.autoScroll) {
      this.cursorIndex = Math.max(0, flat.length - 1);
    }

    if (flat.length === 0) {
      return buildPanelWorkspace(width, height, {
        title,
        intro: 'Inspect chronological tool activity, arguments, results, errors, and running calls — including calls made by delegated subagents.',
        sections: [
          {
            title: 'Calls',
            lines: buildEmptyState(
              width,
              this.records.length > 0 && this.filterMode !== 'all'
                ? ` No "${this.filterMode}" calls`
                : ' No tool calls yet',
              this.records.length > 0 && this.filterMode !== 'all'
                ? 'The active tool filter hides every recorded call.'
                : 'Tool executions appear here as the agent works, including calls made by delegated subagents. Expand a call to inspect its arguments and result payload.',
              this.records.length > 0 && this.filterMode !== 'all'
                ? [{ command: 'f', summary: 'cycle the tool filter back to all calls' }]
                : [{ command: '/spawn <task>', summary: 'run an agent to populate the tool-call timeline' }],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        footerLines,
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, Math.max(0, flat.length - 1)));
    const summary: PanelWorkspaceSection = {
      title: 'Summary',
      lines: [
        buildPanelLine(width, [
          [' Calls ', DEFAULT_PANEL_PALETTE.label],
          [String(this.records.length), DEFAULT_PANEL_PALETTE.value],
          ['   Running ', DEFAULT_PANEL_PALETTE.label],
          [String(running), running > 0 ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
          ['   Filter ', DEFAULT_PANEL_PALETTE.label],
          [this.filterMode === 'all' ? 'all' : this.filterMode, this.filterMode === 'all' ? DEFAULT_PANEL_PALETTE.dim : DEFAULT_PANEL_PALETTE.info],
        ]),
      ],
    };

    const selected = flat[this.cursorIndex];
    const detailLines: Line[] = [];
    if (selected?.kind === 'call') {
      const filtered = this.filterMode === 'all'
        ? this.records
        : this.records.filter(r => r.tool === this.filterMode);
      const rec = filtered[selected.recordIndex];
      if (rec) {
        detailLines.push(buildPanelLine(width, [[' Tool ', DEFAULT_PANEL_PALETTE.label], [rec.tool, DEFAULT_PANEL_PALETTE.info], ['   Started ', DEFAULT_PANEL_PALETTE.label], [shortTime(rec.execStartMs ?? rec.startMs), DEFAULT_PANEL_PALETTE.value]]));
        detailLines.push(buildPanelLine(width, [[' Status ', DEFAULT_PANEL_PALETTE.label], [statusLabel(rec), statusColor(rec)]]));
        detailLines.push(buildPanelLine(width, [
          [' Class ', DEFAULT_PANEL_PALETTE.label],
          [rec.outputClass ?? detectOutputClass(rec.tool, rec.args), DEFAULT_PANEL_PALETTE.warn],
          ['   Approved ', DEFAULT_PANEL_PALETTE.label],
          [rec.approved === undefined ? 'unknown' : rec.approved ? 'yes' : 'no', rec.approved === false ? DEFAULT_PANEL_PALETTE.bad : DEFAULT_PANEL_PALETTE.value],
        ]));
        if (rec.resultSummary) {
          detailLines.push(buildPanelLine(width, [[' Summary ', DEFAULT_PANEL_PALETTE.label], [rec.resultSummary, DEFAULT_PANEL_PALETTE.value]]));
        }
        if (rec.error) detailLines.push(buildPanelLine(width, [[' Error ', DEFAULT_PANEL_PALETTE.bad], [rec.error, DEFAULT_PANEL_PALETTE.value]]));
      }
    }

    const selectedSection: PanelWorkspaceSection = { title: 'Selected', lines: detailLines };
    const callsSection = resolveScrollablePanelSection(width, height, {
      intro: 'Inspect chronological tool activity, arguments, results, errors, and running calls — including calls made by delegated subagents.',
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summary],
      section: {
        title: 'Calls',
        scrollableLines: flat.map((row, index) => this._renderRow(width, row, index === this.cursorIndex)),
        selectedIndex: this.cursorIndex,
        scrollOffset: this.scrollOffset,
        minRows: 8,
      },
      afterSections: [selectedSection],
    });
    this.scrollOffset = callsSection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title,
      intro: 'Inspect chronological tool activity, arguments, results, errors, and running calls — including calls made by delegated subagents.',
      sections: [
        summary,
        callsSection.section,
        selectedSection,
      ],
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  private _renderRow(width: number, row: FlatRow, isCursor: boolean): Line {
    const bg = isCursor ? C.selectBg : '';
    if (row.kind === 'call') {
      return buildStyledPanelLine(width, [
        { text: isCursor ? '▸' : ' ', fg: C.selected, bg, bold: isCursor },
        { text: truncateDisplay(row.text, Math.max(0, width - 1)), fg: isCursor ? C.selected : C.toolFg, bg, bold: isCursor },
      ]);
    }
    return buildStyledPanelLine(width, [
      { text: '  ', fg: C.argsFg, bg },
      { text: truncateDisplay(row.text, Math.max(0, width - 2)), fg: row.isError ? C.bad : C.argsFg, bg },
    ]);
  }

  private _getFlat(): FlatRow[] {
    if (this._flatCache) return this._flatCache;
    const flat: FlatRow[] = [];
    const filtered = this.filterMode === 'all'
      ? this.records
      : this.records.filter(r => r.tool === this.filterMode);

    for (let i = 0; i < filtered.length; i++) {
      const rec = filtered[i]!;
      // Duration is measured from real execution start (TOOL_EXECUTING.startedAt) when
      // known, not from queue/receive time, so it reflects actual run time rather than
      // time spent waiting on permission/hook checks. Falls back to startMs for calls
      // that never reached TOOL_EXECUTING (e.g. denied before execution).
      const durBaseMs = rec.execStartMs ?? rec.startMs;
      const dur = rec.cancelled
        ? ` (cancelled${rec.endMs !== undefined ? ` ${formatMs(rec.endMs - durBaseMs)}` : ''})`
        : rec.endMs !== undefined ? ` (${formatMs(rec.endMs - durBaseMs)})` : ' (running)';
      const expand = rec.expanded ? ' ▾' : ' ▸';
      const ts = shortTime(rec.startMs);
      const cls = rec.outputClass ?? detectOutputClass(rec.tool, rec.args);
      const callText = `${ts} ${rec.tool} [${cls}]${dur}${expand}`;
      flat.push({ kind: 'call', recordIndex: i, text: callText });

      if (rec.expanded) {
        const argsStr = truncateJson(rec.args, 200);
        flat.push({ kind: 'detail', text: `Args: ${argsStr}`, isError: false });
        flat.push({ kind: 'detail', text: `Class: ${cls}${rec.approved === undefined ? '' : `  Approved: ${rec.approved ? 'yes' : 'no'}`}`, isError: false });
        if (rec.resultSummary) {
          flat.push({ kind: 'detail', text: `Summary: ${rec.resultSummary}`, isError: false });
        }
        if (rec.result !== undefined) {
          flat.push({ kind: 'detail', text: `Result: ${truncateJson(rec.result, 200)}`, isError: false });
        }
        if (rec.error) {
          flat.push({ kind: 'detail', text: `Error: ${rec.error}`, isError: true });
        }
      }
    }
    this._flatCache = flat;
    return flat;
  }

  private _toggleExpand(): void {
    const flat = this._getFlat();
    const row = flat[this.cursorIndex];
    if (!row || row.kind !== 'call') return;
    const rec = this.records.filter(r =>
      this.filterMode === 'all' ? true : r.tool === this.filterMode
    )[row.recordIndex];
    if (rec) {
      rec.expanded = !rec.expanded;
      this.markDirty();
    }
  }

  /** The tool-call record backing the currently-selected flat row, if any. */
  private _selectedRecord(): ToolCallRecord | undefined {
    const flat = this._getFlat();
    const row = flat[this.cursorIndex];
    if (!row || row.kind !== 'call') return undefined;
    const filtered = this.filterMode === 'all'
      ? this.records
      : this.records.filter(r => r.tool === this.filterMode);
    return filtered[row.recordIndex];
  }

  private _cycleFilter(): void {
    const tools = [...new Set(this.records.map(r => r.tool))];
    if (tools.length === 0) return;
    if (this.filterMode === 'all') {
      this.filterMode = tools[0]!;
    } else {
      const idx = tools.indexOf(this.filterMode);
      this.filterMode = idx >= tools.length - 1 ? 'all' : tools[idx + 1]!;
    }
    this.markDirty();
  }

  private _move(delta: number): void {
    const flat = this._getFlat();
    if (flat.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(flat.length - 1, this.cursorIndex + delta));
    this.markDirty();
  }

  private _attachBus(): void {
    if (this.unsubs.length > 0) return;

    this.unsubs.push(this.toolEvents.on('TOOL_RECEIVED', (data) => {
      if (this.records.length >= MAX_ENTRIES) {
        this.records.shift();
      }
      this.records.push({
        callId: data.callId,
        tool: data.tool,
        args: data.args,
        startMs: Date.now(),
        expanded: false,
        outputClass: detectOutputClass(data.tool, data.args),
      });
      this.autoScroll = true;
      this.markDirty();
    }));

    this.unsubs.push(this.toolEvents.on('TOOL_PERMISSIONED', (data) => {
      const rec = this.records.findLast(r => r.callId === data.callId);
      if (rec) rec.approved = data.approved;
      this.markDirty();
    }));

    // Real execution start — recorded separately from TOOL_RECEIVED's queue time so
    // displayed durations reflect actual run time, not time spent waiting on
    // permission/hook checks ahead of execution.
    this.unsubs.push(this.toolEvents.on('TOOL_EXECUTING', (data) => {
      const rec = this.records.findLast(r => r.callId === data.callId);
      if (rec) rec.execStartMs = data.startedAt;
      this.markDirty();
    }));

    // NOTE: After SDK OBS-05 (0.21.31), TOOL_SUCCEEDED/TOOL_FAILED.result is a ToolResultSummary
    // ({ kind, byteSize, preview? }) rather than the raw ToolResult object.
    this.unsubs.push(this.toolEvents.on('TOOL_SUCCEEDED', (data) => {
      const rec = this.records.findLast(r => r.callId === data.callId);
      if (rec) {
        rec.endMs = Date.now();
        rec.result = data.result;
        rec.resultSummary = summarizeResult(data.result);
      }
      this.markDirty();
    }));

    this.unsubs.push(this.toolEvents.on('TOOL_FAILED', (data) => {
      const rec = this.records.findLast(r => r.callId === data.callId);
      if (rec) {
        rec.endMs = Date.now();
        rec.result = data.result;
        rec.error = data.error;
        rec.resultSummary = summarizeResult(data.result) ?? data.error;
      }
      this.markDirty();
    }));

    // Terminal state for a cancelled call — without this subscription, a call
    // cancelled mid-flight (e.g. via Ctrl+C) never gets an endMs and shows as
    // "running" forever.
    this.unsubs.push(this.toolEvents.on('TOOL_CANCELLED', (data) => {
      const rec = this.records.findLast(r => r.callId === data.callId);
      if (rec) {
        rec.endMs = Date.now();
        rec.cancelled = true;
        rec.resultSummary = data.reason ?? 'cancelled';
      }
      this.markDirty();
    }));

    this.unsubs.push(this.turnEvents.on('TURN_ERROR', (data) => {
      // Mark any running calls as errored
      for (const rec of this.records) {
        if (rec.endMs === undefined) {
          rec.endMs = Date.now();
          rec.error = data.error ?? 'unknown error';
        }
      }
      this.markDirty();
    }));
  }

  private _detachBus(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }
}
