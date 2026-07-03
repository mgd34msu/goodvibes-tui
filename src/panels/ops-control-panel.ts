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
import type { OpsApi, OpsEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import type { OpsAuditEntry } from '../runtime/diagnostics/panels/ops.ts';
import { OpsPanel } from '../runtime/diagnostics/panels/ops.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelPalette,
} from './polish.ts';

// ── Colour palette ──────────────────────────────────────────────────────────
// Domain accents only; base chrome (header/headerBg/dim/label/value/good/bad/
// warn/empty/selectBg) comes from DEFAULT_PANEL_PALETTE.
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  rejected:   '#f97316',   // rejected-outcome badge — distinct from success/error
  taskColor:  '#22d3ee',   // task-target tag
  agentColor: '#a78bfa',   // agent-target tag
} as const);

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
    case 'success':  return C.good;
    case 'rejected': return C.rejected;
    case 'error':    return C.bad;
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

// ── Operator intervention actions ───────────────────────────────────────────
// Target-entry mode: c/p/u/y act on the currently *selected* audit row's
// target (task or agent) rather than requiring a typed id, mirroring the
// `/ops task <action> <id>` / `/ops agent cancel <id>` slash commands.

type OpsAction = 'cancel' | 'pause' | 'resume' | 'retry';

interface OpsActionSubject {
  readonly action: OpsAction;
  readonly targetKind: OpsAuditEntry['targetKind'];
  readonly targetId: string;
}

const ACTION_VERB: Record<OpsAction, string> = {
  cancel: 'Cancel',
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Retry',
};

// ── OpsControlPanel ──────────────────────────────────────────────────────────

export class OpsControlPanel extends ScrollableListPanel<OpsAuditEntry> {
  private readonly _opsPanel: OpsPanel;
  private readonly _opsApi: OpsApi | undefined;
  private _unsub: (() => void) | null = null;
  private _confirm: ConfirmState<OpsActionSubject> | null = null;

  public constructor(eventFeed: UiEventFeed<OpsEvent>, opsApi?: OpsApi) {
    super('ops-control', 'Ops Control', '◓', 'runtime-ops');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter audit';
    this._opsPanel = new OpsPanel(eventFeed);
    this._opsApi = opsApi;
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

  // -------------------------------------------------------------------------
  // Input — target-entry mode dispatch (acts on the selected audit row)
  // -------------------------------------------------------------------------

  public override handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (this._confirm) {
      const result = handleConfirmInput(this._confirm, key);
      if (result === 'confirmed') {
        this._executeConfirmed(this._confirm.subject);
        this._confirm = null;
        this.markDirty();
        return true;
      }
      if (result === 'cancelled') {
        this._confirm = null;
        this.markDirty();
      }
      return true;
    }

    if (!this.filterActive) {
      switch (key) {
        case 'c': this._requestAction('cancel'); return true;
        case 'p': this._requestAction('pause'); return true;
        case 'u': this._requestAction('resume'); return true;
        case 'y': this._requestAction('retry'); return true;
        default: break;
      }
    }

    return super.handleInput(key);
  }

  private _requestAction(action: OpsAction): void {
    const selected = this.getSelectedItem();
    if (!selected) return;
    if (action !== 'cancel' && selected.targetKind === 'agent') {
      this.setError(`Only cancel is supported for agent targets ("${action}" is task-only).`);
      return;
    }
    this._confirm = {
      subject: { action, targetKind: selected.targetKind, targetId: selected.targetId },
      label: `${selected.targetKind} ${selected.targetId}`,
      verb: ACTION_VERB[action],
    };
    this.markDirty();
  }

  private _executeConfirmed(subject: OpsActionSubject): void {
    if (!this._opsApi) {
      this.setError('Ops API is not wired for this runtime.');
      return;
    }
    try {
      if (subject.targetKind === 'agent') {
        this._opsApi.agents.cancel(subject.targetId);
      } else {
        switch (subject.action) {
          case 'cancel': this._opsApi.tasks.cancel(subject.targetId); break;
          case 'pause':  this._opsApi.tasks.pause(subject.targetId); break;
          case 'resume': this._opsApi.tasks.resume(subject.targetId); break;
          case 'retry':  this._opsApi.tasks.retry(subject.targetId); break;
        }
      }
    } catch (err) {
      // Dispatched actions re-appear as OPS_AUDIT rows regardless of legality
      // (OpsControlPlane audits rejections too); this surfaces the rare case
      // where the target vanished before the audit event was emitted.
      this.setError(summarizeError(err));
    }
  }

  /** Live posture: tasks currently eligible for intervention, independent of the audit log. */
  private _postureCounts(): { running: number; blocked: number; retryable: number } {
    const tasks = this._opsApi?.tasks.snapshot().tasks ?? [];
    let running = 0;
    let blocked = 0;
    let retryable = 0;
    for (const task of tasks) {
      if (task.status === 'running') running++;
      else if (task.status === 'blocked') blocked++;
      else if (task.status === 'failed' || task.status === 'cancelled') retryable++;
    }
    return { running, blocked, retryable };
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
      [` ${seqStr} `, C.dim],
      [`${timeStr} `, C.dim],
      [`${action} `, C.value],
      [`${target}  `, targetColor(entry.targetKind)],
      [outLabel, outcomeColor(entry.outcome)],
    ];
    if (noteRaw) segs.push([` ${noteRaw}`, C.warn]);
    return buildPanelLine(width, segs);
  }

  protected override getEmptyStateMessage(): string {
    return ' No operator interventions recorded.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    // No signpost — the live posture row in the header (running/blocked/retryable
    // task counts) already tells the operator whether there is anything to act on.
    return [];
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

    const posture = this._postureCounts();

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'logged', value: String(entries.length), valueColor: entries.length > 0 ? C.value : C.dim },
        { label: 'ok', value: String(ok), valueColor: ok > 0 ? C.good : C.dim },
        { label: 'rejected', value: String(rejected), valueColor: rejected > 0 ? C.rejected : C.dim },
        { label: 'errors', value: String(errored), valueColor: errored > 0 ? C.bad : C.dim },
      ], C),
      buildKeyValueLine(width, [
        { label: 'running', value: String(posture.running), valueColor: posture.running > 0 ? C.warn : C.dim },
        { label: 'blocked', value: String(posture.blocked), valueColor: posture.blocked > 0 ? C.warn : C.dim },
        { label: 'retryable', value: String(posture.retryable), valueColor: posture.retryable > 0 ? C.info : C.dim },
      ], C),
      buildPanelLine(width, [['  SEQ  TIME      ACTION          TARGET             OUT    NOTE', C.label]]),
    ];

    const selected = this.getSelectedItem();
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
          [truncateDisplay(detail, Math.max(0, width - 4)), C.warn],
        ]),
      );
    }
    if (this._confirm) {
      footerLines.push(...renderConfirmLines(width, this._confirm));
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
            { keys: 'c/p/u/y', label: 'cancel/pause/resume/retry selected' },
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
