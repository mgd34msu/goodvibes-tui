/**
 * OpsControlPanel — operator control plane UI panel.
 *
 * Renders the ops audit log sourced from the OpsPanel diagnostics subscriber.
 * Each entry shows: seq, timestamp, action, target, outcome, and optional note.
 *
 * Requires the `operator-control-plane` feature flag to be enabled.
 * Open via Ctrl+O keybind or `/ops view` command.
 */
import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import type { OpsEvent } from '../runtime/events/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import type { OpsAuditEntry } from '../runtime/diagnostics/panels/ops.ts';
import { OpsPanel } from '../runtime/diagnostics/panels/ops.ts';
import { BasePanel } from './base-panel.ts';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types/grid';
import {
  buildEmptyState,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
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

export class OpsControlPanel extends BasePanel {
  private readonly _opsPanel: OpsPanel;
  private _unsub: (() => void) | null = null;
  private _scrollOffset = 0;

  public constructor(eventFeed: UiEventFeed<OpsEvent>) {
    super('ops-control', 'Ops Control', 'Q', 'agent');
    this._opsPanel = new OpsPanel(eventFeed);
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
    const entries = this._opsPanel.getSnapshot();
    const intro = 'Operator interventions, outcomes, and task or agent targets across the active control plane.';

    if (entries.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Operator Control Plane',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No operator interventions recorded.',
            'Actions like pause, retry, cancel, move, and approval decisions will appear here once the operator starts intervening in runtime workflows.',
            [{ command: '/cockpit', summary: 'open the cockpit and drive runtime interventions from the control rooms' }],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const reversed = [...entries].reverse();
    const entryRows: Line[] = [
      buildPanelLine(width, [['  SEQ  TIME      ACTION          TARGET             OUT    NOTE', C.label]]),
    ];
    for (const entry of reversed) {
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
      entryRows.push(buildPanelLine(width, segs));
    }
    const logSection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down scroll the intervention log', C.dim]])],
      palette: C,
      section: {
        title: 'Audit Log',
        scrollableLines: entryRows,
        scrollOffset: this._scrollOffset,
        minRows: 4,
        appendWindowSummary: {
          dimColor: C.label,
          formatter: (window) => buildPanelLine(width, [[` [${window.start + 1}-${window.end}/${window.total}] Up/Down to scroll`.slice(0, width), C.label]]),
        },
      },
    });
    this._scrollOffset = logSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [logSection.section];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Operator Control Plane',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down scroll the intervention log', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines;
  }
}
