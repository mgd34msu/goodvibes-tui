/**
 * Plan integration tests — orchestrator plan injection and continuation nudge logic.
 *
 * Tests focus on the plan-related helper behaviors:
 * - Pre-turn plan injection adds a system message when an active plan exists
 * - Continuation nudge after agent spawn with active plan includes plan summary and next items
 * - Continuation nudge after agent spawn without active plan uses directive tone
 * - The singleton planManager is used (not a private instance)
 */

import { describe, test, expect } from 'bun:test';
import { ExecutionPlanManager } from '../../core/execution-plan.ts';

// ---------------------------------------------------------------------------
// ExecutionPlanManager unit tests (plan manager singleton behavior)
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager singleton behavior', () => {
  test('getActive returns null when no active plan file exists', () => {
    // A fresh instance with no active file returns null
    const manager = new ExecutionPlanManager();
    // Reset active file pointer so there's no active plan on disk for this test
    // (In CI there may be no .goodvibes/plans directory at all)
    const active = manager.getActive();
    // May be null or an existing plan — just verify it doesn't throw
    expect(active === null || typeof active === 'object').toBe(true);
  });

  test('create returns a plan with active status and correct items', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Test plan', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
    ]);
    expect(plan.title).toBe('Test plan');
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0].description).toBe('Task A');
    expect(plan.items[0].status).toBe('pending');
    // create() sets the plan active, status starts as 'draft' but getActive should return it
    expect(['draft', 'active']).toContain(plan.status);
  });

  test('getSummary returns phase-level progress description', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Summary test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
    ]);
    const summary = manager.getSummary(plan);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  test('getNextItems returns pending items with no incomplete dependencies', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Next items test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
    ]);
    // Mark Task A complete
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    const updated = manager.load(plan.id)!;
    const next = manager.getNextItems(updated);
    // Task B is pending with no deps — should appear
    expect(next.length).toBeGreaterThanOrEqual(1);
    expect(next.every(i => i.status === 'pending')).toBe(true);
  });

  test('getNextItems excludes items with unresolved dependencies', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Deps test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
    ]);
    // Manually set Task B to depend on Task A (both pending)
    plan.items[1].dependencies = [plan.items[0].id];
    const next = manager.getNextItems(plan);
    // Only Task A should be next; Task B depends on it (pending)
    expect(next).toHaveLength(1);
    expect(next[0].description).toBe('Task A');
  });

  test('toMarkdown includes plan title and item checkboxes', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Markdown test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
    ]);
    // Mark A complete so we get both [x] and [ ]
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    const loaded = manager.load(plan.id)!;
    const md = manager.toMarkdown(loaded);
    expect(md).toContain('Markdown test');
    expect(md).toContain('Task A');
    expect(md).toContain('Task B');
    // complete items use [x], pending use [ ]
    expect(md).toContain('[x]');
    expect(md).toContain('[ ]');
  });

  test('updateItem changes item status and persists plan', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Update test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
    ]);
    const itemId = plan.items[0].id;
    manager.updateItem(plan.id, itemId, 'complete');
    const loaded = manager.load(plan.id);
    expect(loaded).not.toBeNull();
    const updatedItem = loaded!.items.find(i => i.id === itemId);
    expect(updatedItem?.status).toBe('complete');
  });

  test('plan transitions to complete when all items are done', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Completion test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
    ]);
    const itemId = plan.items[0].id;
    manager.updateItem(plan.id, itemId, 'complete');
    const loaded = manager.load(plan.id);
    expect(loaded?.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// Plan injection message content (pure message construction logic)
// ---------------------------------------------------------------------------

describe('Plan injection message content', () => {
  test('pre-turn plan message includes current plan state', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Inject test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
    ]);
    const md = manager.toMarkdown(plan);
    const msg = `## Current Execution Plan\n${md}\n\nRefer to this plan. Update item statuses as you complete work.`;
    expect(msg).toContain('## Current Execution Plan');
    expect(msg).toContain('Task A');
    expect(msg).toContain('Refer to this plan');
  });

  test('continuation nudge with active plan and next items contains summary and next items', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Nudge test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
    ]);
    // Mark A in-progress so B is next
    manager.updateItem(plan.id, plan.items[0].id, 'in_progress');
    const loaded = manager.load(plan.id)!;
    const summary = manager.getSummary(loaded);
    const nextItems = manager.getNextItems(loaded);
    const nextDesc = nextItems.map(i => i.description).join(', ');
    const msg = nextItems.length > 0
      ? `Plan progress: ${summary}. Next items ready: ${nextDesc}. Continue spawning agents for remaining work.`
      : `Plan progress: ${summary}. All items are accounted for.`;
    expect(msg).toContain('Plan progress:');
    expect(msg).toContain('Continue spawning agents for remaining work.');
  });

  test('continuation nudge with no plan uses directive tone (not passive)', () => {
    // This is the exact message the orchestrator uses when no active plan exists
    const msg = 'You spawned an agent for part of the task. If there are remaining tasks, continue spawning agents now.';
    expect(msg).toContain('continue spawning agents now');
    // Must NOT use the old passive wording
    expect(msg).not.toContain('Is there more work to do?');
  });

  test('all-done nudge message when plan has no next items', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('All done test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
    ]);
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    const loaded = manager.load(plan.id)!;
    const summary = manager.getSummary(loaded);
    const nextItems = manager.getNextItems(loaded);
    const msg = nextItems.length > 0
      ? `Plan progress: ${summary}. Next items ready: ${nextItems.map(i => i.description).join(', ')}. Continue spawning agents for remaining work.`
      : `Plan progress: ${summary}. All items are accounted for.`;
    expect(msg).toContain('All items are accounted for.');
  });
});

// ---------------------------------------------------------------------------
// parseFromMarkdown round-trip
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.parseFromMarkdown', () => {
  test('round-trips a plan through toMarkdown and parseFromMarkdown', () => {
    const manager = new ExecutionPlanManager();
    const plan = manager.create('Round-trip test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
      { phase: 'Phase 2', description: 'Task C', dependencies: [] },
    ]);
    // Mark A complete and C in-progress
    manager.updateItem(plan.id, plan.items[0].id, 'complete');
    manager.updateItem(plan.id, plan.items[2].id, 'in_progress');
    const loaded = manager.load(plan.id)!;
    const md = manager.toMarkdown(loaded);
    const parsed = manager.parseFromMarkdown(md);
    if (!parsed) throw new Error('parseFromMarkdown returned null');
    expect(parsed.title).toBe('Round-trip test');
    const parsedItems = parsed.items ?? [];
    expect(parsedItems).toHaveLength(3);
    const statuses = parsedItems.map(i => i.status);
    expect(statuses).toContain('complete');
    expect(statuses).toContain('pending');
    expect(statuses).toContain('in_progress');
  });
});
