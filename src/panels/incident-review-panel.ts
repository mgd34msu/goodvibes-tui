import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { Line } from '../types/grid.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import { formatShortDuration } from '../utils/format-duration.ts';
import type {
  ForensicsRegistry,
  FailureReport,
  ForensicsBundle,
  CausalChainEntry,
  PhaseTimingEntry,
  ForensicsJumpLink,
} from '@/runtime/index.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusPill,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import type { PanelIntegrationContext } from './types.ts';

// Base chrome only — title band, state colors, and text tokens all come
// straight from DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

function classificationColor(value: string): string {
  switch (value) {
    case 'cancelled':
      return C.dim;
    case 'max_tokens':
    case 'unknown':
      return C.warn;
    default:
      return C.bad;
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Default workspace-relative destination for a panel-triggered `x` export.
 * Left relative (not resolved against home/cwd here) so the `/incident
 * export` command's own `shellPaths.resolveWorkspacePath` — the composition
 * root's owned path resolver — decides the final absolute location.
 */
function buildIncidentExportPath(id: string): string {
  return `goodvibes-exports/incident-${id}-${Date.now()}.json`;
}

export class IncidentReviewPanel extends ScrollableListPanel<FailureReport> {
  private readonly registry?: ForensicsRegistry;
  private readonly unsub: (() => void) | null;

  // Inline confirm for the (non-destructive but deliberate) capture action.
  private _confirm: ConfirmState<string> | null = null;

  // Pending cross-panel actions resolved via handlePanelIntegrationAction,
  // which is the only place `executeCommand`/`panelManager` are available.
  private _pendingExport: string | null = null;
  private _pendingCapture: string | null = null;
  private _pendingJump: ForensicsJumpLink | null = null;

  // Cache buildBundle(id) per selected report id instead of recomputing it
  // on every render call; invalidated whenever the registry changes.
  private _bundleCache: { readonly id: string; readonly bundle: ForensicsBundle | undefined } | null = null;

  public constructor(registry?: ForensicsRegistry) {
    super('incident', 'Incident Review', '◪', 'incidents-diagnostics');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter incidents';
    this.registry = registry;
    this.unsub = registry
      ? registry.subscribe(() => {
        this._bundleCache = null;
        this.markDirty();
      })
      : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly FailureReport[] {
    return this.registry?.getAll() ?? [];
  }

  protected override filterMatches(report: FailureReport, q: string): boolean {
    return report.classification.toLowerCase().includes(q)
      || report.id.toLowerCase().includes(q)
      || (report.summary ?? '').toLowerCase().includes(q);
  }

  protected renderItem(report: FailureReport, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [fitDisplay(report.id, 9), C.dim, bg],
      [fitDisplay(report.classification, 20), classificationColor(report.classification), bg],
      [truncateDisplay(report.summary, Math.max(0, width - 31)), C.value, bg],
    ]);
  }

  protected override getEmptyStateMessage(): string {
    return ' No incidents recorded yet.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/incident latest', summary: 'inspect the latest report once one exists' },
      { command: '/recall capture incident latest', summary: 'promote incident evidence into project knowledge' },
    ];
  }

  private getBundle(id: string): ForensicsBundle | undefined {
    if (!this.registry) return undefined;
    if (!this._bundleCache || this._bundleCache.id !== id) {
      this._bundleCache = { id, bundle: this.registry.buildBundle(id) };
    }
    return this._bundleCache.bundle;
  }

  private _pushPhaseTimingLine(lines: Line[], pt: PhaseTimingEntry, width: number): void {
    const statusChar = pt.success ? '✓' : '✕';
    const statusColor = pt.success ? C.good : C.bad;
    const dur = formatShortDuration(pt.durationMs);
    const phaseLabel = fitDisplay(pt.phase, 14);
    const errPart = pt.error ? `  ${truncateDisplay(pt.error, Math.max(0, width - 34))}` : '';
    lines.push(buildPanelLine(width, [
      ['    ', C.dim],
      [`${statusChar} `, statusColor],
      [phaseLabel, C.value],
      [dur.padStart(8, ' '), C.label],
      [errPart, C.bad],
    ]));
  }

  private _pushCausalLine(lines: Line[], entry: CausalChainEntry, width: number): void {
    const prefix = entry.isRootCause ? '    * ' : '    - ';
    const color = entry.isRootCause ? C.bad : C.dim;
    const timeStr = fmtTime(entry.ts);
    const descMax = Math.max(0, width - prefix.length - 9);
    lines.push(buildPanelLine(width, [
      [prefix, color],
      [`${timeStr} `, C.label],
      [truncateDisplay(entry.description, descMax), color],
    ]));
  }

  private _pushJumpLinkLine(lines: Line[], link: ForensicsJumpLink, width: number): void {
    const kindTag = link.kind === 'panel' ? '[panel]' : '[cmd]  ';
    lines.push(buildPanelLine(width, [
      ['    ', C.dim],
      [kindTag, C.label],
      [` ${link.label}`, C.info],
      [link.args ? ` (${link.args})` : '', C.dim],
    ]));
  }

  /**
   * Decision-making for every key: navigation is delegated to
   * ScrollableListPanel, while `x`/`c`/`j` and any in-progress confirm are
   * resolved here and staged as a pending action. The actual cross-panel
   * side effect (executeCommand / panelManager.open) requires the
   * PanelIntegrationContext, which is only available in
   * `handlePanelIntegrationAction` — invoked immediately after this method
   * returns `true` for the same key.
   */
  public override handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (this._confirm) {
      const outcome = handleConfirmInput(this._confirm, key);
      if (outcome === 'confirmed') {
        this._pendingCapture = this._confirm.subject;
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

    // Actions must target the filtered view the list highlights — raw
    // getItems() desyncs selectedIndex under an applied '/' filter.
    const reports = this.getVisibleItems();
    if (reports.length > 0 && (key === 'x' || key === 'c' || key === 'j')) {
      this.clampSelection();
      const selected = this.getSelectedItem();
      if (selected) {
        if (key === 'x') {
          this._pendingExport = selected.id;
          return true;
        }
        if (key === 'c') {
          this._confirm = { subject: selected.id, label: `incident ${selected.id}`, verb: 'Capture' };
          this.markDirty();
          return true;
        }
        if (key === 'j') {
          const link = selected.jumpLinks[0];
          if (link) {
            this._pendingJump = link;
            return true;
          }
          return false;
        }
      }
    }

    return super.handleInput(key);
  }

  public handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (this._pendingExport) {
      const id = this._pendingExport;
      this._pendingExport = null;
      const path = buildIncidentExportPath(id);
      void ctx.executeCommand?.('incident', ['export', id, path]).catch((err) => {
        logger.debug('incident export dispatch failed', { err });
      });
      return true;
    }
    if (this._pendingCapture) {
      const id = this._pendingCapture;
      this._pendingCapture = null;
      void ctx.executeCommand?.('incident', ['capture', id]).catch((err) => {
        logger.debug('incident capture dispatch failed', { err });
      });
      return true;
    }
    if (this._pendingJump) {
      const link = this._pendingJump;
      this._pendingJump = null;
      if (link.kind === 'panel') {
        ctx.panelManager.open(link.target);
      } else {
        void ctx.executeCommand?.(link.target, link.args ? link.args.split(/\s+/).filter(Boolean) : []).catch((err) => {
          logger.debug('jump link dispatch failed', { err });
        });
      }
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    if (this._confirm) {
      return buildPanelWorkspace(width, height, {
        title: 'Incident Review Workspace',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this._confirm) }],
        palette: C,
      });
    }

    const intro = 'Failure bundles with causal chains, phase timings, jump links, and exportable review evidence.';

    if (!this.registry) {
      return buildPanelWorkspace(width, height, {
        title: 'Incident Review Workspace',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Incident registry not configured for this session.',
            'This runtime was not wired with a forensics registry at bootstrap, so no incident data is available.',
            [],
            C,
          ),
        }],
        palette: C,
      });
    }

    const reports = this.getItems();
    if (reports.length === 0) {
      return this.renderList(width, height, { title: 'Incident Review Workspace' });
    }

    this.clampSelection();
    // Header/detail must describe the row the (possibly filtered) list
    // highlights; a filter matching nothing leaves no selection at all.
    const visible = this.getVisibleItems();
    const selected = this.getSelectedItem();
    if (!selected) {
      return this.renderList(width, height, { title: 'Incident Review Workspace' });
    }
    const bundle = this.getBundle(selected.id);

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'incidents', value: String(reports.length), valueColor: C.value },
        { label: 'selected', value: `${this.selectedIndex + 1}/${visible.length}`, valueColor: C.info },
        { label: 'classification', value: selected.classification, valueColor: classificationColor(selected.classification) },
      ], C),
    ];

    const footerLines: Line[] = [];
    if (bundle) {
      footerLines.push(buildKeyValueLine(width, [
        { label: 'id', value: selected.id, valueColor: C.dim },
        { label: 'trace', value: selected.traceId, valueColor: C.dim },
      ], C));
      footerLines.push(...buildBodyText(width, `Root cause: ${bundle.evidence.rootCause ?? 'n/a'}`, C, C.value));
      footerLines.push(buildKeyValueLine(width, [
        { label: 'Permissions denied', value: String(bundle.evidence.deniedPermissionCount), valueColor: bundle.evidence.deniedPermissionCount > 0 ? C.warn : C.dim },
        { label: 'Budget breaches', value: String(bundle.evidence.budgetBreachCount), valueColor: bundle.evidence.budgetBreachCount > 0 ? C.warn : C.dim },
        { label: 'Replay mismatches', value: String(bundle.replay.mismatchCount), valueColor: bundle.replay.mismatchCount > 0 ? C.bad : C.dim },
      ], C));
      footerLines.push(buildPanelLine(width, [
        ['  Related IDs: ', C.label],
        [truncateDisplay(`turn=${bundle.evidence.relatedIds.turnId ?? 'n/a'} task=${bundle.evidence.relatedIds.taskId ?? 'n/a'} agent=${bundle.evidence.relatedIds.agentId ?? 'n/a'}`, Math.max(0, width - 14)), C.info],
      ]));
      if (selected.phaseTimings.length > 0) {
        footerLines.push(buildPanelLine(width, [['  Phase Timings:', C.label]]));
        for (const pt of selected.phaseTimings) this._pushPhaseTimingLine(footerLines, pt, width);
      }
      if (selected.causalChain.length > 0) {
        footerLines.push(buildPanelLine(width, [['  Causal Chain:', C.label]]));
        for (const entry of selected.causalChain) this._pushCausalLine(footerLines, entry, width);
      }
      const denied = selected.permissionEvidence.find((entry) => entry.approved === false);
      if (denied) {
        footerLines.push(buildPanelLine(width, [
          ['  Permission: ', C.label],
          [truncateDisplay(`${denied.tool} denied${denied.riskLevel ? ` (${denied.riskLevel})` : ''}${denied.summary ? ` - ${denied.summary}` : ''}`, Math.max(0, width - 14)), C.warn],
        ]));
      }
      if (bundle.replay.relatedMismatches.length > 0) {
        const mismatch = bundle.replay.relatedMismatches[0]!;
        const ownerBreakdown = Object.entries(bundle.replay.mismatchBreakdown.byOwnerDomain)
          .filter(([, count]) => count > 0)
          .slice(0, 3)
          .map(([domain, count]) => `${domain}:${count}`)
          .join(', ');
        const replayDetail = ownerBreakdown.length > 0
          ? `Replay link: ${mismatch.kind}${mismatch.ownerDomain ? `/${mismatch.ownerDomain}` : ''} - ${mismatch.description}  Replay owners: ${ownerBreakdown}`
          : `Replay link: ${mismatch.kind}${mismatch.ownerDomain ? `/${mismatch.ownerDomain}` : ''} - ${mismatch.description}`;
        footerLines.push(buildPanelLine(width, [
          ['  ', C.label],
          ...buildStatusPill('bad', truncateDisplay(replayDetail, Math.max(0, width - 2))),
        ]));
      } else {
        const ownerBreakdown = Object.entries(bundle.replay.mismatchBreakdown.byOwnerDomain)
          .filter(([, count]) => count > 0)
          .slice(0, 3)
          .map(([domain, count]) => `${domain}:${count}`)
          .join(', ');
        if (ownerBreakdown.length > 0) {
          footerLines.push(buildPanelLine(width, [
            ['  Replay owners: ', C.label],
            [truncateDisplay(ownerBreakdown, Math.max(0, width - 17)), C.info],
          ]));
        }
      }
      if (selected.jumpLinks.length > 0) {
        footerLines.push(buildPanelLine(width, [['  Jump Links:', C.label]]));
        for (const link of selected.jumpLinks) this._pushJumpLinkLine(footerLines, link, width);
      }
    }
    footerLines.push(buildGuidanceLine(width, '/security', 'open the broader trust and incident posture control room', C));

    const hints = this.filterActive
      ? [
          { keys: 'type', label: 'filter incidents' },
          { keys: 'Enter', label: 'apply' },
          { keys: 'Esc', label: 'clear' },
        ]
      : [
          { keys: '↑/↓', label: 'select incident' },
          { keys: 'Home/End', label: 'jump' },
          { keys: '/', label: 'filter' },
          { keys: 'x', label: 'export' },
          { keys: 'c', label: 'capture' },
          ...(selected.jumpLinks.length > 0 ? [{ keys: 'j', label: 'follow link' }] : []),
        ];

    return this.renderList(width, height, {
      title: 'Incident Review Workspace',
      header: headerLines,
      footer: footerLines,
      hints,
    });
  }
}
