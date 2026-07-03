import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { BasePanel } from './base-panel.ts';
import type {
  PolicyRuntimeState,
  PolicyBundleVersion,
  PolicyDiffResult,
  DivergenceDashboardSnapshot,
  DivergenceStats,
  PermissionAuditEntry,
  PolicyLintFinding,
  PolicySimulationSummary,
  PolicyPreflightReview,
} from '@/runtime/index.ts';
import {
  buildEmptyState,
  buildKeyboardHints,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import type { PanelIntegrationContext } from './types.ts';

// Base chrome only — no domain accents needed; the title band, state colors,
// and text tokens all come straight from DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

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
      return C.good;
    case 'blocked':
      return C.bad;
    case 'no_data':
      return C.warn;
    default:
      return C.dim;
  }
}

/**
 * A point-in-time snapshot of policy state for diagnostics rendering.
 */
interface PolicyPanelSnapshot {
  /** The currently enforced bundle, or null if no policy is active. */
  current: PolicyBundleVersion | null;
  /** The pending candidate bundle, or null if none loaded. */
  candidate: PolicyBundleVersion | null;
  /** History of previous active bundles (most recent first). */
  history: PolicyBundleVersion[];
  /** Diff between current and candidate, or null if unavailable. */
  diff: PolicyDiffResult | null;
  /** Divergence dashboard snapshot, or null if no panel attached. */
  divergence: DivergenceDashboardSnapshot | null;
  /** Recent permission requests and decisions for operator audit review. */
  recentPermissionAudit: readonly PermissionAuditEntry[];
  /** Policy lint findings for current and candidate bundles. */
  lintFindings: readonly PolicyLintFinding[];
  /** Concrete scenario results from the most recent policy simulation run. */
  lastSimulationSummary: PolicySimulationSummary | null;
  /** Most recent proactive policy preflight review. */
  lastPreflightReview: PolicyPreflightReview | null;
  /** ISO 8601 timestamp of when this snapshot was captured. */
  capturedAt: string;
}

/** Subactions dispatched through `/policy <name>` via `dispatchPolicyCommand`. */
type PolicyDispatchAction = 'simulate' | 'preflight' | 'lint' | 'promote' | 'rollback';

export class PolicyPanel extends BasePanel {
  private readonly _state: PolicyRuntimeState;
  private readonly _unsub: (() => void) | null;
  private _scrollOffset = 0;

  // Inline confirm for the gate-aware promote/rollback actions.
  private _confirm: ConfirmState<PolicyDispatchAction> | null = null;

  // Pending dispatch resolved via handlePanelIntegrationAction, which is the
  // only place `executeCommand` is available (mirrors IncidentReviewPanel).
  private _pendingAction: PolicyDispatchAction | null = null;

