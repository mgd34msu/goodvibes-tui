import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import type { WorkPlanItemStatus } from '../../work-plans/work-plan-store.ts';

// ---------------------------------------------------------------------------
// Work Plan → config-modal surface (W6.1 group-B port). Lists the active
// persistent plan's checklist items with a progress summary + status counts.
// All mutations (add/edit item, cycle/set status, remove, clear-completed)
// route to the existing `/work-plan` command path (charter: no
// destructive/interactive mutation direct-called from a modal; the panel's
// inline add/edit draft form has no place in a read/navigate modal — the bare
// `/work-plan add` subcommand is the honest stand-in). Selection-blind port:
// the panel's selected-item owner/source/notes/linked detail is folded into
// each row label.
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<WorkPlanItemStatus, string> = {
  pending: '[ ]', in_progress: '[>]', blocked: '[!]', done: '[x]', failed: '[x]', cancelled: '[-]',
};

/** `/work-plan <subcommand> <id>` for each status. */
const STATUS_COMMAND: Record<WorkPlanItemStatus, string> = {
  pending: 'pending', in_progress: 'start', blocked: 'block', done: 'done', failed: 'fail', cancelled: 'cancel',
};

const STATUS_ORDER: readonly WorkPlanItemStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'];

interface WorkPlanLinkTargetsLike { readonly agentId?: string | undefined; readonly wrfcId?: string | undefined; readonly taskId?: string | undefined; readonly sessionId?: string | undefined; }
interface WorkPlanItemLike { readonly id: string; readonly title: string; readonly status: WorkPlanItemStatus; readonly owner?: string | undefined; readonly source?: string | undefined; readonly notes?: string | undefined; readonly linked?: WorkPlanLinkTargetsLike | undefined; readonly updatedAt: number; }
interface WorkPlanLike { readonly projectRoot: string; readonly items: readonly WorkPlanItemLike[]; }

export interface WorkPlanModalDeps {
  readonly workPlanStore: { getActivePlan(): WorkPlanLike };
}

function compactDate(value: number): string { return new Date(value).toISOString().replace('T', ' ').slice(0, 16); }

