import type { Line, Cell } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.ts';
import type { PolicyPanelSnapshot } from '../runtime/diagnostics/panels/policy.ts';

const C = {
  header: '#94a3b8',
  headerBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#475569',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  info: '#38bdf8',
  empty: '#334155',
} as const;

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

function fmtTime(value: string | undefined): string {
  if (!value) return 'n/a';
  return value.replace('T', ' ').slice(0, 19);
}

function fmtRate(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function gateColor(status: string | undefined): string {
  switch (status) {
    case 'allowed':
      return C.ok;
    case 'blocked':
      return C.error;
    case 'no_data':
      return C.warn;
    default:
      return C.dim;
  }
}

export class PolicyPanel extends BasePanel {
  private readonly _state: PolicyRuntimeState;
  private readonly _unsub: (() => void) | null;
  private _scrollOffset = 0;

  public constructor(state: PolicyRuntimeState) {
    super('policy', 'Policy', 'U', 'monitoring');
    this._state = state;
    this._unsub = state.subscribe(() => this.markDirty());
  }

  public override onActivate(): void {
    super.onActivate();
    this._scrollOffset = 0;
  }

  public override onDestroy(): void {
    this._unsub?.();
  }

  public handleInput(key: string): boolean {
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
    if (key === 'r') {
      this._state.recordTrendEntry();
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];
    const snapshot = this._state.getSnapshot();

    lines.push(buildLine(width, [[' Policy And Governance', C.header, C.headerBg]]));

    const content = this._buildContent(width, snapshot);
    const bodyHeight = Math.max(0, height - 1);
    const maxScroll = Math.max(0, content.length - bodyHeight);
    const offset = Math.min(this._scrollOffset, maxScroll);
    const visible = content.slice(offset, offset + bodyHeight);
    lines.push(...visible);

    while (lines.length < height) {
      lines.push(createEmptyLine(width));
    }
    return lines.slice(0, height);
  }

  private _buildContent(width: number, snapshot: PolicyPanelSnapshot): Line[] {
    const lines: Line[] = [];
    const current = snapshot.current;
    const candidate = snapshot.candidate;
    const divergence = snapshot.divergence;

    if (!current && !candidate) {
      lines.push(buildLine(width, [[' No policy bundles loaded. Use /policy load to begin.', C.empty]]));
      return lines;
    }

    lines.push(buildLine(width, [[' Current', C.label]]));
    if (current) {
      lines.push(buildLine(width, [
        ['  Bundle: ', C.label],
        [current.bundle.bundleId, C.value],
        ['  State: ', C.label],
        [current.state, C.info],
      ]));
      lines.push(buildLine(width, [
        ['  Loaded: ', C.label],
        [fmtTime(current.loadedAt), C.dim],
        ['  Active: ', C.label],
        [fmtTime(current.activatedAt), C.dim],
      ]));
    } else {
      lines.push(buildLine(width, [['  No active policy bundle.', C.empty]]));
    }

    lines.push(buildLine(width, [[' Candidate', C.label]]));
    if (candidate) {
      lines.push(buildLine(width, [
        ['  Bundle: ', C.label],
        [candidate.bundle.bundleId, C.value],
        ['  State: ', C.label],
        [candidate.state, C.info],
      ]));
      lines.push(buildLine(width, [
        ['  Loaded: ', C.label],
        [fmtTime(candidate.loadedAt), C.dim],
        ['  Rules: ', C.label],
        [String(candidate.rules.length), C.value],
      ]));
    } else {
      lines.push(buildLine(width, [['  No candidate bundle loaded.', C.empty]]));
    }

    lines.push(buildLine(width, [[' Diff', C.label]]));
    if (snapshot.diff) {
      lines.push(buildLine(width, [
        ['  Changes: ', C.label],
        [String(snapshot.diff.totalChanges), C.value],
        ['  Added: ', C.label],
        [String(snapshot.diff.added.length), C.ok],
        ['  Removed: ', C.label],
        [String(snapshot.diff.removed.length), C.error],
        ['  Changed: ', C.label],
        [String(snapshot.diff.changed.length), C.warn],
      ]));
    } else {
      lines.push(buildLine(width, [['  No diff available.', C.empty]]));
    }

    lines.push(buildLine(width, [[' Governance Gate', C.label]]));
    if (divergence) {
      lines.push(buildLine(width, [
        ['  Mode: ', C.label],
        [divergence.mode, C.info],
        ['  Gate: ', C.label],
        [divergence.gate.status, gateColor(divergence.gate.status)],
        ['  Divergence: ', C.label],
        [fmtRate(divergence.gate.divergenceRate ?? divergence.report.overall.divergenceRate), C.value],
      ]));
      lines.push(buildLine(width, [
        ['  Evaluations: ', C.label],
        [String(divergence.report.overall.totalEvaluations), C.value],
        ['  Trend points: ', C.label],
        [String(divergence.trend.length), C.value],
      ]));
    } else {
      lines.push(buildLine(width, [['  No active simulation dashboard.', C.empty]]));
    }

    lines.push(buildLine(width, [[' History', C.label]]));
    if (snapshot.history.length === 0) {
      lines.push(buildLine(width, [['  No historical bundles retained.', C.empty]]));
    } else {
      for (const version of snapshot.history.slice(0, 5)) {
        lines.push(buildLine(width, [
          ['  ', C.label],
          [version.bundle.bundleId, C.value],
          ['  ', C.label],
          [version.state, C.dim],
          ['  ', C.label],
          [fmtTime(version.activatedAt ?? version.loadedAt), C.dim],
        ]));
      }
    }

    lines.push(buildLine(width, [['  /policy opens this panel. Press r to record a divergence trend snapshot.', C.dim]]));
    return lines;
  }
}
