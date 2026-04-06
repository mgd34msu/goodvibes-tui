import type { Cell, Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import type { ForensicsRegistry } from '../runtime/forensics/registry.ts';
import { BasePanel } from './base-panel.ts';

const C = {
  header: '#cbd5e1',
  headerBg: '#0f172a',
  label: '#94a3b8',
  value: '#e2e8f0',
  dim: '#475569',
  warn: '#f59e0b',
  bad: '#ef4444',
  info: '#38bdf8',
  empty: '#334155',
  selectBg: '#111827',
} as const;

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  for (const [text, fg, bg] of segments) {
    const style = { fg, bg: bg ?? '' };
    for (const ch of text) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, style));
    }
  }
  while (cells.length < width) cells.push(createStyledCell(' ', { fg: '' }));
  return cells.slice(0, width);
}

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

export class IncidentReviewPanel extends BasePanel {
  private readonly registry?: ForensicsRegistry;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;

  public constructor(registry?: ForensicsRegistry) {
    super('incident', 'Incident Review', 'N', 'monitoring');
    this.registry = registry;
    this.unsub = registry ? registry.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const reports = this.registry?.getAll() ?? [];
    if (reports.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(reports.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedIndex = reports.length - 1;
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' Incident Review Workspace', C.header, C.headerBg]]));

    if (!this.registry) {
      lines.push(buildLine(width, [[' Forensics registry not wired into this panel yet.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const reports = this.registry.getAll();
    if (reports.length === 0) {
      lines.push(buildLine(width, [[' No incidents recorded yet.', C.empty]]));
      lines.push(buildLine(width, [[' Incident bundles will appear here when failures produce forensics reports.', C.dim]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    this.selectedIndex = Math.min(this.selectedIndex, reports.length - 1);
    const selected = reports[this.selectedIndex]!;
    const bundle = this.registry.buildBundle(selected.id);

    lines.push(buildLine(width, [[` incidents:${reports.length} selected:${this.selectedIndex + 1}/${reports.length}`, C.dim]]));

    const visible = reports.slice(0, Math.max(1, height - 10));
    for (let index = 0; index < visible.length; index++) {
      const report = visible[index]!;
      const bg = index === this.selectedIndex ? C.selectBg : undefined;
      lines.push(buildLine(width, [
        [' ', C.label, bg],
        [report.id.slice(0, 8).padEnd(9), C.dim, bg],
        [report.classification.padEnd(20), classificationColor(report.classification), bg],
        [report.summary.slice(0, Math.max(0, width - 31)), C.value, bg],
      ]));
    }

    if (bundle) {
      lines.push(buildLine(width, [[' Details', C.label]]));
      lines.push(buildLine(width, [
        ['  Root cause: ', C.label],
        [(bundle.evidence.rootCause ?? 'n/a').slice(0, Math.max(0, width - 15)), C.value],
      ]));
      lines.push(buildLine(width, [
        ['  Terminal phase: ', C.label],
        [bundle.evidence.terminalPhase ?? 'n/a', C.value],
        ['  Outcome: ', C.label],
        [bundle.evidence.terminalOutcome ?? 'n/a', C.value],
      ]));
      lines.push(buildLine(width, [
        ['  Permissions denied: ', C.label],
        [String(bundle.evidence.deniedPermissionCount), bundle.evidence.deniedPermissionCount > 0 ? C.warn : C.dim],
        ['  Budget breaches: ', C.label],
        [String(bundle.evidence.budgetBreachCount), bundle.evidence.budgetBreachCount > 0 ? C.warn : C.dim],
        ['  Replay mismatches: ', C.label],
        [String(bundle.replay.mismatchCount), bundle.replay.mismatchCount > 0 ? C.bad : C.dim],
      ]));
      lines.push(buildLine(width, [
        ['  Related IDs: ', C.label],
        [`turn=${bundle.evidence.relatedIds.turnId ?? 'n/a'} task=${bundle.evidence.relatedIds.taskId ?? 'n/a'} agent=${bundle.evidence.relatedIds.agentId ?? 'n/a'}`.slice(0, Math.max(0, width - 14)), C.info],
      ]));
      if (bundle.evidence.slowPhases.length > 0) {
        lines.push(buildLine(width, [
          ['  Slow phases: ', C.label],
          [bundle.evidence.slowPhases.join(', ').slice(0, Math.max(0, width - 15)), C.warn],
        ]));
      }
      const rootCause = selected.causalChain.find((entry) => entry.isRootCause);
      if (rootCause) {
        lines.push(buildLine(width, [
          ['  Root event: ', C.label],
          [`${rootCause.sourceEventType} — ${rootCause.description}`.slice(0, Math.max(0, width - 14)), C.dim],
        ]));
      }
      const denied = selected.permissionEvidence.find((entry) => entry.approved === false);
      if (denied) {
        lines.push(buildLine(width, [
          ['  Permission: ', C.label],
          [`${denied.tool} denied${denied.riskLevel ? ` (${denied.riskLevel})` : ''}${denied.summary ? ` — ${denied.summary}` : ''}`.slice(0, Math.max(0, width - 14)), C.warn],
        ]));
      }
      if (bundle.replay.relatedMismatches.length > 0) {
        const mismatch = bundle.replay.relatedMismatches[0]!;
        lines.push(buildLine(width, [
          ['  Replay link: ', C.label],
          [`${mismatch.kind}${mismatch.ownerDomain ? `/${mismatch.ownerDomain}` : ''} — ${mismatch.description}`.slice(0, Math.max(0, width - 14)), C.bad],
        ]));
      }
      const ownerBreakdown = Object.entries(bundle.replay.mismatchBreakdown.byOwnerDomain)
        .filter(([, count]) => count > 0)
        .slice(0, 3)
        .map(([domain, count]) => `${domain}:${count}`)
        .join(', ');
      if (ownerBreakdown.length > 0) {
        lines.push(buildLine(width, [
          ['  Replay owners: ', C.label],
          [ownerBreakdown.slice(0, Math.max(0, width - 17)), C.info],
        ]));
      }
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
