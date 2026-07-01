import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { basename } from 'node:path';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { buildAlignedRow, buildKeyValueLine, buildKeyboardHints, buildPanelLine, buildPanelWorkspace, DEFAULT_PANEL_PALETTE, resolvePrimaryScrollableSection, type ColumnSpec, type PanelWorkspaceSection } from './polish.ts';
import { summarizeWorktreeOwnership, type WorktreeRegistry, type WorktreeStatusRecord } from '@/runtime/index.ts';

// Base chrome only — state colors and text tokens come straight from
// DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

function stateColor(state: WorktreeStatusRecord['state']): string {
  switch (state) {
    case 'active': return C.good;
    case 'paused':
    case 'kept': return C.warn;
    default: return C.dim;
  }
}

/** Glyph that reads at a glance: ● active, ◌ paused/kept, ⊘ discard/cleanup. */
function stateGlyph(state: WorktreeStatusRecord['state']): string {
  switch (state) {
    case 'active': return '●';
    case 'paused':
    case 'kept': return '◌';
    default: return '⊘';
  }
}

/**
 * One worktree row, aligned with display-width-aware columns so a wide-char or
 * long branch name never shoves the path column out of alignment. The active
 * worktree is flagged with a ● glyph and selection uses the shared marker.
 */
function buildWorktreeRow(width: number, row: WorktreeStatusRecord, selected: boolean): Line {
  const pathW = Math.max(8, width - (2 + 10 + 13 + 20) - 4 - 2);
  const columns: ColumnSpec[] = [
    { width: 2 },
    { width: 10 },
    { width: 13 },
    { width: 20 },
    { width: pathW },
  ];
  return buildAlignedRow(
    width,
    [
      { text: stateGlyph(row.state), fg: stateColor(row.state) },
      { text: row.kind, fg: C.info },
      { text: row.state, fg: stateColor(row.state) },
      { text: row.branch, fg: C.value },
      { text: basename(row.path) || row.path, fg: C.dim },
    ],
    columns,
    { selected, selectedBg: C.headerBg, marker: '▸' },
  );
}

export class WorktreePanel extends ScrollableListPanel<WorktreeStatusRecord> {
  private rows: WorktreeStatusRecord[] = [];
  private loading = false;
  private readonly worktreeRegistry: WorktreeRegistry;

