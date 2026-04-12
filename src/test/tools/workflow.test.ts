import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createWorkflowServices, createWorkflowTool } from '../../tools/workflow/index.ts';
import {
  WorkflowManager,
  TriggerManager,
  ScheduleManager,
  WORKFLOW_DEFINITIONS,
} from '../../tools/workflow/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(args: Record<string, unknown>) {
  const result = await tool.execute(args);
  if (!result.success) throw new Error(result.error ?? 'workflow tool failed');
  return JSON.parse(result.output!) as Record<string, unknown>;
}

async function runMayFail(args: Record<string, unknown>) {
  return tool.execute(args);
}

let services = createWorkflowServices();
let tool = createWorkflowTool(services);

beforeEach(() => {
  services.scheduleManager.destroy();
  services = createWorkflowServices();
  tool = createWorkflowTool(services);
});

afterEach(() => {
  services.scheduleManager.destroy();
});

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

describe('WRFC definition', () => {
  test('has correct states', () => {
    const def = WORKFLOW_DEFINITIONS.wrfc;
    expect(def.states).toEqual(['gather', 'plan', 'apply', 'review', 'revision', 'complete']);
  });

  test('has correct transitions', () => {
    const def = WORKFLOW_DEFINITIONS.wrfc;
    expect(def.transitions.gather).toEqual(['plan']);
    expect(def.transitions.plan).toEqual(['apply']);
    expect(def.transitions.apply).toEqual(['review']);
    expect(def.transitions.review).toContain('revision');
    expect(def.transitions.review).toContain('complete');
    expect(def.transitions.revision).toEqual(['apply']);
  });

  test('fix_loop has correct states', () => {
    const def = WORKFLOW_DEFINITIONS.fix_loop;
    expect(def.states).toEqual(['apply', 'test', 'verify', 'complete']);
  });

  test('test_then_fix has correct states', () => {
    const def = WORKFLOW_DEFINITIONS.test_then_fix;
    expect(def.states).toEqual(['test', 'fix', 'verify', 'complete']);
  });

  test('review_only has correct states', () => {
    const def = WORKFLOW_DEFINITIONS.review_only;
    expect(def.states).toEqual(['review', 'complete']);
  });
});

// ---------------------------------------------------------------------------
// mode: start
// ---------------------------------------------------------------------------

