import { describe, test, expect } from 'bun:test';
import { createWorkPlanModalSurface, type WorkPlanModalDeps } from '../../../panels/modals/work-plan-modal.ts';
import { actionCtx, captureCommands, open, tabText } from './modal-surface-test-helpers.ts';

const FIXED = 1735693200000;
function fixedDeps(): WorkPlanModalDeps {
  const items = [
    { id: 'wpi-a', title: 'Ship WO-P', status: 'in_progress' as const, owner: 'wo-p', source: 'tui-panel', notes: 'Route mutations to commands.', linked: { agentId: 'agent-1' }, updatedAt: FIXED },
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
    expect(text).toContain('Ship WO-P');
    expect(text).toContain('@wo-p');
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
});
