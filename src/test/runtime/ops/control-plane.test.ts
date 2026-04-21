/**
 * OpsControlPlane — unit tests.
 *
 * Covers:
 * - cancelTask: success, rejected (non-cancellable, wrong state)
 * - pauseTask: success, rejected (wrong state)
 * - resumeTask: success, rejected (wrong state)
 * - retryTask: success from failed, success from cancelled, rejected (wrong state)
 * - canPerformAction guards: canCancelTask, canPauseTask, canResumeTask, canRetryTask
 * - Audit events emitted for both success and rejected outcomes
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpsControlPlane, OpsIllegalActionError, OpsTargetNotFoundError } from '@pellux/goodvibes-sdk/platform/runtime/ops/control-plane';
import { createRuntimeStore } from '../../../runtime/store/index.ts';
import { createTaskManager } from '@pellux/goodvibes-sdk/platform/runtime/tasks/index';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session';

function makeEnv() {
  const store = createRuntimeStore();
  const bus = new RuntimeEventBus();
  const taskManager = createTaskManager(store, bus, SESSION_ID);
  const plane = new OpsControlPlane(taskManager, bus, store, SESSION_ID);
  return { store, bus, taskManager, plane };
}

function makeTask(env: ReturnType<typeof makeEnv>, opts: { cancellable?: boolean } = {}) {
  const task = env.taskManager.createTask({
    kind: 'exec',
    title: 'test task',
    owner: 'test',
    cancellable: opts.cancellable ?? true,
  });
  return task;
}

// ---------------------------------------------------------------------------
// cancelTask
// ---------------------------------------------------------------------------

describe('cancelTask', () => {
  test('cancels a queued task', () => {
    const env = makeEnv();
    const task = makeTask(env);

    env.plane.cancelTask(task.id, 'test reason');

    const updated = env.taskManager.getTask(task.id);
    expect(updated?.status).toBe('cancelled');
  });

  test('cancels a running task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);

    env.plane.cancelTask(task.id);

    expect(env.taskManager.getTask(task.id)?.status).toBe('cancelled');
  });

  test('throws OpsTargetNotFoundError for unknown task', () => {
    const env = makeEnv();
    expect(() => env.plane.cancelTask('no-such-id')).toThrow(OpsTargetNotFoundError);
  });

  test('throws OpsIllegalActionError for non-cancellable task', () => {
    const env = makeEnv();
    const task = makeTask(env, { cancellable: false });
    expect(() => env.plane.cancelTask(task.id)).toThrow(OpsIllegalActionError);
  });

  test('throws OpsIllegalActionError for completed task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    env.taskManager.completeTask(task.id);
    expect(() => env.plane.cancelTask(task.id)).toThrow(OpsIllegalActionError);
  });

  test('emits ops audit event on success', async () => {
    const env = makeEnv();
    const task = makeTask(env);
    const received: unknown[] = [];
    env.bus.onDomain('ops', (evt) => received.push(evt));

    env.plane.cancelTask(task.id);

    await flushMicrotasks();
    expect(received.length).toBeGreaterThanOrEqual(2); // action + audit
  });

  test('emits rejected audit event on failure', async () => {
    const env = makeEnv();
    const task = makeTask(env, { cancellable: false });
    const received: unknown[] = [];
    env.bus.onDomain('ops', (evt) => received.push(evt));

    expect(() => env.plane.cancelTask(task.id)).toThrow();
    await flushMicrotasks();
    expect(received.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// pauseTask
// ---------------------------------------------------------------------------

describe('pauseTask', () => {
  test('pauses a running task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);

    env.plane.pauseTask(task.id);

    expect(env.taskManager.getTask(task.id)?.status).toBe('blocked');
  });

  test('throws OpsIllegalActionError when task is not running', () => {
    const env = makeEnv();
    const task = makeTask(env); // queued, not running
    expect(() => env.plane.pauseTask(task.id)).toThrow(OpsIllegalActionError);
  });

  test('throws OpsTargetNotFoundError for unknown task', () => {
    const env = makeEnv();
    expect(() => env.plane.pauseTask('no-such-id')).toThrow(OpsTargetNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// resumeTask
// ---------------------------------------------------------------------------

describe('resumeTask', () => {
  test('resumes a blocked task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    env.taskManager.blockTask(task.id, 'waiting');

    env.plane.resumeTask(task.id);

    expect(env.taskManager.getTask(task.id)?.status).toBe('running');
  });

  test('throws OpsIllegalActionError when task is not blocked (completed)', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    env.taskManager.completeTask(task.id); // terminal: cannot resume
    expect(() => env.plane.resumeTask(task.id)).toThrow(OpsIllegalActionError);
  });

  test('throws OpsTargetNotFoundError for unknown task', () => {
    const env = makeEnv();
    expect(() => env.plane.resumeTask('no-such-id')).toThrow(OpsTargetNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// retryTask
// ---------------------------------------------------------------------------

describe('retryTask', () => {
  test('re-queues a failed task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    env.taskManager.failTask(task.id, { error: 'boom' });

    env.plane.retryTask(task.id);

    expect(env.taskManager.getTask(task.id)?.status).toBe('queued');
  });

  test('re-queues a cancelled task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.cancelTask(task.id);

    env.plane.retryTask(task.id);

    expect(env.taskManager.getTask(task.id)?.status).toBe('queued');
  });

  test('throws OpsIllegalActionError for running task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    expect(() => env.plane.retryTask(task.id)).toThrow(OpsIllegalActionError);
  });

  test('throws OpsTargetNotFoundError for unknown task', () => {
    const env = makeEnv();
    expect(() => env.plane.retryTask('no-such-id')).toThrow(OpsTargetNotFoundError);
  });

  test('routes through TaskManager (task visible after retry)', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    env.taskManager.failTask(task.id, { error: 'oops' });

    env.plane.retryTask(task.id);

    const retried = env.taskManager.getTask(task.id);
    expect(retried?.status).toBe('queued');
    expect(retried?.error).toBeUndefined();
    expect(retried?.endedAt).toBeUndefined();
  });

  test('emits audit event on success', async () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    env.taskManager.failTask(task.id, { error: 'err' });
    const received: unknown[] = [];
    env.bus.onDomain('ops', (evt) => received.push(evt));

    env.plane.retryTask(task.id);

    await flushMicrotasks();
    expect(received.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// canPerformAction guards
// ---------------------------------------------------------------------------

describe('canPerformAction guards', () => {
  test('canCancelTask: true for queued cancellable task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    expect(env.plane.canCancelTask(task.id)).toBe(true);
  });

  test('canCancelTask: false for non-cancellable task', () => {
    const env = makeEnv();
    const task = makeTask(env, { cancellable: false });
    expect(env.plane.canCancelTask(task.id)).toBe(false);
  });

  test('canCancelTask: false for completed task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    env.taskManager.completeTask(task.id);
    expect(env.plane.canCancelTask(task.id)).toBe(false);
  });

  test('canPauseTask: true only for running task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    expect(env.plane.canPauseTask(task.id)).toBe(false); // queued
    env.taskManager.startTask(task.id);
    expect(env.plane.canPauseTask(task.id)).toBe(true);  // running
  });

  test('canResumeTask: true only for blocked task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    expect(env.plane.canResumeTask(task.id)).toBe(false); // running
    env.taskManager.blockTask(task.id, 'waiting');
    expect(env.plane.canResumeTask(task.id)).toBe(true);  // blocked
  });

  test('canRetryTask: true for failed and cancelled, false otherwise', () => {
    const env = makeEnv();
    const task = makeTask(env);
    expect(env.plane.canRetryTask(task.id)).toBe(false); // queued
    env.taskManager.startTask(task.id);
    expect(env.plane.canRetryTask(task.id)).toBe(false); // running
    env.taskManager.failTask(task.id, { error: 'err' });
    expect(env.plane.canRetryTask(task.id)).toBe(true);  // failed
  });

  test('canRetryTask: true for cancelled task', () => {
    const env = makeEnv();
    const task = makeTask(env);
    env.taskManager.cancelTask(task.id);
    expect(env.plane.canRetryTask(task.id)).toBe(true);
  });
});
