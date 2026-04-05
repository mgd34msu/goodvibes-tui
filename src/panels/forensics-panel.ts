/**
 * ForensicsPanel — failure forensics TUI panel.
 *
 * Displays the most recent failure reports with auto-classified causes,
 * causal chains, phase timings, and jump links to related panels.
 *
 * Open via /forensics or the panel picker.
 */
import type { Line, Cell } from '../types/grid.ts';
import type { ForensicsRegistry } from '../runtime/forensics/registry.ts';
import type { FailureReport, CausalChainEntry, PhaseTimingEntry } from '../runtime/forensics/types.ts';
import { ForensicsDataPanel } from '../runtime/diagnostics/panels/forensics.ts';
import { BasePanel } from './base-panel.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  header:          '#94a3b8',
  headerBg:        '#1e293b',
  reportId:        '#475569',
  timestamp:       '#64748b',
  classification:  '#f97316',
  classOk:         '#22c55e',
  classCancelled:  '#94a3b8',
  classError:      '#ef4444',
  classWarn:       '#eab308',
  summaryText:     '#cbd5e1',
  label:           '#64748b',
  value:           '#e2e8f0',
  chainRoot:       '#f97316',
  chainEntry:      '#94a3b8',
  phaseOk:         '#22c55e',
  phaseFail:       '#ef4444',
  phasePending:    '#64748b',
  jumpLink:        '#38bdf8',
  separator:       '#1e293b',
  dim:             '#334155',
  empty:           '#4b5563',
} as const;

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return '?ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function classificationColor(cls: FailureReport['classification']): string {
  switch (cls) {
    case 'cancelled':        return C.classCancelled;
    case 'max_tokens':       return C.classWarn;
    case 'unknown':          return C.classWarn;
    case 'llm_error':        return C.classError;
    case 'tool_failure':     return C.classError;
    case 'permission_denied':return C.classError;
    case 'cascade_failure':  return C.classError;
    case 'turn_timeout':     return C.classError;
    case 'compaction_error': return C.classError;
    default:                 return C.classification;
  }
}

/** Build a Line from a sequence of [text, fg, bg?] segments. */
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

function buildSeparator(width: number): Line {
  return buildLine(width, [['─'.repeat(width), C.separator]]);
}

// ── ForensicsPanel ────────────────────────────────────────────────────────────

