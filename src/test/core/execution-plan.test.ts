import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { rm, mkdtemp, mkdir } from 'node:fs/promises';
import { ExecutionPlanManager } from '../../core/execution-plan.ts';
import type { ExecutionPlan, PlanItem } from '../../core/execution-plan.ts';

// ---------------------------------------------------------------------------
// Test isolation: each suite gets its own temp directory
// ---------------------------------------------------------------------------

let tempDir: string;
let manager: ExecutionPlanManager;

beforeEach(async () => {
  const tmpBase = join(process.cwd(), 'tmp');
  await mkdir(tmpBase, { recursive: true });
  tempDir = await mkdtemp(join(tmpBase, 'gv-plan-test-'));
  manager = new ExecutionPlanManager(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.create', () => {
  test('creates a plan with a unique id', () => {
    const plan = manager.create('My Task', []);
    expect(plan.id).toBeTruthy();
    expect(typeof plan.id).toBe('string');
  });

  test('assigns pending status to all items', () => {
    const plan = manager.create('Task', [
      { phase: 'Phase 1', description: 'Do something' },
    ]);
    expect(plan.items[0].status).toBe('pending');
  });

  test('assigns unique ids to each item', () => {
    const plan = manager.create('Task', [
      { phase: 'Phase 1', description: 'Item A' },
      { phase: 'Phase 1', description: 'Item B' },
    ]);
    expect(plan.items[0].id).not.toBe(plan.items[1].id);
    expect(plan.items[0].id).toBeTruthy();
    expect(plan.items[1].id).toBeTruthy();
  });

  test('plan status starts as draft', () => {
    const plan = manager.create('Task', []);
    expect(plan.status).toBe('draft');
  });

  test('plan is persisted to disk immediately', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'First step' },
    ]);
    const loaded = manager.load(plan.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Task');
  });

  test('created plan becomes active', () => {
    const plan = manager.create('Active Task', [], 'session-a');
    const active = manager.getActive('session-a');
    expect(active).not.toBeNull();
    expect(active!.id).toBe(plan.id);
  });

  test('preserves phase and description on items', () => {
    const plan = manager.create('Task', [
      { phase: 'Setup', description: 'Initialize repo' },
      { phase: 'Impl', description: 'Write code' },
    ]);
    expect(plan.items[0].phase).toBe('Setup');
    expect(plan.items[0].description).toBe('Initialize repo');
    expect(plan.items[1].phase).toBe('Impl');
  });

  test('preserves dependencies on items', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Step A' },
      { phase: 'P1', description: 'Step B', dependencies: ['some-dep-id'] },
    ]);
    expect(plan.items[1].dependencies).toEqual(['some-dep-id']);
  });
});

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.load / save', () => {
  test('load returns null for unknown id', () => {
    expect(manager.load('nonexistent-id')).toBeNull();
  });

  test('save and load round-trips data faithfully', () => {
    const plan = manager.create('Round Trip', [
      { phase: 'P1', description: 'Do a thing' },
    ]);
    plan.items[0].status = 'complete';
    manager.save(plan);

    const loaded = manager.load(plan.id);
    expect(loaded!.items[0].status).toBe('complete');
  });

  test('load returns null for corrupt JSON', () => {
    const { writeFileSync } = require('node:fs');
    const { join: pathJoin } = require('node:path');
    writeFileSync(pathJoin(tempDir, 'bad-id.json'), 'not json {{{{', 'utf-8');
    expect(manager.load('bad-id')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getActive
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.getActive', () => {
  test('returns null when no active plan exists', () => {
    expect(manager.getActive()).toBeNull();
  });

  test('returns the most recently created plan', () => {
    manager.create('First', [], 'session-a');
    const second = manager.create('Second', [], 'session-a');
    expect(manager.getActive('session-a')!.id).toBe(second.id);
  });

  test('session-scoped active lookup ignores plans from other sessions', () => {
    manager.create('First', [], 'session-a');
    expect(manager.getActive('session-b')).toBeNull();
  });

  test('setActive(null) causes getActive() to return null', () => {
    // Create a plan (sets it as active), then deactivate via a second create
    // followed by manually triggering the null path via the public API surface.
    // We test the observable behavior: after creating then loading null active state.
    const plan = manager.create('Temporary', []);
    expect(manager.getActive()).not.toBeNull();
    // Directly write a null planId to active.json to simulate setActive(null)
    const { writeFileSync } = require('node:fs');
    const { join: pathJoin } = require('node:path');
    writeFileSync(
      pathJoin(tempDir, 'active.json'),
      JSON.stringify({ planId: null }, null, 2) + '\n',
      'utf-8',
    );
    expect(manager.getActive()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateItem
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.updateItem', () => {
  test('updates item status', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Do it' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'in_progress');
    const updated = manager.load(plan.id)!;
    expect(updated.items[0].status).toBe('in_progress');
  });

  test('assigns agentId when provided', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Do it' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'in_progress', 'agent-xyz');
    const updated = manager.load(plan.id)!;
    expect(updated.items[0].agentId).toBe('agent-xyz');
  });

  test('plan status becomes active when any item is in_progress', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Step 1' },
      { phase: 'P1', description: 'Step 2' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'in_progress');
    expect(manager.load(plan.id)!.status).toBe('active');
  });

  test('plan status becomes complete when all items done', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Step 1' },
      { phase: 'P1', description: 'Step 2' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    manager.updateItem(plan.id, plan.items[1].id, 'complete');
    expect(manager.load(plan.id)!.status).toBe('complete');
  });

  test('plan status becomes failed when any item fails', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Step 1' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'failed');
    expect(manager.load(plan.id)!.status).toBe('failed');
  });

  test('skipped items count as done for plan completion', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Step 1' },
      { phase: 'P1', description: 'Step 2' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    manager.updateItem(plan.id, plan.items[1].id, 'skipped');
    expect(manager.load(plan.id)!.status).toBe('complete');
  });

  test('no-op for unknown planId', () => {
    // Should not throw
    expect(() => manager.updateItem('ghost-id', 'item-id', 'complete')).not.toThrow();
  });

  test('no-op for unknown itemId', () => {
    const plan = manager.create('Task', [{ phase: 'P1', description: 'Step' }]);
    expect(() => manager.updateItem(plan.id, 'ghost-item', 'complete')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.list', () => {
  test('returns empty array when no plans exist', () => {
    expect(manager.list()).toEqual([]);
  });

  test('returns all created plans', () => {
    manager.create('Plan A', []);
    manager.create('Plan B', []);
    const plans = manager.list();
    expect(plans).toHaveLength(2);
    const titles = plans.map((p) => p.title);
    expect(titles).toContain('Plan A');
    expect(titles).toContain('Plan B');
  });

  test('sorted by createdAt ascending', () => {
    const a = manager.create('Alpha', []);
    const b = manager.create('Beta', []);
    const plans = manager.list();
    // Alpha was created first
    expect(plans[0].id).toBe(a.id);
    expect(plans[1].id).toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// toMarkdown
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.toMarkdown', () => {
  test('renders plan title as H1', () => {
    const plan = manager.create('My Feature', []);
    const md = manager.toMarkdown(plan);
    expect(md).toContain('# My Feature');
  });

  test('renders phase as H2 with status', () => {
    const plan = manager.create('Task', [
      { phase: 'Phase 1: Setup', description: 'Do setup' },
    ]);
    const md = manager.toMarkdown(plan);
    expect(md).toContain('## Phase 1: Setup [PENDING]');
  });

  test('renders pending item with [ ] checkbox', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Do it' },
    ]);
    const md = manager.toMarkdown(plan);
    expect(md).toContain('- [ ] Do it — PENDING');
  });

  test('renders complete item with [x] checkbox and COMPLETE label', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Done step' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'complete', 'agent-abc');
    const updated = manager.load(plan.id)!;
    const md = manager.toMarkdown(updated);
    expect(md).toContain('[x] Done step — COMPLETE (agent-abc)');
  });

  test('renders in_progress item with [~] checkbox', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Active step' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'in_progress');
    const updated = manager.load(plan.id)!;
    const md = manager.toMarkdown(updated);
    expect(md).toContain('[~] Active step — IN_PROGRESS');
  });

  test('renders dependency reference using description', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Step A' },
    ]);
    const stepAId = plan.items[0].id;
    // Manually add a dependent item
    plan.items.push({
      id: 'dep-item-id',
      phase: 'P1',
      description: 'Step B',
      status: 'pending',
      dependencies: [stepAId],
    });
    manager.save(plan);
    const md = manager.toMarkdown(plan);
    expect(md).toContain('depends: Step A');
  });

  test('renders failed item with [!] checkbox', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Bad step' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'failed');
    const updated = manager.load(plan.id)!;
    const md = manager.toMarkdown(updated);
    expect(md).toContain('[!] Bad step — FAILED');
  });

  test('phase shows COMPLETE when all items complete', () => {
    const plan = manager.create('Task', [
      { phase: 'Phase 1', description: 'Step A' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    const updated = manager.load(plan.id)!;
    const md = manager.toMarkdown(updated);
    expect(md).toContain('## Phase 1 [COMPLETE]');
  });

  test('phase shows IN_PROGRESS when any item is in_progress', () => {
    const plan = manager.create('Task', [
      { phase: 'Phase 1', description: 'Step A' },
      { phase: 'Phase 1', description: 'Step B' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'in_progress');
    const updated = manager.load(plan.id)!;
    const md = manager.toMarkdown(updated);
    expect(md).toContain('## Phase 1 [IN_PROGRESS]');
  });
});

// ---------------------------------------------------------------------------
// parseFromMarkdown
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.parseFromMarkdown', () => {
  test('parses title', () => {
    const md = '# My Feature Plan\n\n## Phase 1 [PENDING]\n- [ ] Do something — PENDING\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.title).toBe('My Feature Plan');
  });

  test('parses pending items', () => {
    const md = '# Plan\n\n## Setup [PENDING]\n- [ ] Initialize the repo — PENDING\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items).toHaveLength(1);
    expect(result.items![0].status).toBe('pending');
    expect(result.items![0].description).toBe('Initialize the repo');
    expect(result.items![0].phase).toBe('Setup');
  });

  test('parses complete items with [x]', () => {
    const md = '# Plan\n\n## P1 [COMPLETE]\n- [x] Step done — COMPLETE (agent-abc)\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items![0].status).toBe('complete');
    expect(result.items![0].agentId).toBe('agent-abc');
  });

  test('parses in_progress items with [~]', () => {
    const md = '# Plan\n\n## P1 [IN_PROGRESS]\n- [~] Running step — IN_PROGRESS (agent-xyz)\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items![0].status).toBe('in_progress');
    expect(result.items![0].agentId).toBe('agent-xyz');
  });

  test('parses failed items with [!]', () => {
    const md = '# Plan\n\n## P1 [FAILED]\n- [!] Bad step — FAILED\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items![0].status).toBe('failed');
  });

  test('parses skipped items with [-]', () => {
    const md = '# Plan\n\n## P1 [PENDING]\n- [-] Optional step — SKIPPED\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items![0].status).toBe('skipped');
  });

  test('parses multiple phases', () => {
    const md = [
      '# Plan',
      '',
      '## Phase 1: Setup [COMPLETE]',
      '- [x] Item 1 — COMPLETE (agent-abc)',
      '',
      '## Phase 2: Impl [IN_PROGRESS]',
      '- [~] Item 2 — IN_PROGRESS (agent-def)',
      '- [ ] Item 3 — PENDING',
      '',
    ].join('\n');
    const result = manager.parseFromMarkdown(md);
    expect(result.items).toHaveLength(3);
    expect(result.items![0].phase).toBe('Phase 1: Setup');
    expect(result.items![1].phase).toBe('Phase 2: Impl');
    expect(result.items![2].phase).toBe('Phase 2: Impl');
  });

  test('parses dependency references', () => {
    const md = '# Plan\n\n## P1 [PENDING]\n- [ ] Step A — PENDING\n- [ ] Step B — PENDING (depends: Step A)\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items![1].dependencies).toEqual(['Step A']);
  });

  test('markdown round-trip: toMarkdown then parseFromMarkdown preserves structure', () => {
    const original = manager.create('Round Trip Plan', [
      { phase: 'Phase 1', description: 'First step' },
      { phase: 'Phase 1', description: 'Second step' },
      { phase: 'Phase 2', description: 'Third step' },
    ]);
    manager.updateItem(original.id, original.items[0].id, 'complete', 'agent-1');
    const loaded = manager.load(original.id)!;
    const md = manager.toMarkdown(loaded);
    const parsed = manager.parseFromMarkdown(md);

    expect(parsed.title).toBe('Round Trip Plan');
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items![0].status).toBe('complete');
    expect(parsed.items![0].description).toBe('First step');
    expect(parsed.items![0].phase).toBe('Phase 1');
    expect(parsed.items![0].agentId).toBe('agent-1');
    expect(parsed.items![1].status).toBe('pending');
    expect(parsed.items![2].phase).toBe('Phase 2');
  });

  test('handles slightly different model format (X instead of x)', () => {
    const md = '# Plan\n\n## P1 [COMPLETE]\n- [X] Step done — COMPLETE\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items![0].status).toBe('complete');
  });

  test('returns empty items for empty markdown', () => {
    const result = manager.parseFromMarkdown('');
    expect(result.items).toEqual([]);
  });

  test('parses description containing parentheses', () => {
    const md = '# Plan\n\n## P1 [COMPLETE]\n- [x] Configure OAuth (Google) \u2014 COMPLETE (agent-abc)\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items).toHaveLength(1);
    expect(result.items![0].description).toBe('Configure OAuth (Google)');
    expect(result.items![0].status).toBe('complete');
    expect(result.items![0].agentId).toBe('agent-abc');
  });

  test('parses multi-word status label IN PROGRESS', () => {
    const md = '# Plan\n\n## P1 [IN PROGRESS]\n- [ ] Setup auth \u2014 IN PROGRESS\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items).toHaveLength(1);
    expect(result.items![0].status).toBe('in_progress');
    expect(result.items![0].description).toBe('Setup auth');
  });

  test('parses description containing em-dash (splits on last occurrence)', () => {
    const md = '# Plan\n\n## P1 [COMPLETE]\n- [x] Connect service \u2014 retry logic \u2014 COMPLETE\n';
    const result = manager.parseFromMarkdown(md);
    expect(result.items).toHaveLength(1);
    expect(result.items![0].description).toBe('Connect service \u2014 retry logic');
    expect(result.items![0].status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.getSummary', () => {
  test('returns all-complete message when everything is done', () => {
    const plan = manager.create('Full Task', [
      { phase: 'P1', description: 'Step' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    const updated = manager.load(plan.id)!;
    expect(manager.getSummary(updated)).toBe('Full Task: all complete');
  });

  test('reports in-progress phase count', () => {
    const plan = manager.create('Task', [
      { phase: 'Phase 1: Setup', description: 'A' },
      { phase: 'Phase 1: Setup', description: 'B' },
      { phase: 'Phase 1: Setup', description: 'C' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    const updated = manager.load(plan.id)!;
    const summary = manager.getSummary(updated);
    expect(summary).toBe('Phase 1: Setup: 1/3 complete');
  });

  test('skips completed phases and reports first incomplete phase', () => {
    const plan = manager.create('Task', [
      { phase: 'Phase 1', description: 'Done' },
      { phase: 'Phase 2', description: 'Pending A' },
      { phase: 'Phase 2', description: 'Pending B' },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    const updated = manager.load(plan.id)!;
    const summary = manager.getSummary(updated);
    expect(summary).toBe('Phase 2: 0/2 complete');
  });
});

// ---------------------------------------------------------------------------
// getNextItems
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.getNextItems', () => {
  test('returns all pending items when no dependencies', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'A' },
      { phase: 'P1', description: 'B' },
    ]);
    const next = manager.getNextItems(plan);
    expect(next).toHaveLength(2);
  });

  test('excludes items whose dependencies are not yet complete', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'A' },
    ]);
    const depId = plan.items[0].id;
    plan.items.push({
      id: 'item-b',
      phase: 'P1',
      description: 'B (depends on A)',
      status: 'pending',
      dependencies: [depId],
    });

    const next = manager.getNextItems(plan);
    // Only A is actionable; B depends on A which is still pending
    expect(next.map((i) => i.description)).toEqual(['A']);
  });

  test('includes item once dependency is complete', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'A' },
    ]);
    const depId = plan.items[0].id;
    plan.items.push({
      id: 'item-b',
      phase: 'P1',
      description: 'B (depends on A)',
      status: 'pending',
      dependencies: [depId],
    });
    // Mark A complete
    plan.items[0].status = 'complete';

    const next = manager.getNextItems(plan);
    expect(next.map((i) => i.description)).toContain('B (depends on A)');
  });

  test('excludes in_progress, complete, failed, skipped items', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Pending' },
    ]);
    plan.items.push(
      { id: 'b', phase: 'P1', description: 'Active', status: 'in_progress' },
      { id: 'c', phase: 'P1', description: 'Done', status: 'complete' },
      { id: 'd', phase: 'P1', description: 'Failed', status: 'failed' },
      { id: 'e', phase: 'P1', description: 'Skipped', status: 'skipped' },
    );
    const next = manager.getNextItems(plan);
    expect(next).toHaveLength(1);
    expect(next[0].description).toBe('Pending');
  });

  test('returns empty array when all items are complete', () => {
    const plan = manager.create('Task', [
      { phase: 'P1', description: 'Step' },
    ]);
    plan.items[0].status = 'complete';
    expect(manager.getNextItems(plan)).toHaveLength(0);
  });
});
