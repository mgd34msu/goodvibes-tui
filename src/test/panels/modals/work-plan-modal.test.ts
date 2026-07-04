import { describe, test, expect } from 'bun:test';
import { bindWorkPlanModal, workPlanModalGoldenSurface, type WorkPlanModalDeps } from '../../../panels/modals/work-plan-modal.ts';
import { EMPTY_VIEW } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';

/** Flatten a ModalConfig's text/list/title content into one searchable string. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

const FIXED_UPDATED_AT = 1735693200000; // 2025-01-01T01:00:00.000Z

function fixedDeps(): WorkPlanModalDeps {
  const items = [
    {
      id: 'wpi-a',
      title: 'Ship WO-B',
      status: 'in_progress' as const,
      owner: 'wo-b',
      source: 'tui-panel',
      notes: 'Route mutations to commands.',
      linked: { agentId: 'agent-1' },
      updatedAt: FIXED_UPDATED_AT,
    },
    {
      id: 'wpi-b',
      title: 'Wire redirects',
      status: 'pending' as const,
      updatedAt: FIXED_UPDATED_AT,
    },
    {
      id: 'wpi-c',
      title: 'Archive old panel',
      status: 'done' as const,
      updatedAt: FIXED_UPDATED_AT,
    },
  ];
  return {
    workPlanStore: {
      getActivePlan: () => ({ projectRoot: '/proj', items }),
    },
  };
}

describe('work-plan modal builder', () => {
  test('lists items with progress summary and status counts', () => {
    const surface = bindWorkPlanModal(fixedDeps());
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('Project /proj');
    expect(text).toContain('Ship WO-B');
    expect(text).toContain('@wo-b');
    expect(text).toContain('(tui-panel)');
    expect(text).toContain('pending 1  active 1  blocked 0  done 1');
    expect(text).toContain('33%'); // 1 done of 3
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['wpi-a', 'wpi-b', 'wpi-c']);
  });

  test('selected item detail includes notes and linked targets', () => {
    const surface = bindWorkPlanModal(fixedDeps());
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('notes Route mutations to commands.');
    expect(text).toContain('linked agent:agent-1');
  });

  test('empty plan renders an honest empty state', () => {
    const surface = bindWorkPlanModal({ workPlanStore: { getActivePlan: () => ({ projectRoot: '/empty', items: [] }) } });
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('No work plan items yet.');
    expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(0);
  });

  test('cycle/status/delete/clear/add actions route to /work-plan commands (no direct store mutation)', () => {
    const surface = bindWorkPlanModal(fixedDeps());
    surface.refresh();
    expect(surface.actions.cycleStatus!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/work-plan cycle wpi-a' });
    expect(surface.actions.setDone!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/work-plan done wpi-a' });
    expect(surface.actions.setBlocked!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/work-plan block wpi-a' });
    expect(surface.actions.remove!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/work-plan remove wpi-a' });
    expect(surface.actions.clearCompleted!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/work-plan clear-done' });
    expect(surface.actions.add!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/work-plan add ' });
  });

  test('actions against an empty plan are a no-op', () => {
    const surface = bindWorkPlanModal({ workPlanStore: { getActivePlan: () => ({ projectRoot: '/empty', items: [] }) } });
    surface.refresh();
    expect(surface.actions.cycleStatus!(EMPTY_VIEW)).toEqual({ kind: 'none' });
    expect(surface.actions.remove!(EMPTY_VIEW)).toEqual({ kind: 'none' });
  });

  test('golden surface renders a deterministic byte-stable config across two calls', () => {
    const a = configText(workPlanModalGoldenSurface().buildConfig(EMPTY_VIEW));
    const b = configText(workPlanModalGoldenSurface().buildConfig(EMPTY_VIEW));
    expect(a).toBe(b);
    expect(a).toContain('Migrate KNOWLEDGE/MEMORY/WORK-PLAN panels to modals');
  });
});
