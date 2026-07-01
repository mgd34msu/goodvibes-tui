import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { WorkPlanPanel } from '../../panels/work-plan-panel.ts';
import { WorkPlanStore } from '../../work-plans/work-plan-store.ts';

function text(lines: ReturnType<WorkPlanPanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
}

function makeStore(): WorkPlanStore {
  return new WorkPlanStore({
    homeDirectory: mkdtempSync(join(tmpdir(), 'gv-work-plan-panel-')),
    projectId: 'project:panel',
    projectRoot: '/tmp/panel',
  });
}

describe('WorkPlanPanel', () => {
  test('renders persistent work plan items and metadata', () => {
    const store = makeStore();
    store.addItem('Confirm WRFC chain topology', { owner: 'tui', source: 'sdk-handoff' });

    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    const rendered = text(panel.render(120, 28));

    expect(rendered).toContain('Persistent Work Plan');
    expect(rendered).toContain('Confirm WRFC chain topology');
    expect(rendered).toContain('@tui');
    expect(rendered).toContain('sdk-handoff');
  });

  test('surfaces progress and a context-aware footer', () => {
    const store = makeStore();
    store.addItem('First task');
    const second = store.addItem('Second task');
    store.setItemStatus(second.id, 'done');

    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    const rendered = text(panel.render(120, 28));

    // Progress meter reflects 1/2 done at 50%.
    expect(rendered).toContain('Progress');
    expect(rendered).toContain('1/2');
    expect(rendered).toContain('50%');
    // Footer advertises the keys that actually work on a populated plan.
    expect(rendered).toContain('cycle status');
    expect(rendered).toContain('clear done');
  });

  test('shows a detail block for the selected item', () => {
    const store = makeStore();
    store.addItem('Inspect detail block', { owner: 'tui', notes: 'verify rendering' });

    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    const rendered = text(panel.render(120, 28));

    expect(rendered).toContain('Selected item');
    expect(rendered).toContain('verify rendering');
  });

  test('empty plan offers an actionable next step', () => {
    const store = makeStore();
    const panel = new WorkPlanPanel(store);
    panel.onActivate();
    const rendered = text(panel.render(120, 28));

    expect(rendered).toContain('No work plan items yet');
    expect(rendered).toContain('/work-plan add');
  });

  test('keyboard status changes persist through the store', () => {
    const store = makeStore();
    const item = store.addItem('Add panel tests');
    const panel = new WorkPlanPanel(store);
    panel.onActivate();

    expect(panel.handleInput('2')).toBe(true);
    expect(store.getActivePlan().items.find((entry) => entry.id === item.id)?.status).toBe('in_progress');

    expect(panel.handleInput('4')).toBe(true);
    expect(store.getActivePlan().items.find((entry) => entry.id === item.id)?.status).toBe('done');

    expect(panel.handleInput('c')).toBe(true);
    expect(store.getActivePlan().items).toHaveLength(0);
  });
});
