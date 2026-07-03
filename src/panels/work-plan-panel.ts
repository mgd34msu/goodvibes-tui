import type { Line } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildDetailBlock,
  buildKeyboardHints,
  buildKeyValueLine,
  buildMeterLine,
  buildPanelLine,
  buildPanelListRow,
  buildSummaryBlock,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelPalette,
} from './polish.ts';
import type { WorkPlanItem, WorkPlanItemStatus, WorkPlanStore } from '../work-plans/work-plan-store.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { isTextBackspace } from '../input/delete-key-policy.ts';
import { AgentInspectorPanel } from './agent-inspector-panel.ts';
import { WrfcPanel } from './wrfc-panel.ts';
import type { PanelIntegrationContext } from './types.ts';

type WorkPlanDraftField = 'title' | 'owner' | 'notes';

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  pending: '#94a3b8',
  inProgress: '#38bdf8',
  blocked: '#f59e0b',
  done: '#22c55e',
  failed: '#ef4444',
  cancelled: '#64748b',
  accent: '#a5b4fc',
  selectBg: '#1e293b',
});

const STATUS_LABEL: Record<WorkPlanItemStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  blocked: '[!]',
  done: '[x]',
  failed: '[x]',
  cancelled: '[-]',
};

const STATUS_COLOR: Record<WorkPlanItemStatus, string> = {
  pending: C.pending,
  in_progress: C.inProgress,
  blocked: C.blocked,
  done: C.done,
  failed: C.failed,
  cancelled: C.cancelled,
};

const STATUS_ORDER: WorkPlanItemStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'];

function compactDate(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}

function statusName(status: WorkPlanItemStatus): string {
  return status.replace(/_/g, ' ');
}

export class WorkPlanPanel extends ScrollableListPanel<WorkPlanItem> {
  private items: readonly WorkPlanItem[] = [];
  private lastPlanUpdatedAt = 0;
  private lastStatus: string | null = null;

  // Draft-input state for 'a' (add) / 'e' (edit): a small modal-like field
  // editor inline in the header, following the same draft-buffer pattern as
  // ProjectPlanningPanel's typed-answer draft (Tab cycles fields, Enter
  // saves, Esc cancels, Backspace edits the active field).
  private draftMode: 'add' | 'edit' | null = null;
  private draftField: WorkPlanDraftField = 'title';
  private draftTitle = '';
  private draftOwner = '';
  private draftNotes = '';
  private draftEditingItemId: string | null = null;

  constructor(private readonly store: WorkPlanStore) {
    super('work-plan', 'Work Plan', '◧', 'agent');
    this.showSelectionGutter = true;
  }

  onActivate(): void {
    super.onActivate();
    this.refresh();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  render(width: number, height: number): Line[] {
    this.refresh();
    return this.renderList(width, height, {
      title: 'Work Plan',
      header: this.renderHeader(width),
      footer: this.renderFooter(width),
    });
  }

  handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (this.draftMode) {
      return this.handleDraftInput(key);
    }

    const item = this.getSelectedItem();
    try {
      switch (key) {
        case ' ':
        case 'return':
        case 'enter':
          if (!item) return false;
          this.store.cycleItemStatus(item.id);
          this.refresh();
          return true;
        case '1':
          return this.setSelectedStatus('pending');
        case '2':
          return this.setSelectedStatus('in_progress');
        case '3':
          return this.setSelectedStatus('blocked');
        case '4':
          return this.setSelectedStatus('done');
        case '5':
          return this.setSelectedStatus('failed');
        case '6':
          return this.setSelectedStatus('cancelled');
        case 'd':
        case 'delete':
          if (!item) return false;
          this.store.removeItem(item.id);
          this.refresh();
          return true;
        case 'c':
          this.store.clearCompleted();
          this.refresh();
          return true;
        case 'r':
          this.refresh(true);
          return true;
        case 'a':
          this.beginAddDraft();
          return true;
        case 'e':
          if (!item) return false;
          this.beginEditDraft(item);
          return true;
        case 'x':
          this.exportMarkdown();
          return true;
        // 'i'/'w' jump to the selected item's linked agent/WRFC chain. The
        // actual navigation happens in handlePanelIntegrationAction (it
        // needs the PanelManager); consuming the key here just requires the
        // linked target to exist so the router below fires next.
        case 'i':
          return item?.linked?.agentId !== undefined;
        case 'w':
          return item?.linked?.wrfcId !== undefined;
        default:
          return super.handleInput(key);
      }
    } catch (error) {
      this.setError(summarizeError(error));
      return true;
    }
  }

