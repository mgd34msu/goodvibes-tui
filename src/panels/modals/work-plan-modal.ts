import type { ModalConfig, ModalSection, ModalListItem } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';
import type { WorkPlanItemStatus } from '../../work-plans/work-plan-store.ts';

// ---------------------------------------------------------------------------
// Work Plan -> modal. WO-B (Wave-6): migrates WorkPlanPanel
// (src/panels/work-plan-panel.ts) to a BoundModalSurface. Read-model: the
// active persistent work plan's checklist items (WorkPlanStore.getActivePlan
// is the only call this module makes on the store).
//
// The panel has no text-filter mode (no '/' search — see
// work-plan-panel.ts's handleInput), so this modal doesn't add one either;
// it lists the full item set every render.
//
// All mutations (add item, edit item, cycle/set status, remove,
// clear-completed, export-to-file) are NOT called on the store here — they
// route to the existing `/work-plan` command path (charter: no
// destructive/interactive mutation direct-called from a modal builder; the
// panel's inline add/edit draft form is an interactive text-entry flow that
// has no place in a read/navigate modal).
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<WorkPlanItemStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  blocked: '[!]',
  done: '[x]',
  failed: '[x]',
  cancelled: '[-]',
};

/** `/work-plan <subcommand> <id>` for each status — mirrors STATUS_COMMANDS in src/input/commands/work-plan-runtime.ts. */
const STATUS_COMMAND: Record<WorkPlanItemStatus, string> = {
  pending: 'pending',
  in_progress: 'start',
  blocked: 'block',
  done: 'done',
  failed: 'fail',
  cancelled: 'cancel',
};

const STATUS_ORDER: readonly WorkPlanItemStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'];

/** Minimal read shape of `WorkPlanItem.linked` (../../work-plans/work-plan-store.ts). */
interface WorkPlanLinkTargetsLike {
  readonly agentId?: string | undefined;
  readonly wrfcId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
}

/** Minimal read shape of a `WorkPlanItem` (../../work-plans/work-plan-store.ts) this modal renders. */
interface WorkPlanItemLike {
  readonly id: string;
  readonly title: string;
  readonly status: WorkPlanItemStatus;
  readonly owner?: string | undefined;
  readonly source?: string | undefined;
  readonly notes?: string | undefined;
  readonly linked?: WorkPlanLinkTargetsLike | undefined;
  readonly updatedAt: number;
}

/** Minimal read shape of a `WorkPlan` (../../work-plans/work-plan-store.ts) this modal renders. */
interface WorkPlanLike {
  readonly projectRoot: string;
  readonly items: readonly WorkPlanItemLike[];
}

/**
 * Live deps this modal reads. Structurally-narrowed slice of `WorkPlanStore`
 * (../../work-plans/work-plan-store.ts) — only the one read call
 * `WorkPlanPanel` makes each render (getActivePlan). All mutation methods
 * (addItem/updateItem/setItemStatus/cycleItemStatus/removeItem/
 * clearCompleted/exportMarkdown) are intentionally excluded: those route to
 * the `/work-plan` command instead of being called from this module.
 */
export interface WorkPlanModalDeps {
  readonly workPlanStore: {
    getActivePlan(): WorkPlanLike;
  };
}

function compactDate(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}

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
  ].filter((segment): segment is string => segment !== null).join('  ');
}

/**
 * Work Plan (persistent checklist) -> modal. Lists the active plan's items
 * with a progress summary + status counts, and the selected item's detail
 * (owner/source/notes/linked targets).
 */
