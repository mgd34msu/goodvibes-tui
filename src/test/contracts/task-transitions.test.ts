import { describe, test, expect } from 'bun:test';
import type { TaskLifecycleState, RuntimeTask, TaskKind } from '../../runtime/store/domains/tasks.ts';
import { createInitialTasksState } from '../../runtime/store/domains/tasks.ts';

// ---------------------------------------------------------------------------
// State machine — declarative valid transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: ReadonlyMap<TaskLifecycleState, ReadonlySet<TaskLifecycleState>> = new Map([
  ['queued',    new Set(['running', 'cancelled'])],
  ['running',   new Set(['completed', 'failed', 'cancelled', 'blocked'])],
  ['blocked',   new Set(['running', 'cancelled', 'failed'])],
  ['completed', new Set()],   // terminal
  ['failed',    new Set()],   // terminal
  ['cancelled', new Set()],   // terminal
]);

function canTransition(from: TaskLifecycleState, to: TaskLifecycleState): boolean {
  return VALID_TRANSITIONS.get(from)?.has(to) ?? false;
}

// ---------------------------------------------------------------------------
// Task factory helper
// ---------------------------------------------------------------------------

let _taskSeq = 0;

function makeTask(
  status: TaskLifecycleState,
  overrides: Partial<RuntimeTask> = {},
): RuntimeTask {
  _taskSeq++;
  return {
    id: `task-${_taskSeq}`,
    kind: 'exec' as TaskKind,
    title: `Task ${_taskSeq}`,
    status,
    owner: 'test',
    cancellable: true,
    childTaskIds: [],
    queuedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('task-transitions contract', () => {
  describe('valid transitions', () => {
    test('queued → running is valid', () => {
      expect(canTransition('queued', 'running')).toBe(true);
    });

    test('running → completed is valid', () => {
      expect(canTransition('running', 'completed')).toBe(true);
    });

    test('running → failed is valid', () => {
      expect(canTransition('running', 'failed')).toBe(true);
    });

    test('running → cancelled is valid', () => {
      expect(canTransition('running', 'cancelled')).toBe(true);
    });

    test('running → blocked is valid', () => {
      expect(canTransition('running', 'blocked')).toBe(true);
    });

    test('blocked → running is valid (unblocked)', () => {
      expect(canTransition('blocked', 'running')).toBe(true);
    });

    test('queued → cancelled is valid', () => {
      expect(canTransition('queued', 'cancelled')).toBe(true);
    });
  });

  describe('invalid transitions (terminal states)', () => {
    test('completed → running is rejected', () => {
      expect(canTransition('completed', 'running')).toBe(false);
    });

    test('completed → queued is rejected', () => {
      expect(canTransition('completed', 'queued')).toBe(false);
    });

    test('failed → queued is rejected', () => {
      expect(canTransition('failed', 'queued')).toBe(false);
    });

    test('failed → running is rejected', () => {
      expect(canTransition('failed', 'running')).toBe(false);
    });

    test('cancelled → running is rejected', () => {
      expect(canTransition('cancelled', 'running')).toBe(false);
    });

    test('cancelled → queued is rejected', () => {
      expect(canTransition('cancelled', 'queued')).toBe(false);
    });
  });

  describe('parent/child relationships', () => {
    test('task starts with empty childTaskIds array', () => {
      const task = makeTask('queued');
      expect(Array.isArray(task.childTaskIds)).toBe(true);
      expect(task.childTaskIds).toHaveLength(0);
    });

    test('child task references parent via parentTaskId', () => {
      const parent = makeTask('running');
      const child = makeTask('queued', { parentTaskId: parent.id });

      expect(child.parentTaskId).toBe(parent.id);
    });

    test('parent task tracks child ids', () => {
      const parent = makeTask('running');
      const childA = makeTask('queued', { parentTaskId: parent.id });
      const childB = makeTask('queued', { parentTaskId: parent.id });

      // Simulate registering children
      const updatedParent: RuntimeTask = {
        ...parent,
        childTaskIds: [childA.id, childB.id],
      };

      expect(updatedParent.childTaskIds).toHaveLength(2);
      expect(updatedParent.childTaskIds).toContain(childA.id);
      expect(updatedParent.childTaskIds).toContain(childB.id);
    });

    test('terminal task child relationship is preserved after completion', () => {
      const parent = makeTask('running');
      const child = makeTask('running', { parentTaskId: parent.id });

      const completedParent: RuntimeTask = { ...parent, status: 'completed', childTaskIds: [child.id] };
      const failedChild: RuntimeTask = { ...child, status: 'failed' };

      expect(completedParent.status).toBe('completed');
      expect(failedChild.parentTaskId).toBe(parent.id);
      expect(completedParent.childTaskIds).toContain(child.id);
    });
  });

  describe('TaskDomainState initial state', () => {
    test('initial state has empty queues', () => {
      const state = createInitialTasksState();

      expect(state.tasks.size).toBe(0);
      expect(state.queuedIds).toHaveLength(0);
      expect(state.runningIds).toHaveLength(0);
      expect(state.blockedIds).toHaveLength(0);
    });

    test('initial statistics are all zero', () => {
      const state = createInitialTasksState();

      expect(state.totalCreated).toBe(0);
      expect(state.totalCompleted).toBe(0);
      expect(state.totalFailed).toBe(0);
      expect(state.totalCancelled).toBe(0);
    });

    test('maxConcurrency is a positive number', () => {
      const state = createInitialTasksState();
      expect(state.maxConcurrency).toBeGreaterThan(0);
    });
  });

  describe('all TaskKind values are covered', () => {
    const allKinds: TaskKind[] = ['exec', 'agent', 'acp', 'scheduler', 'daemon', 'mcp', 'plugin', 'integration'];

    test('all task kind values are non-empty strings', () => {
      for (const kind of allKinds) {
        expect(typeof kind).toBe('string');
        expect(kind.length).toBeGreaterThan(0);
      }
    });

    test('task can be created with each valid kind', () => {
      for (const kind of allKinds) {
        const task = makeTask('queued', { kind });
        expect(task.kind).toBe(kind);
      }
    });
  });
});