function progressBar(pct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${pct}%`;
}

function linkedSegments(linked: WorkPlanLinkTargetsLike | undefined): string {
  if (!linked) return '';
  return [
    linked.agentId ? `agent:${linked.agentId}` : null,
    linked.wrfcId ? `wrfc:${linked.wrfcId}` : null,
    linked.taskId ? `task:${linked.taskId}` : null,
    linked.sessionId ? `session:${linked.sessionId}` : null,
  ].filter((s): s is string => s !== null).join('  ');
}

class WorkPlanModalSurface implements ConfigModalSurface {
  readonly name = 'work-plan-modal';
  readonly title = 'Work Plan';
  private projectRoot = '';
  private items: WorkPlanItemLike[] = [];

  constructor(private readonly deps: WorkPlanModalDeps) {}

  private readonly hasRow = (row: ConfigModalRow | null): boolean => row !== null;

  readonly actions = [
    { key: 'enter', id: 'cycleStatus', label: 'cycle status', enabledFor: this.hasRow },
    { key: '1', id: 'setPending', label: 'pending', enabledFor: this.hasRow },
    { key: '2', id: 'setInProgress', label: 'start', enabledFor: this.hasRow },
    { key: '3', id: 'setBlocked', label: 'block', enabledFor: this.hasRow },
    { key: '4', id: 'setDone', label: 'done', enabledFor: this.hasRow },
    { key: '5', id: 'setFailed', label: 'fail', enabledFor: this.hasRow },
    { key: '6', id: 'setCancelled', label: 'cancel', enabledFor: this.hasRow },
    { key: 'd', id: 'remove', label: 'delete', enabledFor: this.hasRow },
    { key: 'c', id: 'clearCompleted', label: 'clear done' },
    { key: 'a', id: 'add', label: 'add' },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  onOpen(): void { this.refresh(); }

  private refresh(): void {
    const plan = this.deps.workPlanStore.getActivePlan();
    this.projectRoot = plan.projectRoot;
    this.items = [...plan.items];
  }

  private itemFrom(id: string): WorkPlanItemLike | undefined { return this.items.find((i) => i.id === id); }

  buildView(): ConfigModalView {
    const counts = new Map<WorkPlanItemStatus, number>();
    for (const status of STATUS_ORDER) counts.set(status, 0);
    for (const item of this.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    const total = this.items.length;
    const done = (counts.get('done') ?? 0) + (counts.get('cancelled') ?? 0);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const header = [
      `Project ${this.projectRoot}`,
      progressBar(pct),
      `pending ${counts.get('pending') ?? 0}  active ${counts.get('in_progress') ?? 0}  blocked ${counts.get('blocked') ?? 0}  done ${counts.get('done') ?? 0}  failed ${counts.get('failed') ?? 0}  cancelled ${counts.get('cancelled') ?? 0}`,
    ];

    const rows: ConfigModalRow[] = this.items.map((item) => {
      const owner = item.owner ? ` @${item.owner}` : '';
      const source = item.source ? ` (${item.source})` : '';
      const notes = item.notes ? ` · ${item.notes}` : '';
      const linked = linkedSegments(item.linked);
      const linkPart = linked ? ` · ${linked}` : '';
      return { id: item.id, label: `${STATUS_LABEL[item.status]} ${item.title}${owner}${source}  updated ${compactDate(item.updatedAt)}${notes}${linkPart}` };
    });

    return { title: 'Work Plan', tabs: [{ id: 'items', label: 'Items', header, rows, emptyText: 'No work plan items yet.', hints: ['enter cycle status', '1-6 set status', 'd delete', 'c clear done', 'a add'] }] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.refresh(); ctx.setStatus('Reloaded work plan.'); return; }
    if (id === 'clearCompleted') { void ctx.executeCommand?.('work-plan', ['clear-done']); ctx.setStatus('Dispatched /work-plan clear-done.'); return; }
    if (id === 'add') { void ctx.executeCommand?.('work-plan', ['add']); ctx.setStatus('Type the rest on the command line: /work-plan add <title>.'); return; }
    const item = ctx.row ? this.itemFrom(ctx.row.id) : undefined;
    if (!item) return;
    if (id === 'cycleStatus') { void ctx.executeCommand?.('work-plan', ['cycle', item.id]); ctx.setStatus(`Dispatched /work-plan cycle ${item.id}.`); return; }
    if (id === 'remove') { void ctx.executeCommand?.('work-plan', ['remove', item.id]); ctx.setStatus(`Dispatched /work-plan remove ${item.id}.`); return; }
    const status: WorkPlanItemStatus | null =
      id === 'setPending' ? 'pending' : id === 'setInProgress' ? 'in_progress' : id === 'setBlocked' ? 'blocked'
      : id === 'setDone' ? 'done' : id === 'setFailed' ? 'failed' : id === 'setCancelled' ? 'cancelled' : null;
    if (!status) return;
    void ctx.executeCommand?.('work-plan', [STATUS_COMMAND[status], item.id]);
    ctx.setStatus(`Dispatched /work-plan ${STATUS_COMMAND[status]} ${item.id}.`);
  }
}

export function createWorkPlanModalSurface(deps: WorkPlanModalDeps): ConfigModalSurface {
  return new WorkPlanModalSurface(deps);
}

/**
 * Deterministic golden fixture: fixed work-plan items with frozen updatedAt
 * epoch values — no live store, no wall-clock, no random ids.
 */
export function workPlanModalGoldenSurface(): ConfigModalSurface {
  const FIXED_UPDATED_AT = 1735693200000; // 2025-01-01T01:00:00.000Z
  const items: readonly WorkPlanItemLike[] = [
    { id: 'wpi-fixed001', title: 'Migrate KNOWLEDGE/MEMORY/WORK-PLAN panels to modals', status: 'in_progress', owner: 'wo-b', source: 'tui-panel', notes: 'Charter: read/navigate only; mutations route to the command path.', linked: { agentId: 'agent-fixed-1' }, updatedAt: FIXED_UPDATED_AT },
    { id: 'wpi-fixed002', title: 'Wire modal host redirects', status: 'pending', updatedAt: FIXED_UPDATED_AT },
  ];
  return createWorkPlanModalSurface({ workPlanStore: { getActivePlan: () => ({ projectRoot: '/fixed/project', items }) } });
}
