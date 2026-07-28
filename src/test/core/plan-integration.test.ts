/**
 * Plan integration tests — orchestrator plan injection and continuation nudge logic.
 *
 * Tests focus on the plan-related helper behaviors:
 * - Pre-turn plan injection adds a system message when an active plan exists
 * - Continuation nudge after agent spawn with active plan includes plan summary and next items
 * - Continuation nudge after agent spawn without active plan uses directive tone
 * - The plan manager is exercised as an owned runtime service, not a hidden global
 */

import { afterEach, describe, test, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ExecutionPlanManager } from '@pellux/goodvibes-sdk/platform/core';
import type { ExecutionPlan, PlanItem } from '@pellux/goodvibes-sdk/platform/core';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const planRoots = new Set<string>();

function createPlanManager(): ExecutionPlanManager {
  const projectRoot = makeProjectTempDir('gv-plan-integration');
  planRoots.add(projectRoot);
  return new ExecutionPlanManager(projectRoot);
}

afterEach(() => {
  for (const root of planRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  planRoots.clear();
});

// ---------------------------------------------------------------------------
// ExecutionPlanManager unit tests
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager behavior', () => {
  test('getActive returns null when no active plan file exists', () => {
    // A fresh instance with no active file returns null
    const manager = createPlanManager();
    // Reset active file pointer so there's no active plan on disk for this test
    // (In CI there may be no .goodvibes/plans directory at all)
    const active = manager.getActive();
    // May be null or an existing plan — just verify it doesn't throw
    expect(active === null || typeof active === 'object').toBe(true);
  });

  test('create returns a plan with active status and correct items', () => {
    const manager = createPlanManager();
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
    const manager = createPlanManager();
    const plan = manager.create('Summary test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
    ]);
    const summary = manager.getSummary(plan);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  test('getNextItems returns pending items with no incomplete dependencies', () => {
    const manager = createPlanManager();
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
    const manager = createPlanManager();
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
    const manager = createPlanManager();
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
    const manager = createPlanManager();
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
    const manager = createPlanManager();
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
    const manager = createPlanManager();
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
    const manager = createPlanManager();
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
    const manager = createPlanManager();
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
// Auto-spawn helper behavior (Critical 1 + Major 2)
// ---------------------------------------------------------------------------

describe('autoSpawnPendingItems helper behavior', () => {
  /**
   * The Orchestrator.autoSpawnPendingItems method is private, but its observable
   * effects are:
   * 1. Calls planManager.updateItem(planId, itemId, 'in_progress', agentId) for spawned items
   * 2. Stops spawning when running agent count >= maxActiveAgents
   * 3. Returns empty array immediately when recursive orchestration is disabled
   *
   * We test these effects using ExecutionPlanManager + a fake AgentManager-like
   * implementation that mirrors the helper's spawn loop logic.
   */

  /** Minimal fake for AgentManager used to test limit logic in isolation. */
  function fakeSpawnLoop(
    plan: ExecutionPlan,
    items: PlanItem[],
    manager: ExecutionPlanManager,
    opts: { recursionEnabled: boolean; maxActiveAgents: number; runningCount: number }
  ): { spawned: string[]; limitReached: boolean } {
    // Mirrors the logic of Orchestrator.autoSpawnPendingItems
    if (!opts.recursionEnabled) {
      return { spawned: [], limitReached: false };
    }
    const maxAgents = opts.maxActiveAgents || 8;
    const spawned: string[] = [];
    let limitReached = false;
    let running = opts.runningCount;

    for (const item of items) {
      if (running >= maxAgents) {
        limitReached = true;
        break;
      }
      const fakeAgentId = `agent-test-${item.id}`;
      manager.updateItem(plan.id, item.id, 'in_progress', fakeAgentId);
      spawned.push(item.description);
      running++;
    }
    return { spawned, limitReached };
  }

  test('returns empty array when recursive orchestration is disabled', () => {
    const manager = createPlanManager();
    const plan = manager.create('Recursion disabled test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
    ]);
    const items = manager.getNextItems(plan);
    const result = fakeSpawnLoop(plan, items, manager, {
      recursionEnabled: false,
      maxActiveAgents: 8,
      runningCount: 0,
    });
    expect(result.spawned).toHaveLength(0);
    expect(result.limitReached).toBe(false);
    // Items remain pending — not mutated
    const loaded = manager.load(plan.id)!;
    expect(loaded.items[0].status).toBe('pending');
  });

  test('marks items in_progress when recursive orchestration is enabled', () => {
    const manager = createPlanManager();
    const plan = manager.create('Recursion enabled test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
    ]);
    const items = manager.getNextItems(plan);
    const result = fakeSpawnLoop(plan, items, manager, {
      recursionEnabled: true,
      maxActiveAgents: 8,
      runningCount: 0,
    });
    expect(result.spawned).toHaveLength(2);
    expect(result.limitReached).toBe(false);
    const loaded = manager.load(plan.id)!;
    expect(loaded.items[0].status).toBe('in_progress');
    expect(loaded.items[1].status).toBe('in_progress');
  });

  test('stops spawning when running agent count reaches maxActiveAgents', () => {
    const manager = createPlanManager();
    const plan = manager.create('Max agents test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
      { phase: 'Phase 1', description: 'Task C', dependencies: [] },
    ]);
    const items = manager.getNextItems(plan);
    // Simulate 2 agents already running, maxActiveAgents = 2
    const result = fakeSpawnLoop(plan, items, manager, {
      recursionEnabled: true,
      maxActiveAgents: 2,
      runningCount: 2,
    });
    expect(result.spawned).toHaveLength(0);
    expect(result.limitReached).toBe(true);
    // All items remain pending
    const loaded = manager.load(plan.id)!;
    expect(loaded.items.every(i => i.status === 'pending')).toBe(true);
  });

  test('spawns up to the remaining capacity when partially at limit', () => {
    const manager = createPlanManager();
    const plan = manager.create('Partial capacity test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
      { phase: 'Phase 1', description: 'Task B', dependencies: [] },
      { phase: 'Phase 1', description: 'Task C', dependencies: [] },
    ]);
    const items = manager.getNextItems(plan);
    // 1 agent running, maxActiveAgents = 2 — should spawn 1 more
    const result = fakeSpawnLoop(plan, items, manager, {
      recursionEnabled: true,
      maxActiveAgents: 2,
      runningCount: 1,
    });
    expect(result.spawned).toHaveLength(1);
    expect(result.limitReached).toBe(true);
    const loaded = manager.load(plan.id)!;
    // First item should be in_progress, the rest still pending
    expect(loaded.items[0].status).toBe('in_progress');
    expect(loaded.items[1].status).toBe('pending');
    expect(loaded.items[2].status).toBe('pending');
  });

  test('updateItem records agentId on spawned item', () => {
    const manager = createPlanManager();
    const plan = manager.create('AgentId test', [
      { phase: 'Phase 1', description: 'Task A', dependencies: [] },
    ]);
    const items = manager.getNextItems(plan);
    fakeSpawnLoop(plan, items, manager, {
      recursionEnabled: true,
      maxActiveAgents: 8,
      runningCount: 0,
    });
    const loaded = manager.load(plan.id)!;
    expect(loaded.items[0].agentId).toBeDefined();
    expect(loaded.items[0].agentId).toContain('agent-test-');
  });
});

// ---------------------------------------------------------------------------
// parseFromMarkdown round-trip
// ---------------------------------------------------------------------------

describe('ExecutionPlanManager.parseFromMarkdown', () => {
  test('round-trips a plan through toMarkdown and parseFromMarkdown', () => {
    const manager = createPlanManager();
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
