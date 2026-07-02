import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { WorkPlanStore } from '../../work-plans/work-plan-store.ts';

function makeStore(): WorkPlanStore {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'gv-work-plan-'));
  return new WorkPlanStore({
    homeDirectory,
    projectId: 'project:test-workspace',
    projectRoot: '/tmp/test-workspace',
  });
}

describe('WorkPlanStore', () => {
  test('persists workspace-scoped work plan items', () => {
    const store = makeStore();
    const item = store.addItem('Patch WRFC task routing', {
      owner: 'tui',
      source: 'manual',
      notes: 'Keep visible until verified.',
    });
    store.setItemStatus(item.id, 'in_progress');

    const reloaded = new WorkPlanStore({
      homeDirectory: store.filePath.split('/.goodvibes/')[0]!,
      projectId: 'project:test-workspace',
      projectRoot: '/tmp/test-workspace',
    });
    const plan = reloaded.getActivePlan();
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.title).toBe('Patch WRFC task routing');
    expect(plan.items[0]?.status).toBe('in_progress');
    expect(plan.items[0]?.owner).toBe('tui');
  });

  test('supports prefix updates, cycling, and completed cleanup', () => {
    const store = makeStore();
    const first = store.addItem('First item');
    const second = store.addItem('Second item');

    const started = store.cycleItemStatus(first.id.slice(0, 8));
    expect(started.status).toBe('in_progress');
    const done = store.cycleItemStatus(first.id);
    expect(done.status).toBe('done');

    store.setItemStatus(second.id, 'cancelled');
    expect(store.clearCompleted()).toBe(2);
    expect(store.listItems()).toHaveLength(0);
  });

  test('renders markdown summary with statuses and metadata', () => {
    const store = makeStore();
    const item = store.addItem('Write handoff', { owner: 'sdk', source: 'coordination' });
    store.setItemStatus(item.id, 'blocked');

    const markdown = store.toMarkdown();
    expect(markdown).toContain('# Work Plan');
    expect(markdown).toContain('Write handoff (blocked)');
    expect(markdown).toContain('Owner: sdk');
    expect(markdown).toContain('Source: coordination');
  });

  test('exportMarkdown writes toMarkdown() output to a sibling .md file', () => {
    const store = makeStore();
    store.addItem('Export this item', { owner: 'tui' });

    const { path, markdown } = store.exportMarkdown();
    expect(path).toBe(store.filePath.replace(/\.json$/, '.md'));
    expect(markdown).toContain('Export this item');

    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk.trim()).toBe(markdown);
  });
});
