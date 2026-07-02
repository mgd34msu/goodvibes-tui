import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { basename } from 'node:path';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { buildAlignedRow, buildKeyValueLine, buildKeyboardHints, buildPanelLine, buildPanelWorkspace, DEFAULT_PANEL_PALETTE, resolvePrimaryScrollableSection, type ColumnSpec, type PanelWorkspaceSection } from './polish.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { summarizeWorktreeOwnership, type WorktreeStatusRecord } from '@/runtime/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { PanelIntegrationContext } from './types.ts';

// Base chrome only — state colors and text tokens come straight from
// DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

/**
 * Structural shape the panel actually needs from a worktree registry. The
 * real `WorktreeRegistry` (from the SDK) satisfies this directly; it has no
 * `subscribe()` method today, so the panel falls back to polling when one
 * isn't provided (see constructor). Kept narrow and `Like`-suffixed per the
 * project's duck-typing convention (see `agent-inspector-shared.ts`).
 */
export interface WorktreeRegistryLike {
  list(): Promise<WorktreeStatusRecord[]>;
  attach(path: string, target: { sessionId?: string; taskId?: string }): void;
  setState(path: string, state: WorktreeStatusRecord['state']): void;
  cleanup(path: string): Promise<void>;
  /** Optional live-update hook; when present the panel prefers it over polling. */
  subscribe?(listener: () => void): () => void;
}

/** What a pending destructive confirm will do once the user confirms. */
interface WorktreeConfirmSubject {
  readonly path: string;
  readonly action: 'discard' | 'cleanup';
}

/** Poll cadence used only when the registry has no `subscribe()` method. */
const POLL_INTERVAL_MS = 5_000;

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

const WORKTREE_HINTS = [
  { keys: '↑/↓', label: 'select' },
  { keys: 'p/u/k', label: 'pause/resume/keep' },
  { keys: 'd/c', label: 'discard/cleanup' },
  { keys: 'enter', label: 'jump to session/task' },
  { keys: 'r', label: 'refresh' },
] as const;

export class WorktreePanel extends ScrollableListPanel<WorktreeStatusRecord> {
  private rows: WorktreeStatusRecord[] = [];
  private loading = false;
  private confirm: ConfirmState<WorktreeConfirmSubject> | null = null;
  private pendingJump: { targetPanel: 'sessions' | 'tasks' } | null = null;
  private readonly worktreeRegistry: WorktreeRegistryLike;
  private readonly requestRender: () => void;
  private unsubscribe: (() => void) | null = null;

  public constructor(worktreeRegistry: WorktreeRegistryLike, requestRender: () => void = () => {}) {
    super('worktrees', 'Worktrees', 'W', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.worktreeRegistry = worktreeRegistry;
    this.requestRender = requestRender;
    void this.refresh();
    // Live state: prefer a registry subscription when the caller provides one
    // (matches the mock shape used by contract tests); otherwise poll, so the
    // real SDK WorktreeRegistry (which has no subscribe() today) still stays live.
    if (typeof this.worktreeRegistry.subscribe === 'function') {
      this.unsubscribe = this.worktreeRegistry.subscribe(() => { void this.refresh(); });
    } else {
      this.registerTimer(setInterval(() => { void this.refresh(); }, POLL_INTERVAL_MS));
    }
  }

  public override onActivate(): void {
    super.onActivate();
    if (!this.loading) void this.refresh();
  }

  public override onDestroy(): void {
    super.onDestroy();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  public override handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      const subject = this.confirm!.subject;
      this.confirm = null;
      if (subject.action === 'discard') {
        this.worktreeRegistry.setState(subject.path, 'discard');
        void this.refresh();
      } else {
        void this._cleanup(subject.path);
      }
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    if (key === 'r') {
      void this.refresh();
      return true;
    }

    const selected = this.rows[this.selectedIndex];

    if (key === 'p' && selected && selected.state !== 'paused') {
      this.worktreeRegistry.setState(selected.path, 'paused');
      void this.refresh();
      return true;
    }
    if (key === 'u' && selected && selected.state !== 'active') {
      this.worktreeRegistry.setState(selected.path, 'active');
      void this.refresh();
      return true;
    }
    if (key === 'k' && selected && selected.state !== 'kept') {
      this.worktreeRegistry.setState(selected.path, 'kept');
      void this.refresh();
      return true;
    }
    if (key === 'd' && selected && selected.state !== 'discard') {
      this.confirm = {
        subject: { path: selected.path, action: 'discard' },
        label: `worktree ${basename(selected.path)} (${selected.branch})`,
        verb: 'Discard',
      };
      this.markDirty();
      return true;
    }
    if (key === 'c' && selected) {
      this.confirm = {
        subject: { path: selected.path, action: 'cleanup' },
        label: `worktree ${basename(selected.path)} (${selected.branch})`,
        verb: 'Clean up',
      };
      this.markDirty();
      return true;
    }
    if ((key === 'enter' || key === 'return') && selected && (selected.sessionId || selected.taskId)) {
      this.pendingJump = { targetPanel: selected.sessionId ? 'sessions' : 'tasks' };
      return true;
    }

    return super.handleInput(key);
  }

  /**
   * Enter on an attached worktree row jumps to the owning session/task panel.
   * The actual `PanelManager.open()` call requires the integration context,
   * which is only available here (invoked right after `handleInput` returns
   * `true` for the same key) — same staged-pending-action pattern as
   * `incident-review-panel.ts`.
   */
  public handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (this.pendingJump) {
      const jump = this.pendingJump;
      this.pendingJump = null;
      ctx.panelManager.open(jump.targetPanel);
      return true;
    }
    return false;
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
      this.requestRender();
    }
  }

  private async _cleanup(path: string): Promise<void> {
    try {
      await this.worktreeRegistry.cleanup(path);
    } catch (err) {
      this.setError(summarizeError(err));
    } finally {
      await this.refresh();
    }
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;

    if (this.confirm) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Worktree Control Room',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

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
        ],
      };
      const resolvedWorktreesSection = resolvePrimaryScrollableSection(width, height, {
        intro: 'Orchestrator-owned worktree lifecycle, attachments, pause/resume posture, and cleanup state.',
        footerLines: [buildKeyboardHints(width, WORKTREE_HINTS, C)],
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

    const errorLine = this.renderErrorLine(width);
    if (errorLine) sections.push({ title: 'Error', lines: [errorLine] });

    const lines = buildPanelWorkspace(width, height, {
      title: 'Worktree Control Room',
      intro: 'Orchestrator-owned worktree lifecycle, attachments, pause/resume posture, and cleanup state.',
      sections,
      footerLines: [buildKeyboardHints(width, WORKTREE_HINTS, C)],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
