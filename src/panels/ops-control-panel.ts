/**
 * OpsControlPanel — operator control plane UI panel.
 *
 * Renders the ops audit log sourced from the OpsPanel diagnostics subscriber.
 * Each entry shows: seq, timestamp, action, target, outcome, and optional note.
 *
 * Requires the `operator-control-plane` feature flag to be enabled.
 * Open via Ctrl+O keybind or `/ops view` command.
 */
import type { Line } from '../types/grid.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import type { OpsEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import type { OpsAuditEntry } from '../runtime/diagnostics/panels/ops.ts';
import { OpsPanel } from '../runtime/diagnostics/panels/ops.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';

// ── Colour palette ──────────────────────────────────────────────────────────
const C = {
  ...DEFAULT_PANEL_PALETTE,
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
  selectBg:   '#0f172a',
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

// ── OpsControlPanel ──────────────────────────────────────────────────────────

export class OpsControlPanel extends ScrollableListPanel<OpsAuditEntry> {
  private readonly _opsPanel: OpsPanel;
  private _unsub: (() => void) | null = null;

  public constructor(eventFeed: UiEventFeed<OpsEvent>) {
    super('ops-control', 'Ops Control', 'Q', 'agent');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter audit';
    this._opsPanel = new OpsPanel(eventFeed);
    this._unsub = this._opsPanel.subscribe(() => this.markDirty());
  }

  public override onActivate(): void {
    super.onActivate();
    this.selectedIndex = 0;
  }

  public override onDestroy(): void {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this._opsPanel.dispose();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly OpsAuditEntry[] {
    // Return reversed so newest entries appear at top
    return [...this._opsPanel.getSnapshot()].reverse();
  }

  protected override filterMatches(entry: OpsAuditEntry, q: string): boolean {
    return entry.action.toLowerCase().includes(q)
      || entry.targetKind.toLowerCase().includes(q)
      || entry.targetId.toLowerCase().includes(q)
      || entry.outcome.toLowerCase().includes(q);
  }

  protected renderItem(entry: OpsAuditEntry, _index: number, _selected: boolean, width: number): Line {
    const seqStr   = String(entry.seq).padStart(4, ' ');
    const timeStr  = fmtTime(entry.ts);
    const action   = fitDisplay(entry.action, 15);
    const kindTag  = entry.targetKind === 'task' ? 'T:' : 'A:';
    // Last 10 chars of the id keep the unique suffix; fitDisplay caps display width.
    const shortId  = entry.targetId.slice(-10);
    const target   = fitDisplay(kindTag + shortId, 14);
    const outLabel = outcomeLabel(entry.outcome);
    const noteRaw  = truncateDisplay(entry.note ?? entry.errorMessage ?? '', Math.max(0, width - 63));

    const segs: Array<[string, string, string?]> = [
      [` ${seqStr} `, C.seq],
      [`${timeStr} `, C.dim],
      [`${action} `, C.value],
      [`${target}  `, targetColor(entry.targetKind)],
      [outLabel, outcomeColor(entry.outcome)],
    ];
    if (noteRaw) segs.push([` ${noteRaw}`, C.note]);
    return buildPanelLine(width, segs);
  }

  protected override getEmptyStateMessage(): string {
    return ' No operator interventions recorded.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [{ command: '/cockpit', summary: 'open the cockpit and drive runtime interventions from the control rooms' }];
  }

  public render(width: number, height: number): Line[] {
    const entries = this.getVisibleItems();
    this.clampSelection();

    // Outcome tallies surface posture at a glance (most important runtime info first).
    let ok = 0;
    let rejected = 0;
    let errored = 0;
    for (const e of entries) {
      if (e.outcome === 'success') ok++;
      else if (e.outcome === 'rejected') rejected++;
      else errored++;
    }

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'logged', value: String(entries.length), valueColor: entries.length > 0 ? C.value : C.dim },
        { label: 'ok', value: String(ok), valueColor: ok > 0 ? C.success : C.dim },
        { label: 'rejected', value: String(rejected), valueColor: rejected > 0 ? C.rejected : C.dim },
        { label: 'errors', value: String(errored), valueColor: errored > 0 ? C.error : C.dim },
      ], C),
      buildPanelLine(width, [['  SEQ  TIME      ACTION          TARGET             OUT    NOTE', C.label]]),
    ];

    const selected = entries[this.selectedIndex];
    const footerLines: Line[] = [];
    if (selected) {
      const detail = selected.note ?? selected.errorMessage ?? '(no note)';
      footerLines.push(
        buildPanelLine(width, [
          ['  #', C.label],
          [String(selected.seq), C.value],
          ['  ', C.dim],
          [outcomeLabel(selected.outcome).trim(), outcomeColor(selected.outcome)],
          ['  ', C.dim],
          [selected.action, C.value],
          ['  ', C.dim],
          [`${selected.targetKind}:${selected.targetId}`, targetColor(selected.targetKind)],
        ]),
        buildPanelLine(width, [
          ['  ', C.label],
          [truncateDisplay(detail, Math.max(0, width - 4)), C.note],
        ]),
      );
    }
    footerLines.push(
      this.filterActive
        ? buildKeyboardHints(width, [
            { keys: 'type', label: 'filter audit' },
            { keys: 'Enter', label: 'apply' },
            { keys: 'Esc', label: 'clear' },
          ], C)
        : buildKeyboardHints(width, [
            { keys: 'Up/Down', label: 'browse log' },
            { keys: '/', label: 'filter' },
          ], C),
    );

    return this.renderList(width, height, {
      title: 'Operator Control Plane',
      header: headerLines,
      footer: footerLines,
    });
  }
}