  public constructor(state: PolicyRuntimeState) {
    super('policy', 'Policy', '▭', 'security-policy');
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
    if (this._confirm) {
      const outcome = handleConfirmInput(this._confirm, key);
      if (outcome === 'confirmed') {
        this._pendingAction = this._confirm.subject;
        this._confirm = null;
        this.markDirty();
        return true;
      }
      if (outcome === 'cancelled') {
        this._confirm = null;
        this.markDirty();
        return true;
      }
      return true; // absorbed — keep the confirm dialog pending
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
    if (key === 's') {
      this._pendingAction = 'simulate';
      return true;
    }
    if (key === 'f') {
      this._pendingAction = 'preflight';
      return true;
    }
    if (key === 'l') {
      this._pendingAction = 'lint';
      return true;
    }
    if (key === 'p') {
      const snapshot = this._state.getSnapshot();
      if (!snapshot.candidate) return false;
      const gateStatus = snapshot.divergence?.gate.status ?? 'no_data';
      this._confirm = {
        subject: 'promote',
        label: `promote ${snapshot.candidate.bundle.bundleId} (gate: ${gateStatus})`,
        verb: 'Promote',
      };
      this.markDirty();
      return true;
    }
    if (key === 'b') {
      const snapshot = this._state.getSnapshot();
      if (!snapshot.current) return false;
      this._confirm = {
        subject: 'rollback',
        label: `rollback active bundle ${snapshot.current.bundle.bundleId}`,
        verb: 'Rollback',
      };
      this.markDirty();
      return true;
    }
    if (key === 'r') {
      // Trend-record is only meaningful once a simulation dashboard exists;
      // otherwise there is nothing to sample and the key is a no-op.
      if (!this._state.getDashboard()) return false;
      this._state.recordTrendEntry();
      this.markDirty();
      return true;
    }
    return false;
  }

  public handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (!this._pendingAction) return false;
    const action = this._pendingAction;
    this._pendingAction = null;
    void ctx.executeCommand?.('policy', [action]).catch((err) => {
      logger.debug('policy panel command dispatch failed', { err, action });
    });
    return true;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    if (this._confirm) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Policy And Governance',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this._confirm) }],
        palette: C,
      });
      while (lines.length < height) {
        lines.push(createEmptyLine(width));
      }
      return lines.slice(0, height);
    }
    const snapshot = this._state.getSnapshot();
    const summaryLine = this._buildSummary(width, snapshot);
    const content = this._buildContent(width, snapshot);
    const dashboardActive = snapshot.divergence !== null;
    const hintsLine = buildKeyboardHints(width, [
      { keys: '↑/↓', label: 'scroll' },
      { keys: 's', label: 'simulate' },
      { keys: 'f', label: 'preflight' },
      { keys: 'l', label: 'lint' },
      { keys: 'p', label: 'promote' },
      { keys: 'b', label: 'rollback' },
      ...(dashboardActive ? [{ keys: 'r', label: 'record divergence snapshot' }] : []),
    ], C);
    const summarySection = { lines: [summaryLine] };
    const governanceSection = resolveScrollablePanelSection(width, height, {
      footerLines: [hintsLine],
      palette: C,
      beforeSections: [summarySection],
      section: {
        title: 'Governance',
        scrollableLines: content,
        scrollOffset: this._scrollOffset,
        minRows: 4,
        appendWindowSummary: content.length > 0 ? { dimColor: C.dim } : undefined,
      },
    });
    this._scrollOffset = governanceSection.scrollOffset;
    const lines = buildPanelWorkspace(width, height, {
      title: 'Policy And Governance',
      sections: [summarySection, governanceSection.section],
      footerLines: [hintsLine],
      palette: C,
    });
    while (lines.length < height) {
      lines.push(createEmptyLine(width));
    }
    return lines.slice(0, height);
  }

  /** Top-of-panel posture summary: the highest-signal governance state at a glance. */
  private _buildSummary(width: number, snapshot: PolicyPanelSnapshot): Line {
    const preflight = snapshot.lastPreflightReview;
    const divergence = snapshot.divergence;
    const lintCount = snapshot.lintFindings.length;
    const preflightStatus = preflight ? preflight.status : 'none';
    const preflightColor = !preflight
      ? C.dim
      : preflight.status === 'pass'
        ? C.good
        : preflight.status === 'warn'
          ? C.warn
          : C.bad;
    const gateStatus = divergence?.gate.status ?? 'n/a';
    return buildKeyValueLine(width, [
      { label: 'bundles', value: `${snapshot.current ? 1 : 0}+${snapshot.candidate ? 1 : 0}c`, valueColor: snapshot.current || snapshot.candidate ? C.value : C.dim },
      { label: 'preflight', value: preflightStatus.toUpperCase(), valueColor: preflightColor },
      { label: 'gate', value: gateStatus, valueColor: gateColor(gateStatus) },
      { label: 'lint', value: String(lintCount), valueColor: lintCount > 0 ? C.warn : C.dim },
    ], C);
  }

  private _buildContent(width: number, snapshot: PolicyPanelSnapshot): Line[] {
    const lines: Line[] = [];
    const current = snapshot.current;
    const candidate = snapshot.candidate;
    const divergence = snapshot.divergence;
    const permissionAudit = snapshot.recentPermissionAudit;
    const lintFindings = snapshot.lintFindings;
    const simulationSummary = snapshot.lastSimulationSummary;
    const preflightReview = snapshot.lastPreflightReview;

    const nothingRecorded = !current && !candidate && !divergence
      && snapshot.history.length === 0 && permissionAudit.length === 0
      && lintFindings.length === 0 && !simulationSummary && !preflightReview;
    if (nothingRecorded) {
      // No divergence dashboard exists in this branch by construction
      // (nothingRecorded requires !divergence), so the gate is honestly 'n/a'.
      lines.push(...buildEmptyState(
        width,
        ' No policy bundles loaded.',
        'Bundle: none active, none candidate. Gate: n/a.',
        [
          { command: '/policy load', summary: 'load a policy bundle to begin governance review' },
        ],
        C,
      ));
      return lines;
    }

    if (current) {
      lines.push(buildPanelLine(width, [[' Current', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  Bundle: ', C.label],
        [current.bundle.bundleId, C.value],
        ['  State: ', C.label],
        [current.state, C.info],
      ]));
      lines.push(buildPanelLine(width, [
        ['  Loaded: ', C.label],
        [fmtTime(current.loadedAt), C.dim],
        ['  Active: ', C.label],
        [fmtTime(current.activatedAt), C.dim],
      ]));
    }

    if (candidate) {
      lines.push(buildPanelLine(width, [[' Candidate', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  Bundle: ', C.label],
        [candidate.bundle.bundleId, C.value],
        ['  State: ', C.label],
        [candidate.state, C.info],
      ]));
      lines.push(buildPanelLine(width, [
        ['  Loaded: ', C.label],
        [fmtTime(candidate.loadedAt), C.dim],
        ['  Rules: ', C.label],
        [String(candidate.rules.length), C.value],
      ]));
    }

    if (snapshot.diff) {
      const diff = snapshot.diff;
      lines.push(buildPanelLine(width, [[' Diff', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  ', C.label],
        [`${diff.fromBundleId} -> ${diff.toBundleId}`, C.value],
        ['  Changes: ', C.label],
        [String(diff.totalChanges), C.value],
      ]));
      if (diff.added.length > 0) {
        lines.push(buildPanelLine(width, [['  Added', C.good]]));
        for (const rule of diff.added.slice(0, 5)) {
          lines.push(buildPanelLine(width, [
            ['    + ', C.good],
            [truncateDisplay(`${rule.id} (${rule.type}, effect=${rule.effect})`, Math.max(0, width - 6)), C.value],
          ]));
        }
      }
      if (diff.removed.length > 0) {
        lines.push(buildPanelLine(width, [['  Removed', C.bad]]));
        for (const rule of diff.removed.slice(0, 5)) {
          lines.push(buildPanelLine(width, [
            ['    - ', C.bad],
            [truncateDisplay(`${rule.id} (${rule.type}, effect=${rule.effect})`, Math.max(0, width - 6)), C.value],
          ]));
        }
      }
      if (diff.changed.length > 0) {
        lines.push(buildPanelLine(width, [['  Changed', C.warn]]));
        for (const change of diff.changed.slice(0, 5)) {
          lines.push(buildPanelLine(width, [
            ['    ~ ', C.warn],
            [truncateDisplay(change.ruleId, Math.max(0, width - 6)), C.value],
          ]));
        }
      }
    }

    if (divergence) {
      lines.push(buildPanelLine(width, [[' Governance Gate', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  Mode: ', C.label],
        [divergence.mode, C.info],
        ['  Gate: ', C.label],
        [divergence.gate.status, gateColor(divergence.gate.status)],
        ['  Divergence: ', C.label],
        [fmtRate(divergence.gate.divergenceRate ?? divergence.report.overall.divergenceRate), C.value],
      ]));
      lines.push(buildPanelLine(width, [
        ['  Evaluations: ', C.label],
        [String(divergence.report.overall.totalEvaluations), C.value],
        ['  Trend points: ', C.label],
        [String(divergence.trend.length), C.value],
      ]));
      const prefixEntries = Object.entries(divergence.report.byCommandPrefix);
      if (prefixEntries.length > 0) {
        lines.push(buildPanelLine(width, [['  Divergence by command prefix', C.label]]));
        for (const [prefix, stats] of prefixEntries.slice(0, 5)) {
          lines.push(buildPanelLine(width, [
            ['    ', C.label],
            [truncateDisplay(prefix, Math.max(0, Math.floor(width * 0.4))), C.value],
            ['  ', C.label],
            [fmtRate(stats.divergenceRate), stats.divergenceRate > 0 ? C.warn : C.good],
            ['  ', C.label],
            [`${stats.total}/${stats.totalEvaluations}`, C.dim],
          ]));
        }
      }
      const classEntries = Object.entries(divergence.report.byToolClass) as Array<[string, DivergenceStats | undefined]>;
      const populatedClassEntries = classEntries.filter((entry): entry is [string, DivergenceStats] => entry[1] !== undefined);
      if (populatedClassEntries.length > 0) {
        lines.push(buildPanelLine(width, [['  Divergence by tool class', C.label]]));
        for (const [cls, stats] of populatedClassEntries.slice(0, 5)) {
          lines.push(buildPanelLine(width, [
            ['    ', C.label],
            [truncateDisplay(cls, Math.max(0, Math.floor(width * 0.4))), C.value],
            ['  ', C.label],
            [fmtRate(stats.divergenceRate), stats.divergenceRate > 0 ? C.warn : C.good],
            ['  ', C.label],
            [`${stats.total}/${stats.totalEvaluations}`, C.dim],
          ]));
        }
      }
    }

    if (snapshot.history.length > 0) {
      lines.push(buildPanelLine(width, [[' History', C.label]]));
      for (const version of snapshot.history.slice(0, 5)) {
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [version.bundle.bundleId, C.value],
          ['  ', C.label],
          [version.state, C.dim],
          ['  ', C.label],
          [fmtTime(version.activatedAt ?? version.loadedAt), C.dim],
        ]));
      }
    }

    if (permissionAudit.length > 0) {
      lines.push(buildPanelLine(width, [[' Permission Audit', C.label]]));
      for (const entry of permissionAudit.slice(0, 5)) {
        const outcome = entry.approved === undefined ? 'pending' : entry.approved ? 'approved' : 'denied';
        const outcomeColor = entry.approved === undefined ? C.warn : entry.approved ? C.good : C.bad;
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [entry.tool, C.value],
          ['  ', C.label],
          [entry.riskLevel.toUpperCase(), outcomeColor],
          ['  ', C.label],
          [outcome, outcomeColor],
        ]));
        lines.push(buildPanelLine(width, [
          ['    ', C.label],
          [truncateDisplay(entry.summary, Math.max(0, width - 6)), C.dim],
        ]));
      }
    }

    if (lintFindings.length > 0) {
      lines.push(buildPanelLine(width, [[' Policy Lint', C.label]]));
      for (const finding of lintFindings.slice(0, 5)) {
        const color = finding.severity === 'error' ? C.bad : finding.severity === 'warn' ? C.warn : C.info;
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [finding.severity.toUpperCase(), color],
          ['  ', C.label],
          [truncateDisplay(finding.message, Math.max(0, width - 14)), color],
        ]));
      }
    }

    if (preflightReview) {
      lines.push(buildPanelLine(width, [[' Preflight Review', C.label]]));
      const statusColor =
        preflightReview.status === 'pass'
          ? C.good
          : preflightReview.status === 'warn'
            ? C.warn
            : C.bad;
      lines.push(buildPanelLine(width, [
        ['  Status: ', C.label],
        [preflightReview.status.toUpperCase(), statusColor],
        ['  Issues: ', C.label],
        [String(preflightReview.issueCount), C.value],
        ['  Generated: ', C.label],
        [fmtTime(preflightReview.generatedAt), C.dim],
      ]));
      lines.push(buildPanelLine(width, [
        ['  ', C.label],
        [truncateDisplay(preflightReview.summary, Math.max(0, width - 2)), C.dim],
      ]));
      for (const issue of preflightReview.issues.slice(0, 4)) {
        const issueColor = issue.severity === 'error' ? C.bad : issue.severity === 'warn' ? C.warn : C.info;
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [issue.severity.toUpperCase(), issueColor],
          ['  ', C.label],
          [truncateDisplay(issue.message, Math.max(0, width - 14)), issueColor],
        ]));
      }
    }

    if (simulationSummary) {
      lines.push(buildPanelLine(width, [[' Simulation Samples', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  Mode: ', C.label],
        [simulationSummary.mode, C.info],
        ['  Diverged: ', C.label],
        [`${simulationSummary.divergentScenarios}/${simulationSummary.totalScenarios}`, simulationSummary.divergentScenarios > 0 ? C.warn : C.good],
        ['  Allowed(actual/sim): ', C.label],
        [`${simulationSummary.allowedByActual}/${simulationSummary.allowedBySimulated}`, C.value],
      ]));
      for (const result of simulationSummary.results.slice(0, 4)) {
        const color = result.diverged ? C.warn : (result.authoritativeDecision.allowed ? C.good : C.bad);
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [truncateDisplay(result.scenario.label, Math.max(0, width - 40)), C.value],
          ['  ', C.label],
          [(result.authoritativeDecision.allowed ? 'allow' : 'deny').toUpperCase(), color],
          ['  ', C.label],
          [result.diverged ? (result.divergenceType ?? 'diverged') : 'aligned', color],
        ]));
      }
    }

    return lines;
  }
}
