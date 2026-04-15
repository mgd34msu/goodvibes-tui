import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types/grid';
import { BasePanel } from './base-panel.ts';
import { buildKeyValueLine, buildPanelLine, buildPanelWorkspace, DEFAULT_PANEL_PALETTE, resolvePrimaryScrollableSection, type PanelWorkspaceSection } from './polish.ts';
import { summarizeWorktreeOwnership, type WorktreeRegistry, type WorktreeStatusRecord } from '../runtime/worktree/registry.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  dim: '#475569',
  info: '#38bdf8',
  ok: '#22c55e',
  warn: '#eab308',
  headerBg: '#1e293b',
} as const;

function stateColor(state: WorktreeStatusRecord['state']): string {
  switch (state) {
    case 'active': return C.ok;
    case 'paused':
    case 'kept': return C.warn;
    default: return C.dim;
  }
}

export class WorktreePanel extends BasePanel {
  private rows: WorktreeStatusRecord[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private loading = false;
  private readonly worktreeRegistry: WorktreeRegistry;

  public constructor(worktreeRegistry: WorktreeRegistry) {
    super('worktrees', 'Worktrees', 'W', 'monitoring');
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
    if (this.rows.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.markDirty();
    try {
      this.rows = await this.worktreeRegistry.list();
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
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
      sections.push({ title: 'Worktrees', lines: [buildPanelLine(width, [[' No git worktrees discovered for this project.', C.dim]])] });
    } else {
      const summary = summarizeWorktreeOwnership(this.rows);
      sections.push({
        title: 'Worktree posture',
        lines: [
          buildKeyValueLine(width, [
            { label: 'total', value: String(summary.total), valueColor: C.value },
            { label: 'active', value: String(summary.active), valueColor: C.ok },
            { label: 'paused', value: String(summary.paused), valueColor: summary.paused > 0 ? C.warn : C.dim },
            { label: 'cleanup', value: String(summary.cleanupPending), valueColor: summary.cleanupPending > 0 ? C.warn : C.dim },
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
            summary.cleanupPending > 0 || summary.discard > 0
              ? ' Review cleanup-pending and discard-marked worktrees before they drift from orchestrator ownership.'
              : ' Worktree ownership is healthy. Use the task and session links below for restore, merge, or cleanup review.',
            summary.cleanupPending > 0 || summary.discard > 0 ? C.warn : C.dim,
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
              : selected.state === 'discard' || selected.state === 'cleanup-pending'
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
        footerLines: [buildPanelLine(width, [[' r refresh  /worktree inspect <path>  /worktree attach|pause|resume|keep|discard|cleanup ', C.dim]])],
        palette: C,
        beforeSections: sections,
        section: {
          title: 'Worktrees',
          scrollableLines: this.rows.map((row, absolute) => {
            const bg = absolute === this.selectedIndex ? C.headerBg : undefined;
            return buildPanelLine(width, [
              [` ${row.kind}`.padEnd(14), C.info, bg],
              [` ${row.state}`.padEnd(16), stateColor(row.state), bg],
              [` ${row.branch}`.padEnd(24), C.value, bg],
              [` ${row.path}`.slice(0, Math.max(0, width - 56)), C.dim, bg],
            ]);
          }),
          selectedIndex: this.selectedIndex,
          scrollOffset: this.scrollOffset,
          guardRows: 1,
          minRows: 4,
          appendWindowSummary: { dimColor: C.dim },
        },
        afterSections: [detailSection],
      });
      this.scrollOffset = resolvedWorktreesSection.scrollOffset;
      sections.push(resolvedWorktreesSection.section);
      sections.push(detailSection);
    }

    const lines = buildPanelWorkspace(width, height, {
      title: 'Worktree Control Room',
      intro: 'Orchestrator-owned worktree lifecycle, attachments, pause/resume posture, and cleanup state.',
      sections,
      footerLines: [buildPanelLine(width, [[' r refresh  /worktree inspect <path>  /worktree attach|pause|resume|keep|discard|cleanup ', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
