import { describe, test, expect } from 'bun:test';
import { createWorkPlanModalSurface, type WorkPlanModalDeps } from '../../../panels/modals/work-plan-modal.ts';
import { actionCtx, captureCommands, open, tabText } from './modal-surface-test-helpers.ts';

const FIXED = 1735693200000;
function fixedDeps(): WorkPlanModalDeps {
  const items = [
    { id: 'wpi-a', title: 'Ship the redirect fix', status: 'in_progress' as const, owner: 'alex', source: 'tui-panel', notes: 'Route mutations to commands.', linked: { agentId: 'agent-1' }, updatedAt: FIXED },
    { id: 'wpi-b', title: 'Wire redirects', status: 'pending' as const, updatedAt: FIXED },
    { id: 'wpi-c', title: 'Archive old panel', status: 'done' as const, updatedAt: FIXED },
  ];
  return { workPlanStore: { getActivePlan: () => ({ projectRoot: '/proj', items }) } };
}

describe('work-plan modal surface', () => {
  test('surface identity', () => { expect(createWorkPlanModalSurface(fixedDeps()).name).toBe('work-plan-modal'); });

  test('lists items with progress summary, counts, and folded notes/linked detail', () => {
    const view = open(createWorkPlanModalSurface(fixedDeps()));
    const text = tabText(view, 'items');
    expect(text).toContain('Project /proj');
    expect(text).toContain('Ship the redirect fix');
    expect(text).toContain('@alex');
    expect(text).toContain('(tui-panel)');
    expect(text).toContain('pending 1  active 1  blocked 0  done 1');
    expect(text).toContain('33%');
    expect(text).toContain('Route mutations to commands.'); // folded notes
    expect(text).toContain('agent:agent-1'); // folded linked
    expect(view.tabs[0]!.rows.map((r) => r.id)).toEqual(['wpi-a', 'wpi-b', 'wpi-c']);
  });

  test('empty plan renders an honest empty state', () => {
    const view = open(createWorkPlanModalSurface({ workPlanStore: { getActivePlan: () => ({ projectRoot: '/empty', items: [] }) } }));
    expect(view.tabs[0]!.emptyText).toContain('No work plan items yet.');
    expect(view.tabs[0]!.rows).toHaveLength(0);
  });

  test('cycle/status/delete/clear/add actions route to /work-plan commands', () => {
    const surface = createWorkPlanModalSurface(fixedDeps());
    open(surface);
    const row = { id: 'wpi-a', label: '' };
    const check = (id: string, r: typeof row | null, expected: [string, string[]][]): void => {
      const cap = captureCommands();
      surface.onAction?.(id, actionCtx(r, cap.extra));
      expect(cap.calls).toEqual(expected);
    };
    check('cycleStatus', row, [['work-plan', ['cycle', 'wpi-a']]]);
    check('setDone', row, [['work-plan', ['done', 'wpi-a']]]);
    check('setBlocked', row, [['work-plan', ['block', 'wpi-a']]]);
    check('remove', row, [['work-plan', ['remove', 'wpi-a']]]);
    check('clearCompleted', null, [['work-plan', ['clear-done']]]);
    check('add', null, [['work-plan', ['add']]]);
  });

  test('row-scoped actions against an empty plan are a no-op', () => {
    const surface = createWorkPlanModalSurface({ workPlanStore: { getActivePlan: () => ({ projectRoot: '/empty', items: [] }) } });
    open(surface);
    const cap = captureCommands();
    surface.onAction?.('cycleStatus', actionCtx({ id: 'wpi-x', label: '' }, cap.extra));
    surface.onAction?.('remove', actionCtx({ id: 'wpi-x', label: '' }, cap.extra));
    expect(cap.calls).toEqual([]);
  });

  // ── item 4: restored 'i'/'w' agent/WRFC-chain jumps into Fleet ─────
  describe('i/w fleet deep-links', () => {
    test('i (jumpAgent) on an item linked to an agent dispatches /panel open fleet --target <agentId>:agent', () => {
      const surface = createWorkPlanModalSurface(fixedDeps());
      open(surface);
      const cap = captureCommands();
      surface.onAction?.('jumpAgent', actionCtx({ id: 'wpi-a', label: '' }, cap.extra));
      expect(cap.calls).toEqual([['panel', ['open', 'fleet', '--target', 'agent-1:agent']]]);
    });

    test('w (jumpWrfc) on an item linked to a WRFC chain dispatches /panel open fleet --target <wrfcId>:wrfc-chain', () => {
      const deps: WorkPlanModalDeps = {
        workPlanStore: {
          getActivePlan: () => ({
            projectRoot: '/proj',
            items: [{ id: 'wpi-w', title: 'Chain item', status: 'in_progress' as const, linked: { wrfcId: 'wrfc-9' }, updatedAt: FIXED }],
          }),
        },
      };
      const surface = createWorkPlanModalSurface(deps);
      open(surface);
      const cap = captureCommands();
      surface.onAction?.('jumpWrfc', actionCtx({ id: 'wpi-w', label: '' }, cap.extra));
      expect(cap.calls).toEqual([['panel', ['open', 'fleet', '--target', 'wrfc-9:wrfc-chain']]]);
    });

    test('i/w are gated to items that actually carry the matching link (enabledFor)', () => {
      const surface = createWorkPlanModalSurface(fixedDeps()); // wpi-a: agent link only; wpi-b/wpi-c: no links
      open(surface);
      const jumpAgent = surface.actions?.find((a) => a.id === 'jumpAgent')!;
      const jumpWrfc = surface.actions?.find((a) => a.id === 'jumpWrfc')!;
      expect(jumpAgent.enabledFor?.({ id: 'wpi-a', label: '' }, 'items')).toBe(true);
      expect(jumpAgent.enabledFor?.({ id: 'wpi-b', label: '' }, 'items')).toBe(false);
      expect(jumpWrfc.enabledFor?.({ id: 'wpi-a', label: '' }, 'items')).toBe(false); // has agent, not wrfc
      expect(jumpAgent.enabledFor?.(null, 'items')).toBe(false);
    });

    test('jumpAgent/jumpWrfc on a row with no linked target are a no-op (defensive; enabledFor should already have excluded them)', () => {
      const surface = createWorkPlanModalSurface(fixedDeps());
      open(surface);
      const cap = captureCommands();
      surface.onAction?.('jumpAgent', actionCtx({ id: 'wpi-b', label: '' }, cap.extra)); // no linked.agentId
      surface.onAction?.('jumpWrfc', actionCtx({ id: 'wpi-a', label: '' }, cap.extra)); // no linked.wrfcId
      expect(cap.calls).toEqual([]);
    });
  });
});