describe('mode: start', () => {
  test('creates workflow with first state as initial state', async () => {
    const result = await run({ mode: 'start', definition: 'wrfc', task: 'implement feature' });
    expect(result.id).toBeTruthy();
    expect(result.definition).toBe('wrfc');
    expect(result.currentState).toBe('gather');
    expect(result.task).toBe('implement feature');
    expect(typeof result.startedAt).toBe('number');
    expect(result.transitions).toBe(0);
  });

  test('fix_loop starts at apply', async () => {
    const result = await run({ mode: 'start', definition: 'fix_loop', task: 'fix bug' });
    expect(result.currentState).toBe('apply');
  });

  test('review_only starts at review', async () => {
    const result = await run({ mode: 'start', definition: 'review_only', task: 'review code' });
    expect(result.currentState).toBe('review');
  });

  test('returns error for missing definition', async () => {
    const result = await runMayFail({ mode: 'start', task: 'something' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('definition');
  });

  test('returns error for missing task', async () => {
    const result = await runMayFail({ mode: 'start', definition: 'wrfc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('task');
  });

  test('returns error for unknown definition', async () => {
    const result = await runMayFail({ mode: 'start', definition: 'unknown_def', task: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown workflow definition');
  });
});

// ---------------------------------------------------------------------------
// mode: status
// ---------------------------------------------------------------------------

describe('mode: status', () => {
  test('returns workflow info by id', async () => {
    const started = await run({ mode: 'start', definition: 'wrfc', task: 'my task' });
    const status = await run({ mode: 'status', workflowId: started.id });
    expect(status.id).toBe(started.id);
    expect(status.currentState).toBe('gather');
  });

  test('returns error for missing workflowId', async () => {
    const result = await runMayFail({ mode: 'status' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workflowId');
  });

  test('returns error for unknown workflowId', async () => {
    const result = await runMayFail({ mode: 'status', workflowId: 'nonexistent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// mode: transition
// ---------------------------------------------------------------------------

describe('mode: transition', () => {
  test('moves to valid next state', async () => {
    const started = await run({ mode: 'start', definition: 'wrfc', task: 'test task' });
    const transitioned = await run({
      mode: 'transition',
      workflowId: started.id as string,
      targetState: 'plan',
    });
    expect(transitioned.currentState).toBe('plan');
    expect(transitioned.transitions).toBe(1);
  });

  test('rejects invalid state transition', async () => {
    const started = await run({ mode: 'start', definition: 'wrfc', task: 'test task' });
    const result = await runMayFail({
      mode: 'transition',
      workflowId: started.id as string,
      targetState: 'review', // gather can only go to plan
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid transition');
  });

  test('returns error for missing workflowId', async () => {
    const result = await runMayFail({ mode: 'transition', targetState: 'plan' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workflowId');
  });

  test('returns error for missing targetState', async () => {
    const started = await run({ mode: 'start', definition: 'wrfc', task: 'test task' });
    const result = await runMayFail({ mode: 'transition', workflowId: started.id as string });
    expect(result.success).toBe(false);
    expect(result.error).toContain('targetState');
  });

  test('review can transition to both revision and complete', async () => {
    const wm = services.workflowManager;
    const instance = wm.start('wrfc', 'test');
    // Walk to review state
    wm.transition(instance.id, 'plan');
    wm.transition(instance.id, 'apply');
    wm.transition(instance.id, 'review');

    const toRevision = wm.transition(instance.id, 'revision');
    expect(toRevision.success).toBe(true);

    // Walk back to review
    wm.transition(instance.id, 'apply');
    wm.transition(instance.id, 'review');

    const toComplete = wm.transition(instance.id, 'complete');
    expect(toComplete.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mode: cancel
// ---------------------------------------------------------------------------

describe('mode: cancel', () => {
  test('marks workflow as cancelled', async () => {
    const started = await run({ mode: 'start', definition: 'wrfc', task: 'cancel me' });
    const result = await run({ mode: 'cancel', workflowId: started.id as string });
    expect(result.cancelled).toBe(true);
    expect(result.workflowId).toBe(started.id);
  });

  test('transition fails on cancelled workflow', async () => {
    const started = await run({ mode: 'start', definition: 'wrfc', task: 'cancel me' });
    await run({ mode: 'cancel', workflowId: started.id as string });
    const result = await runMayFail({
      mode: 'transition',
      workflowId: started.id as string,
      targetState: 'plan',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('cancelled');
  });

  test('returns error for unknown workflowId', async () => {
    const result = await runMayFail({ mode: 'cancel', workflowId: 'nonexistent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// mode: list
// ---------------------------------------------------------------------------

describe('mode: list', () => {
  test('returns empty list initially', async () => {
    const result = await run({ mode: 'list' });
    expect(result.count).toBe(0);
    expect(result.workflows).toEqual([]);
  });

  test('returns all workflows after starting some', async () => {
    await run({ mode: 'start', definition: 'wrfc', task: 'task 1' });
    await run({ mode: 'start', definition: 'fix_loop', task: 'task 2' });
    const result = await run({ mode: 'list' });
    expect(result.count).toBe(2);
    expect((result.workflows as unknown[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// mode: triggers
// ---------------------------------------------------------------------------

describe('mode: triggers', () => {
  test('list returns empty initially', async () => {
    const result = await run({ mode: 'triggers', triggerAction: 'list' });
    expect(result.count).toBe(0);
    expect(result.triggers).toEqual([]);
  });

  test('add creates a trigger with id and enabled=true', async () => {
    const result = await run({
      mode: 'triggers',
      triggerAction: 'add',
      triggerDefinition: { event: 'Post:tool:*', action: 'notify' },
    });
    expect(result.id).toBeTruthy();
    expect(result.event).toBe('Post:tool:*');
    expect(result.action).toBe('notify');
    expect(result.enabled).toBe(true);
  });

  test('add with condition stores it', async () => {
    const result = await run({
      mode: 'triggers',
      triggerAction: 'add',
      triggerDefinition: { event: 'Pre:tool:write', condition: 'payload.size > 1000', action: 'warn' },
    });
    expect(result.condition).toBe('payload.size > 1000');
  });

  test('list shows added triggers', async () => {
    await run({
      mode: 'triggers',
      triggerAction: 'add',
      triggerDefinition: { event: 'Post:file:*', action: 'log' },
    });
    const list = await run({ mode: 'triggers', triggerAction: 'list' });
    expect(list.count).toBe(1);
  });

  test('remove deletes a trigger', async () => {
    const added = await run({
      mode: 'triggers',
      triggerAction: 'add',
      triggerDefinition: { event: 'Post:tool:*', action: 'log' },
    });
    await run({ mode: 'triggers', triggerAction: 'remove', triggerId: added.id as string });
    const list = await run({ mode: 'triggers', triggerAction: 'list' });
    expect(list.count).toBe(0);
  });

  test('disable sets enabled=false', async () => {
    const added = await run({
      mode: 'triggers',
      triggerAction: 'add',
      triggerDefinition: { event: 'Post:tool:*', action: 'log' },
    });
    await run({ mode: 'triggers', triggerAction: 'disable', triggerId: added.id as string });
    const tm = services.triggerManager;
    const trigger = tm.list()[0];
    expect(trigger.enabled).toBe(false);
  });

  test('enable sets enabled=true after disable', async () => {
    const added = await run({
      mode: 'triggers',
      triggerAction: 'add',
      triggerDefinition: { event: 'Post:tool:*', action: 'log' },
    });
    await run({ mode: 'triggers', triggerAction: 'disable', triggerId: added.id as string });
    await run({ mode: 'triggers', triggerAction: 'enable', triggerId: added.id as string });
    const tm = services.triggerManager;
    const trigger = tm.list()[0];
    expect(trigger.enabled).toBe(true);
  });

  test('enable returns error for unknown trigger', async () => {
    const result = await runMayFail({ mode: 'triggers', triggerAction: 'enable', triggerId: 'nope' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('add returns error when triggerDefinition missing', async () => {
    const result = await runMayFail({ mode: 'triggers', triggerAction: 'add' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('triggerDefinition');
  });
});

// ---------------------------------------------------------------------------
// mode: schedule
// ---------------------------------------------------------------------------

describe('mode: schedule', () => {
  test('list returns empty initially', async () => {
    const result = await run({ mode: 'schedule', scheduleAction: 'list' });
    expect(result.count).toBe(0);
    expect(result.schedules).toEqual([]);
  });

  test('add creates a schedule entry', async () => {
    const result = await run({
      mode: 'schedule',
      scheduleAction: 'add',
      scheduleName: 'health-check',
      scheduleInterval: '5m',
      scheduleCommand: 'bun run health',
    });
    expect(result.name).toBe('health-check');
    expect(result.interval).toBe('5m');
    expect(result.command).toBe('bun run health');
    expect(result.enabled).toBe(true);
  });

  test('list shows added schedules', async () => {
    await run({
      mode: 'schedule',
      scheduleAction: 'add',
      scheduleName: 'sync',
      scheduleInterval: '1h',
      scheduleCommand: 'bun run sync',
    });
    const list = await run({ mode: 'schedule', scheduleAction: 'list' });
    expect(list.count).toBe(1);
  });

  test('remove deletes a schedule', async () => {
    await run({
      mode: 'schedule',
      scheduleAction: 'add',
      scheduleName: 'temp',
      scheduleInterval: '30s',
      scheduleCommand: 'echo ok',
    });
    await run({ mode: 'schedule', scheduleAction: 'remove', scheduleName: 'temp' });
    const list = await run({ mode: 'schedule', scheduleAction: 'list' });
    expect(list.count).toBe(0);
  });

  test('add returns error when scheduleName missing', async () => {
    const result = await runMayFail({
      mode: 'schedule',
      scheduleAction: 'add',
      scheduleInterval: '5m',
      scheduleCommand: 'echo hi',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('scheduleName');
  });
});

// ---------------------------------------------------------------------------
// Invalid mode
// ---------------------------------------------------------------------------

describe('invalid input', () => {
  test('missing mode returns error', async () => {
    const result = await runMayFail({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('mode');
  });

  test('unknown mode returns error', async () => {
    const result = await runMayFail({ mode: 'nonsense' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown mode');
  });
});