export class ForensicsPanel extends BasePanel {
  private readonly _data: ForensicsDataPanel;
  private _unsub: (() => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/prefer-readonly -- mutated in _renderDetail via direct assignment
  private _scrollOffset = 0;
  /** Index of the selected report in the all-reports list (newest-first). */
  private _selectedIndex = 0;
  /** View mode: 'list' shows report list; 'detail' shows a single report expanded. */
  private _mode: 'list' | 'detail' = 'list';

  public constructor(registry: ForensicsRegistry) {
    super('forensics', 'Forensics', 'F', 'monitoring');
    this._data = new ForensicsDataPanel(registry);
    this._unsub = this._data.subscribe(() => this.markDirty());
  }

  public override onActivate(): void {
    super.onActivate();
    this._scrollOffset = 0;
    this._selectedIndex = 0;
    this._mode = 'list';
  }

  public handleInput(key: string): boolean {
    if (this._mode === 'list') {
      if (key === 'up' || key === 'k') {
        this._selectedIndex = Math.max(0, this._selectedIndex - 1);
        this.markDirty();
        return true;
      }
      if (key === 'down' || key === 'j') {
        const count = this._data.getAll().length;
        this._selectedIndex = Math.min(count - 1, this._selectedIndex + 1);
        this.markDirty();
        return true;
      }
      if (key === 'return' || key === 'enter') {
        this._mode = 'detail';
        this._scrollOffset = 0;
        this.markDirty();
        return true;
      }
    } else {
      if (key === 'escape' || key === 'q') {
        this._mode = 'list';
        this.markDirty();
        return true;
      }
      if (key === 'up' || key === 'k') {
        this._scrollOffset = Math.max(0, this._scrollOffset - 1);
        this.markDirty();
        return true;
      }
      if (key === 'down' || key === 'j') {
        this._scrollOffset++;
        this.markDirty();
        return true;
      }
    }
    return false;
  }

  public override onDestroy(): void {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this._data.dispose();
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];

    // Panel header
    const titleText = ' Failure Forensics';
    const pad = Math.max(0, width - titleText.length);
    lines.push(buildLine(width, [[titleText + ' '.repeat(pad), C.header, C.headerBg]]));

    const reports = this._data.getAll();

    if (reports.length === 0) {
      lines.push(buildLine(width, [[' No failure reports. All systems nominal.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    if (this._mode === 'list') {
      this._renderList(lines, reports, width, height);
    } else {
      const report = reports[this._selectedIndex];
      if (report) {
        this._renderDetail(lines, report, width, height);
      } else {
        this._mode = 'list';
        this._renderList(lines, reports, width, height);
      }
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines;
  }

  // ── List view ──────────────────────────────────────────────────────────────

  private _renderList(lines: Line[], reports: FailureReport[], width: number, height: number): void {
    // Column headers
    const colHdr = ' ID       TIME      CLASS                 SUMMARY';
    lines.push(buildLine(width, [[colHdr.slice(0, width), C.label]]));

    const bodyHeight = Math.max(1, height - 2);
    const maxScroll = Math.max(0, reports.length - bodyHeight);
    const offset = Math.min(this._selectedIndex > bodyHeight - 1 ? this._selectedIndex - bodyHeight + 1 : 0, maxScroll);
    const visible = reports.slice(offset, offset + bodyHeight);

    for (let i = 0; i < visible.length; i++) {
      const report = visible[i]!;
      const absIdx = offset + i;
      const isSelected = absIdx === this._selectedIndex;
      const bg = isSelected ? '#1e3a5f' : '';

      const idStr   = report.id.slice(0, 8).padEnd(8, ' ');
      const timeStr = fmtTime(report.generatedAt);
      const cls     = report.classification.slice(0, 20).padEnd(20, ' ');
      const clsColor = classificationColor(report.classification);
      const summaryMax = Math.max(0, width - 42);
      const summaryStr = report.summary.slice(0, summaryMax);

      const segs: Array<[string, string, string?]> = [
        [isSelected ? '▶' : ' ', C.jumpLink, bg],
        [`${idStr} `, C.reportId, bg],
        [`${timeStr} `, C.timestamp, bg],
        [`${cls} `, clsColor, bg],
        [summaryStr, C.summaryText, bg],
      ];
      lines.push(buildLine(width, segs));
    }

    if (reports.length > 0) {
      const hint = ` [${this._selectedIndex + 1}/${reports.length}] ↑/↓ navigate  Enter expand`;
      const hintLine = buildLine(width, [[hint.slice(0, width), C.label]]);
      // Replace last visible line if it's the last slot, else append footer
      if (lines.length < height) {
        lines.push(hintLine);
      } else {
        lines[lines.length - 1] = hintLine;
      }
    }
  }

  // ── Detail view ────────────────────────────────────────────────────────────

  private _renderDetail(lines: Line[], report: FailureReport, width: number, height: number): void {
    const detailLines: Line[] = [];

    // Report header
    const hdr = ` Report ${report.id}  ${fmtTime(report.generatedAt)}`;
    detailLines.push(buildLine(width, [[hdr, C.header, C.headerBg]]));
    detailLines.push(buildSeparator(width));

    // Classification + summary
    detailLines.push(buildLine(width, [
      [' Class:   ', C.label],
      [report.classification, classificationColor(report.classification)],
    ]));
    detailLines.push(buildLine(width, [
      [' Summary: ', C.label],
      [report.summary.slice(0, width - 11), C.summaryText],
    ]));

    if (report.errorMessage) {
      detailLines.push(buildLine(width, [
        [' Error:   ', C.label],
        [report.errorMessage.slice(0, width - 11), C.classError],
      ]));
    }
    if (report.stopReason) {
      detailLines.push(buildLine(width, [
        [' Stop:    ', C.label],
        [report.stopReason, C.classWarn],
      ]));
    }
    if (report.taskId) {
      detailLines.push(buildLine(width, [[` Task:    ${report.taskId}`, C.value]]));
    }
    if (report.turnId) {
      detailLines.push(buildLine(width, [[` Turn:    ${report.turnId}`, C.value]]));
    }

    detailLines.push(buildSeparator(width));

    // Phase timings
    if (report.phaseTimings.length > 0) {
      detailLines.push(buildLine(width, [[' Phase Timings:', C.label]]));
      for (const pt of report.phaseTimings) {
        this._renderPhase(detailLines, pt, width);
      }
      detailLines.push(buildSeparator(width));
    }

    // Causal chain
    if (report.causalChain.length > 0) {
      detailLines.push(buildLine(width, [[' Causal Chain:', C.label]]));
      for (const entry of report.causalChain) {
        this._renderCausal(detailLines, entry, width);
      }
      detailLines.push(buildSeparator(width));
    }

    // Jump links
    if (report.jumpLinks.length > 0) {
      detailLines.push(buildLine(width, [[' Jump Links:', C.label]]));
      for (const link of report.jumpLinks) {
        const kindTag = link.kind === 'panel' ? '[panel]' : '[cmd]  ';
        detailLines.push(buildLine(width, [
          ['  ', C.dim],
          [kindTag, C.timestamp],
          [` ${link.label}`, C.jumpLink],
          [link.args ? ` (${link.args})` : '', C.dim],
        ]));
      }
    }

    detailLines.push(buildLine(width, [[' Esc/q: back to list  ↑/↓: scroll', C.dim]]));

    // Apply scroll
    const bodyHeight = Math.max(1, height - 1); // account for panel header already in `lines`
    const maxScroll = Math.max(0, detailLines.length - bodyHeight);
    const offset = Math.min(this._scrollOffset, maxScroll);
    this._scrollOffset = offset;

    const visible = detailLines.slice(offset, offset + bodyHeight);
    for (const l of visible) lines.push(l);
  }

  private _renderPhase(lines: Line[], pt: PhaseTimingEntry, width: number): void {
    const statusChar = pt.success ? '✓' : '✗';
    const statusColor = pt.success ? C.phaseOk : C.phaseFail;
    const dur = fmtDuration(pt.durationMs);
    const phaseLabel = pt.phase.slice(0, 14).padEnd(14, ' ');
    const errPart = pt.error ? `  ${pt.error.slice(0, Math.max(0, width - 32))}` : '';
    lines.push(buildLine(width, [
      ['  ', C.dim],
      [statusChar + ' ', statusColor],
      [phaseLabel, C.value],
      [dur.padStart(6, ' '), C.timestamp],
      [errPart, C.classError],
    ]));
  }

  private _renderCausal(lines: Line[], entry: CausalChainEntry, width: number): void {
    const prefix = entry.isRootCause ? '  ● ' : '  · ';
    const color = entry.isRootCause ? C.chainRoot : C.chainEntry;
    const timeStr = fmtTime(entry.ts);
    const descMax = Math.max(0, width - prefix.length - 9);
    lines.push(buildLine(width, [
      [prefix, color],
      [`${timeStr} `, C.timestamp],
      [entry.description.slice(0, descMax), color],
    ]));
  }
}
