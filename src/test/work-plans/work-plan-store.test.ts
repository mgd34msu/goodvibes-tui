import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  WORK_PLAN_QUARANTINE_CAP,
  WORK_PLAN_TERMINAL_ITEM_CAP,
  WorkPlanStore,
  type WorkPlanItemStatus,
} from '../../work-plans/work-plan-store.ts';

function makeStore(): WorkPlanStore {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'gv-work-plan-'));
  return new WorkPlanStore({
    homeDirectory,
    projectId: 'project:test-workspace',
    projectRoot: '/tmp/test-workspace',
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Write raw bytes at the store's plan path, simulating whatever a crash left behind. */
function writeRawPlanFile(store: WorkPlanStore, contents: string): void {
  mkdirSync(dirname(store.filePath), { recursive: true });
  writeFileSync(store.filePath, contents, 'utf8');
}

function quarantineFiles(store: WorkPlanStore): string[] {
  const prefix = `${basename(store.filePath)}.corrupt-`;
  try {
    return readdirSync(dirname(store.filePath)).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
}

interface RawItem {
  readonly id: string;
  readonly title: string;
  readonly status: WorkPlanItemStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

function writePlanWithItems(store: WorkPlanStore, items: readonly RawItem[], stamp: number): void {
  writeRawPlanFile(store, JSON.stringify({
    id: 'wp-fixture',
    projectId: 'project:test-workspace',
    projectRoot: '/tmp/test-workspace',
    title: 'Work Plan',
    source: 'tui',
    createdAt: stamp,
    updatedAt: stamp,
    items,
  }));
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

describe('WorkPlanStore crash recovery (content, not existence)', () => {
  test('a zero-byte plan file is rejected, not served, and no method throws', () => {
    const store = makeStore();
    writeRawPlanFile(store, '');

    // A file that EXISTS is not a file that is VALID.
    expect(() => store.listItems()).not.toThrow();
    expect(store.listItems()).toHaveLength(0);
    expect(() => store.getActivePlan()).not.toThrow();
    expect(() => store.toMarkdown()).not.toThrow();
    expect(() => store.clearCompleted()).not.toThrow();
    expect(() => store.exportMarkdown()).not.toThrow();

    // Nothing was worth preserving, so no quarantine copy is left behind.
    expect(quarantineFiles(store)).toHaveLength(0);
    // ...but the reset is still disclosed.
    expect(store.getActivePlan().housekeeping?.resetFromUnreadableFile).toBe(true);
    expect(store.toMarkdown()).toContain('empty or unreadable');

    // The store stays usable afterwards.
    store.addItem('after recovery');
    expect(store.listItems().map((item) => item.title)).toEqual(['after recovery']);
  });

  test('a truncated plan file is rejected, preserved aside, and disclosed', () => {
    const store = makeStore();
    writeRawPlanFile(store, '{"id":"wp-x","title":"Work Plan","items":[{"title":"half writ');

    expect(() => store.listItems()).not.toThrow();
    expect(store.listItems()).toHaveLength(0);

    const quarantined = quarantineFiles(store);
    expect(quarantined).toHaveLength(1);
    // The user's bytes are preserved, not overwritten in place.
    const preserved = readFileSync(join(dirname(store.filePath), quarantined[0]!), 'utf8');
    expect(preserved).toContain('half writ');

    const housekeeping = store.getActivePlan().housekeeping;
    expect(housekeeping?.resetFromUnreadableFile).toBe(true);
    expect(housekeeping?.quarantinePath).toContain('.corrupt-');
    expect(store.toMarkdown()).toContain('preserved at');
  });

  test('a JSON scalar where a plan object belongs is rejected too', () => {
    const store = makeStore();
    writeRawPlanFile(store, '"not a plan"');
    expect(store.listItems()).toHaveLength(0);
    expect(store.getActivePlan().housekeeping?.resetFromUnreadableFile).toBe(true);
  });

  test('quarantine copies are themselves bounded by age TTL and count cap', () => {
    const store = makeStore();
    const directory = dirname(store.filePath);
    mkdirSync(directory, { recursive: true });
    const prefix = `${basename(store.filePath)}.corrupt-`;
    const now = Date.now();
    // One well past the 14-day quarantine TTL...
    writeFileSync(join(directory, `${prefix}${now - 15 * DAY_MS}-aaaaaaaa`), 'old', 'utf8');
    // ...plus more recent copies than the cap allows.
    for (let index = 0; index < WORK_PLAN_QUARANTINE_CAP + 2; index += 1) {
      writeFileSync(join(directory, `${prefix}${now - index * 1000}-b${index}`), 'recent', 'utf8');
    }

    store.getActivePlan(); // first read of the instance performs the sweep

    expect(quarantineFiles(store)).toHaveLength(WORK_PLAN_QUARANTINE_CAP);
    expect(store.getActivePlan().housekeeping?.quarantinesRemoved).toBe(3);
  });
});

describe('WorkPlanStore retention bounds', () => {
  const now = Date.now();
  const stale = now - 31 * DAY_MS;

  function agedPlanStore(): WorkPlanStore {
    const store = makeStore();
    writePlanWithItems(store, [
      { id: 'wpi-done', title: 'old done', status: 'done', createdAt: stale, updatedAt: stale, completedAt: stale },
      { id: 'wpi-cancelled', title: 'old cancelled', status: 'cancelled', createdAt: stale, updatedAt: stale },
      { id: 'wpi-pending', title: 'old pending', status: 'pending', createdAt: stale, updatedAt: stale },
      { id: 'wpi-progress', title: 'old in progress', status: 'in_progress', createdAt: stale, updatedAt: stale },
      { id: 'wpi-blocked', title: 'old blocked', status: 'blocked', createdAt: stale, updatedAt: stale },
      { id: 'wpi-failed', title: 'old failed', status: 'failed', createdAt: stale, updatedAt: stale },
      { id: 'wpi-fresh', title: 'fresh done', status: 'done', createdAt: now, updatedAt: now, completedAt: now },
    ], stale);
    return store;
  }

  test('terminal items age out while every open item survives', () => {
    const store = agedPlanStore();

    expect(store.listItems().map((item) => item.id)).toEqual([
      'wpi-pending',
      'wpi-progress',
      'wpi-blocked',
      'wpi-failed',
      'wpi-fresh',
    ]);
    const housekeeping = store.getActivePlan().housekeeping;
    expect(housekeeping?.expiredItems).toBe(2);
    expect(housekeeping?.cappedItems).toBe(0);
    expect(store.toMarkdown()).toContain('2 completed item(s) aged out');
  });

  test('reaping twice is a no-op the second time, in-process and on reopen', () => {
    const store = agedPlanStore();
    const first = store.getActivePlan().housekeeping;
    expect(first?.expiredItems).toBe(2);

    // Same instance: nothing further to reclaim, so the disclosure is unchanged.
    const second = store.getActivePlan().housekeeping;
    expect(second?.at).toBe(first?.at);
    expect(second?.expiredItems).toBe(2);
    expect(store.listItems()).toHaveLength(5);

    // A fresh instance over the same file (the "another process" case).
    const reopened = new WorkPlanStore({
      homeDirectory: store.filePath.split('/.goodvibes/')[0]!,
      projectId: 'project:test-workspace',
      projectRoot: '/tmp/test-workspace',
    });
    expect(reopened.listItems()).toHaveLength(5);
    expect(reopened.getActivePlan().housekeeping?.at).toBe(first?.at);
  });

  test('the terminal count cap drops the oldest completions and spares open work', () => {
    const store = makeStore();
    const items: RawItem[] = [];
    for (let index = 0; index < WORK_PLAN_TERMINAL_ITEM_CAP + 5; index += 1) {
      const stamp = now - index * 1000;
      items.push({
        id: `wpi-done-${index}`,
        title: `done ${index}`,
        status: 'done',
        createdAt: stamp,
        updatedAt: stamp,
        completedAt: stamp,
      });
    }
    // An open item older than every completion must still survive the cap.
    items.push({ id: 'wpi-open', title: 'still open', status: 'pending', createdAt: now - 900_000, updatedAt: now - 900_000 });
    writePlanWithItems(store, items, now);

    const kept = store.listItems();
    expect(kept).toHaveLength(WORK_PLAN_TERMINAL_ITEM_CAP + 1);
    expect(kept.some((item) => item.id === 'wpi-open')).toBe(true);
    expect(kept.some((item) => item.id === `wpi-done-${WORK_PLAN_TERMINAL_ITEM_CAP + 4}`)).toBe(false);
    expect(kept.some((item) => item.id === 'wpi-done-0')).toBe(true);

    const housekeeping = store.getActivePlan().housekeeping;
    expect(housekeeping?.cappedItems).toBe(5);
    expect(housekeeping?.expiredItems).toBe(0);
    expect(store.toMarkdown()).toContain('5 completed item(s) over the retention cap removed');
  });

  test('a plan with nothing to reclaim records no housekeeping at all', () => {
    const store = makeStore();
    store.addItem('live work');
    expect(store.getActivePlan().housekeeping).toBeUndefined();
    expect(store.toMarkdown()).not.toContain('Housekeeping');
  });
});