  public constructor(worktreeRegistry: WorktreeRegistry) {
    super('worktrees', 'Worktrees', 'W', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.worktreeRegistry = worktreeRegistry;
    void this.refresh();
  }

  public override onActivate(): void {
    super.onActivate();
    if (!this.loading) void this.refresh();
  }

  public handleInput(key: string): boolean {
    if (key === 'r') {
      void this.refresh();
      return true;
    }
    return super.handleInput(key);
  }

  protected getItems(): readonly WorktreeStatusRecord[] {
    return this.rows;
  }

  protected renderItem(row: WorktreeStatusRecord, index: number, _selected: boolean, width: number): Line {
    return buildWorktreeRow(width, row, index === this.selectedIndex);
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.markDirty();
    try {
      this.rows = await this.worktreeRegistry.list();
      this.clampSelection();
    } finally {
      this.loading = false;
      this.markDirty();
    }
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const sections: PanelWorkspaceSection[] = [];

    if (this.loading && this.rows.length === 0) {
      sections.push({ title: 'Worktrees', lines: [buildPanelLine(width, [[' Loading worktree state...', C.info]])] });
    } else if (this.rows.length === 0) {
      sections.push({
        title: 'Worktrees',
        lines: [
          buildPanelLine(width, [[' No git worktrees discovered for this project yet.', C.dim]]),
          buildPanelLine(width, [['  /worktree attach <path>', C.info], ['  register a worktree for orchestrator-managed lifecycle', C.dim]]),
        ],
      });
    } else {
      const summary = summarizeWorktreeOwnership(this.rows);
      sections.push({
        title: 'Worktree posture',
        lines: [
          buildKeyValueLine(width, [
            { label: 'total', value: String(summary.total), valueColor: C.value },
            { label: 'active', value: String(summary.active), valueColor: C.good },
            { label: 'paused', value: String(summary.paused), valueColor: summary.paused > 0 ? C.warn : C.dim },
            { label: 'cleanup', value: String(summary.pendingCleanup), valueColor: summary.pendingCleanup > 0 ? C.warn : C.dim },
          ], C),
          buildKeyValueLine(width, [
            { label: 'session attached', value: String(summary.sessionAttached), valueColor: summary.sessionAttached > 0 ? C.info : C.dim },
            { label: 'task attached', value: String(summary.taskAttached), valueColor: summary.taskAttached > 0 ? C.info : C.dim },
            { label: 'agent owned', value: String(summary.agentOwned), valueColor: summary.agentOwned > 0 ? C.value : C.dim },
            { label: 'orchestrator', value: String(summary.orchestratorOwned), valueColor: summary.orchestratorOwned > 0 ? C.value : C.dim },
          ], C),
        ],
      });
      sections.push({
        title: 'Next Actions',
        lines: [
          buildPanelLine(width, [[
            summary.pendingCleanup > 0 || summary.discard > 0
              ? ' Review pending-cleanup and discard-marked worktrees before they drift from orchestrator ownership.'
              : ' Worktree ownership is healthy. Use the task and session links below for restore, merge, or cleanup review.',
            summary.pendingCleanup > 0 || summary.discard > 0 ? C.warn : C.dim,
          ]]),
          buildPanelLine(width, [['  /worktree task <task-id>  /worktree session <session-id>  /worktree inspect <path>', C.info]]),
        ],
      });
      const selected = this.rows[this.selectedIndex]!;
      const detailSection: PanelWorkspaceSection = {
        title: 'Details',
        lines: [
          buildPanelLine(width, [[' path ', C.label], [selected.path, C.dim]]),
          buildPanelLine(width, [[' branch ', C.label], [selected.branch, C.value], ['  head ', C.label], [selected.head.slice(0, 12), C.info], ['  state ', C.label], [selected.state, stateColor(selected.state)]]),
          buildPanelLine(width, [[' kind ', C.label], [selected.kind, C.info], ['  owner ', C.label], [selected.ownerId ?? 'n/a', C.dim], ['  session ', C.label], [selected.sessionId ?? 'n/a', C.dim]]),
          buildPanelLine(width, [[' task ', C.label], [selected.taskId ?? 'n/a', C.dim], ['  updated ', C.label], [new Date(selected.updatedAt).toLocaleString(), C.dim]]),
          buildPanelLine(width, [[
            selected.sessionId || selected.taskId
              ? ' Attached worktree can be resumed from session/task flows and should be merged or cleaned up by the orchestrator.'
              : ' Unattached worktree detected. Review whether it should be attached, kept, discarded, or cleaned up.',
            selected.sessionId || selected.taskId ? C.info : C.warn,
          ]]),
          buildPanelLine(width, [[
            selected.state === 'paused'
              ? ` Next: /worktree resume ${selected.path}`
              : selected.state === 'discard' || selected.state === 'pending-cleanup'
                ? ` Next: /worktree cleanup ${selected.path}`
                : selected.taskId
                  ? ` Next: /worktree task ${selected.taskId}`
                  : selected.sessionId
                    ? ` Next: /worktree session ${selected.sessionId}`
                    : ` Next: /worktree inspect ${selected.path}`,
            C.dim,
          ]]),
        ],
      };
      const resolvedWorktreesSection = resolvePrimaryScrollableSection(width, height, {
        intro: 'Orchestrator-owned worktree lifecycle, attachments, pause/resume posture, and cleanup state.',
        footerLines: [buildKeyboardHints(width, [{ keys: '↑/↓', label: 'select' }, { keys: 'r', label: 'refresh' }, { keys: '/worktree inspect', label: '<path>' }, { keys: 'attach·pause·resume·keep·discard·cleanup', label: '' }], C)],
        palette: C,
        beforeSections: sections,
        section: {
          title: 'Worktrees',
          fixedLines: [
            buildAlignedRow(width, [
              { text: '', fg: C.dim },
              { text: 'KIND', fg: C.label, bold: true },
              { text: 'STATE', fg: C.label, bold: true },
              { text: 'BRANCH', fg: C.label, bold: true },
              { text: 'WORKTREE', fg: C.label, bold: true },
            ], [
              { width: 2 }, { width: 10 }, { width: 13 }, { width: 20 },
              { width: Math.max(8, width - (2 + 10 + 13 + 20) - 4 - 2) },
            ], { marker: ' ' }),
          ],
          scrollableLines: this.rows.map((row, absolute) =>
            buildWorktreeRow(width, row, absolute === this.selectedIndex),
          ),
          selectedIndex: this.selectedIndex,
          scrollOffset: this.scrollStart,
          guardRows: 1,
          minRows: 4,
          appendWindowSummary: { dimColor: C.dim },
        },
        afterSections: [detailSection],
      });
      this.scrollStart = resolvedWorktreesSection.scrollOffset;
      sections.push(resolvedWorktreesSection.section);
      sections.push(detailSection);
    }

    const lines = buildPanelWorkspace(width, height, {
      title: 'Worktree Control Room',
      intro: 'Orchestrator-owned worktree lifecycle, attachments, pause/resume posture, and cleanup state.',
      sections,
      footerLines: [buildKeyboardHints(width, [{ keys: '↑/↓', label: 'select' }, { keys: 'r', label: 'refresh' }, { keys: '/worktree inspect', label: '<path>' }, { keys: 'attach·pause·resume·keep·discard·cleanup', label: '' }], C)],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