export function bindWorkPlanModal(deps: WorkPlanModalDeps): BoundModalSurface {
  let projectRoot = '';
  let items: WorkPlanItemLike[] = [];

  const refresh = (): void => {
    const plan = deps.workPlanStore.getActivePlan();
    projectRoot = plan.projectRoot;
    items = [...plan.items];
  };

  const clampedIndex = (view: ModalViewState): number => Math.max(0, Math.min(view.selectedIndex, items.length - 1));

  const selectedItem = (view: ModalViewState): WorkPlanItemLike | undefined => {
    if (items.length === 0) return undefined;
    return items[clampedIndex(view)];
  };

  const buildConfig = (view: ModalViewState): ModalConfig => {
    const sections: ModalSection[] = [];

    const counts = new Map<WorkPlanItemStatus, number>();
    for (const status of STATUS_ORDER) counts.set(status, 0);
    for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    const total = items.length;
    const done = (counts.get('done') ?? 0) + (counts.get('cancelled') ?? 0);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    sections.push({ type: 'text', content: `Project ${projectRoot}`, style: { dim: true } });
    sections.push({ type: 'text', content: progressBar(pct) });
    sections.push({
      type: 'text',
      content: `pending ${counts.get('pending') ?? 0}  active ${counts.get('in_progress') ?? 0}  blocked ${counts.get('blocked') ?? 0}  done ${counts.get('done') ?? 0}  failed ${counts.get('failed') ?? 0}  cancelled ${counts.get('cancelled') ?? 0}`,
      style: { dim: true },
    });
    sections.push({ type: 'separator' });

    const selectedIdx = clampedIndex(view);
    const listItems: ModalListItem[] = items.map((item, index) => {
      const owner = item.owner ? ` @${item.owner}` : '';
      const source = item.source ? ` (${item.source})` : '';
      return {
        label: `${STATUS_LABEL[item.status]} ${item.title}${owner}${source}`,
        selected: index === selectedIdx,
      };
    });
    if (listItems.length === 0) {
      sections.push({ type: 'text', content: 'No work plan items yet.', style: { dim: true } });
    } else {
      sections.push({ type: 'list', items: listItems });
    }

    const selected = selectedItem(view);
    if (selected) {
      sections.push({ type: 'separator' });
      sections.push({
        type: 'text',
        content: `status ${selected.status.replace(/_/g, ' ')}${selected.owner ? `  owner ${selected.owner}` : ''}  updated ${compactDate(selected.updatedAt)}`,
      });
      if (selected.source) sections.push({ type: 'text', content: `source ${selected.source}`, style: { dim: true } });
      if (selected.notes) sections.push({ type: 'text', content: `notes ${selected.notes}`, style: { dim: true } });
      const linked = linkedSegments(selected.linked);
      if (linked) sections.push({ type: 'text', content: `linked ${linked}`, style: { dim: true } });
    }

    return {
      title: 'Work Plan',
      width: 78,
      sections,
      hints: ['up/down move', 'enter cycle status', '1-6 set status', 'd delete', 'c clear done', 'r refresh'],
    };
  };

  const cycleStatus: ModalAction = (view) => {
    const item = selectedItem(view);
    if (!item) return { kind: 'none' };
    return { kind: 'runCommand', command: `/work-plan cycle ${item.id}` };
  };

  const setStatus = (status: WorkPlanItemStatus): ModalAction => (view) => {
    const item = selectedItem(view);
    if (!item) return { kind: 'none' };
    return { kind: 'runCommand', command: `/work-plan ${STATUS_COMMAND[status]} ${item.id}` };
  };

  const remove: ModalAction = (view) => {
    const item = selectedItem(view);
    if (!item) return { kind: 'none' };
    return { kind: 'runCommand', command: `/work-plan remove ${item.id}` };
  };

  const clearCompleted: ModalAction = () => ({ kind: 'runCommand', command: '/work-plan clear-done' });

  // The panel's 'a' key opens an inline add-item draft form (title/owner/
  // notes, Tab between fields) — a multi-field text-entry flow this
  // read/navigate modal does not reproduce. Handing the bare subcommand to
  // the command path is the closest honest equivalent: the host's command
  // line is where the user types the rest.
  const add: ModalAction = () => ({ kind: 'runCommand', command: '/work-plan add ' });

  return {
    name: 'work-plan',
    title: 'Work Plan',
    refresh,
    buildConfig,
    rowIds: () => items.map((item) => item.id),
    actions: {
      refresh: () => ({ kind: 'refresh' }),
      cycleStatus,
      setPending: setStatus('pending'),
      setInProgress: setStatus('in_progress'),
      setBlocked: setStatus('blocked'),
      setDone: setStatus('done'),
      setFailed: setStatus('failed'),
      setCancelled: setStatus('cancelled'),
      remove,
      clearCompleted,
      add,
    },
  };
}

/**
 * Deterministic golden fixture: fixed work-plan items with frozen
 * updatedAt epoch values — no live store, no wall-clock, no random ids —
 * so the rendered config is byte-stable across runs.
 */
export function workPlanModalGoldenSurface(): BoundModalSurface {
  const FIXED_UPDATED_AT = 1735693200000; // 2025-01-01T01:00:00.000Z
  const items: readonly WorkPlanItemLike[] = [
    {
      id: 'wpi-fixed001',
      title: 'Migrate KNOWLEDGE/MEMORY/WORK-PLAN panels to modals',
      status: 'in_progress',
      owner: 'wo-b',
      source: 'tui-panel',
      notes: 'Charter: read/navigate only; mutations route to the command path.',
      linked: { agentId: 'agent-fixed-1' },
      updatedAt: FIXED_UPDATED_AT,
    },
    {
      id: 'wpi-fixed002',
      title: 'Wire modal host redirects',
      status: 'pending',
      updatedAt: FIXED_UPDATED_AT,
    },
  ];
  const surface = bindWorkPlanModal({
    workPlanStore: {
      getActivePlan: () => ({ projectRoot: '/fixed/project', items }),
    },
  });
  surface.refresh();
  return surface;
}