  /**
   * Cross-panel jumps: 'i' opens the Inspector focused on the selected
   * item's linked agent; 'w' opens the WRFC panel focused on its linked
   * chain.
   */
  handlePanelIntegrationAction(key: string, ctx: PanelIntegrationContext): boolean {
    const item = this.getSelectedItem();
    if (!item) return false;
    if (key === 'i') {
      const agentId = item.linked?.agentId;
      if (!agentId) return false;
      const inspector = ctx.panelManager.open('inspector');
      if (inspector instanceof AgentInspectorPanel) {
        inspector.inspectAgent(agentId);
        return true;
      }
      return false;
    }
    if (key === 'w') {
      const wrfcId = item.linked?.wrfcId;
      if (!wrfcId) return false;
      const wrfc = ctx.panelManager.open('wrfc');
      if (wrfc instanceof WrfcPanel) {
        wrfc.selectChain(wrfcId);
        return true;
      }
      return false;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Draft-input (add/edit)
  // -------------------------------------------------------------------------

  private handleDraftInput(key: string): boolean {
    if (key === 'escape') {
      this.cancelDraft();
      return true;
    }
    if (key === 'tab') {
      this.cycleDraftField();
      return true;
    }
    if (key === 'enter' || key === 'return') {
      this.commitDraft();
      return true;
    }
    if (isTextBackspace(key)) {
      this.setDraftFieldValue(this.getDraftFieldValue().slice(0, -1));
      return true;
    }
    if (key === 'space') {
      this.setDraftFieldValue(`${this.getDraftFieldValue()} `);
      return true;
    }
    if (this.isPrintableKey(key)) {
      this.setDraftFieldValue(`${this.getDraftFieldValue()}${key}`);
      return true;
    }
    // Absorb everything else (up/down/pageup/etc.) while drafting.
    return true;
  }

  private beginAddDraft(): void {
    this.draftMode = 'add';
    this.draftField = 'title';
    this.draftTitle = '';
    this.draftOwner = '';
    this.draftNotes = '';
    this.draftEditingItemId = null;
    this.lastStatus = null;
    this.needsRender = true;
  }

  private beginEditDraft(item: WorkPlanItem): void {
    this.draftMode = 'edit';
    this.draftField = 'title';
    this.draftTitle = item.title;
    this.draftOwner = item.owner ?? '';
    this.draftNotes = item.notes ?? '';
    this.draftEditingItemId = item.id;
    this.lastStatus = null;
    this.needsRender = true;
  }

  private cancelDraft(): void {
    this.draftMode = null;
    this.draftEditingItemId = null;
    this.needsRender = true;
  }

  private cycleDraftField(): void {
    const order: WorkPlanDraftField[] = ['title', 'owner', 'notes'];
    const next = order[(order.indexOf(this.draftField) + 1) % order.length];
    if (next) this.draftField = next;
    this.needsRender = true;
  }

  private getDraftFieldValue(): string {
    switch (this.draftField) {
      case 'title': return this.draftTitle;
      case 'owner': return this.draftOwner;
      case 'notes': return this.draftNotes;
    }
  }

  private setDraftFieldValue(value: string): void {
    switch (this.draftField) {
      case 'title': this.draftTitle = value; break;
      case 'owner': this.draftOwner = value; break;
      case 'notes': this.draftNotes = value; break;
    }
    this.needsRender = true;
  }

  private commitDraft(): void {
    const title = this.draftTitle.trim();
    if (!title) {
      this.setError('Work plan item title is required.');
      return;
    }
    try {
      if (this.draftMode === 'add') {
        this.store.addItem(title, {
          owner: this.draftOwner.trim() || undefined,
          notes: this.draftNotes.trim() || undefined,
          source: 'tui-panel',
        });
        this.lastStatus = 'Item added.';
      } else if (this.draftMode === 'edit' && this.draftEditingItemId) {
        this.store.updateItem(this.draftEditingItemId, {
          title,
          owner: this.draftOwner.trim() || null,
          notes: this.draftNotes.trim() || null,
        });
        this.lastStatus = 'Item updated.';
      }
      this.draftMode = null;
      this.draftEditingItemId = null;
      this.refresh(true);
    } catch (error) {
      this.setError(summarizeError(error));
    }
  }

  private isPrintableKey(key: string): boolean {
    return key.length === 1 && key >= ' ';
  }

  private exportMarkdown(): void {
    try {
      const { path } = this.store.exportMarkdown();
      this.lastStatus = `Exported to ${path}`;
    } catch (error) {
      this.setError(summarizeError(error));
    }
  }

  protected getItems(): readonly WorkPlanItem[] {
    return this.items;
  }

  protected override getEmptyStateMessage(): string {
    return ' No work plan items yet';
  }

  protected getEmptyStateActions(): Array<{ command: string; summary: string }> {
    // WO-160: '/work-plan add <title>' dropped — 'a' already opens an
    // in-panel add-item draft even from this empty state (see
    // beginAddDraft), so the printed command was a pure action substitute.
    return [
      { command: '/work-plan list', summary: 'print the current plan to the shell' },
    ];
  }

  protected renderItem(item: WorkPlanItem, _index: number, selected: boolean, width: number): Line {
    const status = STATUS_LABEL[item.status];
    const owner = item.owner ? ` @${item.owner}` : '';
    const source = item.source ? ` (${item.source})` : '';
    const reserve = status.length + owner.length + source.length + 4;
    const title = truncateDisplay(item.title, Math.max(6, width - reserve));
    return buildPanelListRow(width, [
      { text: `${status} `, fg: STATUS_COLOR[item.status], bold: item.status === 'in_progress' },
      { text: title, fg: selected ? C.value : C.label, bold: selected || item.status === 'in_progress' },
      { text: owner, fg: C.accent },
      { text: source, fg: C.dim },
    ], C, { selected, selectedBg: C.selectBg });
  }

  private setSelectedStatus(status: WorkPlanItemStatus): boolean {
    const item = this.getSelectedItem();
    if (!item) return false;
    this.store.setItemStatus(item.id, status);
    this.refresh();
    return true;
  }

  private refresh(force = false): void {
    const plan = this.store.getActivePlan();
    // updatedAt is bumped by every store mutation (addItem/updateItem/
    // removeItem/clearCompleted), so it alone is a sufficient staleness
    // check — no need to also compare item counts.
    if (!force && plan.updatedAt === this.lastPlanUpdatedAt) return;
    this.items = plan.items;
    this.lastPlanUpdatedAt = plan.updatedAt;
    this.clampSelection();
    this.needsRender = true;
  }

  private renderHeader(width: number): Line[] {
    if (this.draftMode) return this.renderDraftForm(width);
    const plan = this.store.getActivePlan();
    const counts = new Map<WorkPlanItemStatus, number>();
    for (const status of STATUS_ORDER) counts.set(status, 0);
    for (const item of plan.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);

    const total = plan.items.length;
    const done = (counts.get('done') ?? 0) + (counts.get('cancelled') ?? 0);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const meterWidth = Math.max(10, Math.min(26, width - 34));

    const postureLines: Line[] = [
      buildPanelLine(width, [
        [' Project ', C.label],
        [truncateDisplay(plan.projectRoot, Math.max(8, width - 11)), C.value],
      ]),
      buildMeterLine(width, Math.round((pct / 100) * meterWidth), meterWidth, {
        filled: pct === 100 ? C.done : C.inProgress,
        empty: C.empty,
        label: C.label,
      }, { prefix: ' Progress ', suffix: ` ${done}/${total} (${pct}%) ` }),
      buildKeyValueLine(width, [
        { label: 'pending', value: String(counts.get('pending') ?? 0), valueColor: (counts.get('pending') ?? 0) > 0 ? C.pending : C.dim },
        { label: 'active', value: String(counts.get('in_progress') ?? 0), valueColor: (counts.get('in_progress') ?? 0) > 0 ? C.inProgress : C.dim },
        { label: 'blocked', value: String(counts.get('blocked') ?? 0), valueColor: (counts.get('blocked') ?? 0) > 0 ? C.blocked : C.dim },
        { label: 'done', value: String(counts.get('done') ?? 0), valueColor: (counts.get('done') ?? 0) > 0 ? C.done : C.dim },
      ], C),
      // WO-160: dropped the printed '/work-plan add <title>' guidance line —
      // 'a' already opens an in-panel add-item draft (see beginAddDraft /
      // handleDraftInput) and is advertised in the footer's 'a: add' hint,
      // so the printed command was a pure action substitute.
    ];

    const header: Line[] = buildSummaryBlock(width, 'Persistent Work Plan', postureLines, C);

    const active = this.getSelectedItem();
    if (active) {
      const detailRows: Line[] = [
        buildPanelLine(width, [
          [' ', C.label],
          [STATUS_LABEL[active.status], STATUS_COLOR[active.status]],
          [' ', C.label],
          [truncateDisplay(active.title, Math.max(8, width - 6)), C.value],
        ]),
        buildKeyValueLine(width, [
          { label: 'status', value: statusName(active.status), valueColor: STATUS_COLOR[active.status] },
          ...(active.owner ? [{ label: 'owner', value: active.owner, valueColor: C.accent }] : []),
          { label: 'updated', value: compactDate(active.updatedAt), valueColor: C.dim },
        ], C),
      ];
      if (active.source) {
        detailRows.push(buildPanelLine(width, [[' source ', C.label], [active.source, C.info]]));
      }
      if (active.notes) {
        detailRows.push(buildPanelLine(width, [
          [' notes ', C.label],
          [truncateDisplay(active.notes, Math.max(8, width - 8)), C.value],
        ]));
      }
      const linkedSegments = this.buildLinkedSegments(active);
      if (linkedSegments.length > 0) {
        detailRows.push(buildPanelLine(width, [[' linked ', C.label], ...linkedSegments]));
      }
      header.push(...buildDetailBlock(width, 'Selected item', detailRows, C));
    }
    return header;
  }

  /** Renders item.linked (agentId/wrfcId/taskId/sessionId) with their jump keys. */
  private buildLinkedSegments(item: WorkPlanItem): Array<[string, string]> {
    const linked = item.linked;
    if (!linked) return [];
    const segments: Array<[string, string]> = [];
    if (linked.agentId) segments.push([`agent:${linked.agentId} (i) `, C.info]);
    if (linked.wrfcId) segments.push([`wrfc:${linked.wrfcId} (w) `, C.info]);
    if (linked.taskId) segments.push([`task:${linked.taskId} `, C.dim]);
    if (linked.sessionId) segments.push([`session:${linked.sessionId} `, C.dim]);
    return segments;
  }

  private renderDraftForm(width: number): Line[] {
    const title = this.draftMode === 'add' ? 'Add Work Plan Item' : 'Edit Work Plan Item';
    const field = (label: string, value: string, key: WorkPlanDraftField): Line => {
      const active = key === this.draftField;
      const text = active ? `${value}▏` : (value || '(empty)');
      return buildPanelLine(width, [
        [` ${label.padEnd(6)} `, C.label],
        [truncateDisplay(text, Math.max(8, width - 10)), active ? C.value : C.dim],
      ]);
    };
    return buildSummaryBlock(width, title, [
      buildPanelLine(width, [[' Tab next field  Enter save  Esc cancel', C.dim]]),
      field('Title', this.draftTitle, 'title'),
      field('Owner', this.draftOwner, 'owner'),
      field('Notes', this.draftNotes, 'notes'),
    ], C);
  }

  private renderFooter(width: number): Line[] {
    if (this.draftMode) {
      return [
        buildKeyboardHints(width, [
          { keys: 'Tab', label: 'next field' },
          { keys: 'Enter', label: 'save' },
          { keys: 'Esc', label: 'cancel' },
        ], C),
      ];
    }
    const hasItem = this.items.length > 0;
    if (!hasItem) {
      return [
        buildKeyboardHints(width, [
          { keys: '↑/↓', label: 'navigate' },
          { keys: 'a', label: 'add' },
        ], C),
      ];
    }
    const active = this.getSelectedItem();
    const hints: Array<{ keys: string; label: string }> = [
      { keys: this.items.length > 0 ? `${this.selectedIndex + 1}/${this.items.length}` : '0/0', label: 'item' },
      { keys: 'Enter', label: 'cycle status' },
      { keys: '1-6', label: 'set status' },
      { keys: 'a', label: 'add' },
      { keys: 'e', label: 'edit' },
      { keys: 'd', label: 'delete' },
      { keys: 'c', label: 'clear done' },
      { keys: 'x', label: 'export' },
      { keys: 'r', label: 'refresh' },
    ];
    if (active?.linked?.agentId) hints.push({ keys: 'i', label: 'jump agent' });
    if (active?.linked?.wrfcId) hints.push({ keys: 'w', label: 'jump wrfc' });
    const lines: Line[] = [
      buildKeyboardHints(width, hints, C),
      buildPanelLine(width, [
        [' 1', C.info], [' pending  ', C.dim],
        ['2', C.info], [' active  ', C.dim],
        ['3', C.info], [' blocked  ', C.dim],
        ['4', C.info], [' done  ', C.dim],
        ['5', C.info], [' failed  ', C.dim],
        ['6', C.info], [' cancelled', C.dim],
      ]),
    ];
    if (this.lastStatus) {
      lines.push(buildPanelLine(width, [[` ${this.lastStatus}`, C.good]]));
    }
    return lines;
  }
}
