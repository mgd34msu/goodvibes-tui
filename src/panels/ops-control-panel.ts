/**
 * OpsControlPanel — Operator Control Plane UI panel (Section 5.1).
 *
 * Renders the ops audit log sourced from the OpsPanel diagnostics subscriber.
 * Each entry shows: seq, timestamp, action, target, outcome, and optional note.
 *
 * Requires the `operator-control-plane` feature flag to be enabled.
 * Open via Ctrl+O keybind or `/ops view` command.
 */
import type { Line, Cell } from '../types/grid.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { OpsAuditEntry } from '../runtime/diagnostics/panels/ops.ts';
import { OpsPanel } from '../runtime/diagnostics/panels/ops.ts';
import { BasePanel } from './base-panel.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';

// ── Colour palette ──────────────────────────────────────────────────────────
const C = {
  header:     '#94a3b8',
  headerBg:   '#1e293b',
  success:    '#22c55e',
  rejected:   '#f97316',
  error:      '#ef4444',
  dim:        '#4b5563',
  label:      '#64748b',
  value:      '#cbd5e1',
  note:       '#eab308',
  seq:        '#475569',
  taskColor:  '#22d3ee',
  agentColor: '#a78bfa',
  empty:      '#334155',
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function outcomeColor(outcome: OpsAuditEntry['outcome']): string {
  switch (outcome) {
    case 'success':  return C.success;
    case 'rejected': return C.rejected;
    case 'error':    return C.error;
  }
}

function outcomeLabel(outcome: OpsAuditEntry['outcome']): string {
  switch (outcome) {
    case 'success':  return 'OK    ';
    case 'rejected': return 'REJECT';
    case 'error':    return 'ERR   ';
  }
}

function targetColor(kind: OpsAuditEntry['targetKind']): string {
  return kind === 'task' ? C.taskColor : C.agentColor;
}

/** Build a Line from a sequence of [text, fg, bg?] segments, padded to width. */
function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  let used = 0;
  for (const [text, fg, bg] of segments) {
    cells.push(createStyledCell(text, { fg, bg: bg ?? '' }));
    used += text.length;
  }
  if (used < width) {
    cells.push(createStyledCell(' '.repeat(width - used), { fg: '' }));
  }
  return cells;
}

// ── OpsControlPanel ──────────────────────────────────────────────────────────

export class OpsControlPanel extends BasePanel {
  private readonly _opsPanel: OpsPanel;
  private _unsub: (() => void) | null = null;
  private _scrollOffset = 0;

  public constructor(eventBus: RuntimeEventBus) {
    super('ops-control', 'Ops Control', 'Q', 'agent');
    this._opsPanel = new OpsPanel(eventBus);
    this._unsub = this._opsPanel.subscribe(() => this.markDirty());
  }

  public override onActivate(): void {
    super.onActivate();
    this._scrollOffset = 0;
  }

  public handleInput(key: string): boolean {
    if (key === 'up' || key === 'k') { this._scrollOffset = Math.max(0, this._scrollOffset - 1); return true; }
    if (key === 'down' || key === 'j') { this._scrollOffset++; return true; }
    return false;
  }

  public override onDestroy(): void {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this._opsPanel.dispose();
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];

    // Header
    const title = ' Operator Control Plane';
    const pad = Math.max(0, width - title.length);
    lines.push(buildLine(width, [[title + ' '.repeat(pad), C.header, C.headerBg]]));

    // Column headers
    const colHdr = ' SEQ  TIME      ACTION          TARGET             OUT    NOTE';
    lines.push(buildLine(width, [[colHdr.slice(0, width), C.label]]));

    const entries = this._opsPanel.getSnapshot();
    const bodyHeight = Math.max(1, height - 2);

    if (entries.length === 0) {
      lines.push(buildLine(width, [[' No operator interventions recorded.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    // Newest first with scroll
    const reversed = [...entries].reverse();
    const maxScroll = Math.max(0, reversed.length - bodyHeight);
    const offset = Math.min(this._scrollOffset, maxScroll);
    const visible = reversed.slice(offset, offset + bodyHeight);

    for (const entry of visible) {
      const seqStr   = String(entry.seq).padStart(4, ' ');
      const timeStr  = fmtTime(entry.ts);
      const action   = entry.action.slice(0, 15).padEnd(15, ' ');
      const kindTag  = entry.targetKind === 'task' ? 'T:' : 'A:';
      // Truncation is intentional: TUI column width limits target ID display to 14 chars
      const shortId  = entry.targetId.slice(-10);
      const target   = (kindTag + shortId).slice(0, 14).padEnd(14, ' ');
      const outLabel = outcomeLabel(entry.outcome);
      const noteRaw  = (entry.note ?? entry.errorMessage ?? '').slice(0, Math.max(0, width - 63));

      const segs: Array<[string, string, string?]> = [
        [` ${seqStr} `, C.seq],
        [`${timeStr} `, C.dim],
        [`${action} `, C.value],
        [`${target}  `, targetColor(entry.targetKind)],
        [outLabel, outcomeColor(entry.outcome)],
      ];
      if (noteRaw) segs.push([` ${noteRaw}`, C.note]);
      lines.push(buildLine(width, segs));
    }

    // Scroll indicator
    if (maxScroll > 0) {
      const lo = offset + 1;
      const hi = Math.min(offset + bodyHeight, reversed.length);
      const indicator = ` [${lo}-${hi}/${reversed.length}] ↑/↓ to scroll`;
      lines[lines.length - 1] = buildLine(width, [[indicator.slice(0, width), C.label]]);
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines;
  }
}
