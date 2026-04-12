/**
 * Diagnostics action integration tests.
 *
 * Covers:
 * - Permission checks: read/operator/admin tiers
 * - load-replay: reset engine, absent engine graceful failure
 * - run-policy-simulation: diverged + non-diverged, absent simulator
 * - jump-to-task / jump-to-agent / jump-to-tool-call: callback invoked
 * - retry-task: success, not retriable, absent control plane
 * - cancel-task: success, not cancellable, absent control plane
 * - cancel-agent: success, not cancellable, absent control plane
 * - Factory helpers: all produce HighSeverityDiagnostic with non-empty actions
 */

import { describe, test, expect, mock } from 'bun:test';
import {
  DiagnosticActionDispatcher,
  buildLoadReplayAction,
  buildRunPolicySimulationAction,
  buildJumpToTaskAction,
  buildJumpToAgentAction,
  buildJumpToToolCallAction,
  buildRetryTaskAction,
  buildCancelTaskAction,
  buildCancelAgentAction,
  diagnosticFromTaskFailure,
  diagnosticFromAgentFailure,
  diagnosticFromToolContractViolation,
  diagnosticFromForensicsRun,
} from '../../runtime/diagnostics/actions.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createTaskManager } from '../../runtime/tasks/index.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { OpsControlPlane } from '../../runtime/ops/control-plane.ts';
import { DeterministicReplayEngine } from '../../core/deterministic-replay.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session';
const TRACE_ID = 'trace-001';
const NOW = Date.now();

function makeControlPlaneEnv() {
  const store = createRuntimeStore();
  const bus = new RuntimeEventBus();
  const taskManager = createTaskManager(store, bus, SESSION_ID);
  const controlPlane = new OpsControlPlane(taskManager, bus, store, SESSION_ID);
  return { store, bus, taskManager, controlPlane };
}

function makeTask(
  env: ReturnType<typeof makeControlPlaneEnv>,
  opts: { cancellable?: boolean } = {},
) {
  return env.taskManager.createTask({
    kind: 'exec',
    title: 'test task',
    owner: 'test',
    cancellable: opts.cancellable ?? true,
  });
}

// Minimal PermissionSimulator stub
function makeSimulator(diverged: boolean) {
  return {
    evaluate(_toolName: string, _args: Record<string, unknown>) {
      return {
        diverged,
        actualDecision: { allowed: true },
        simulatedDecision: { allowed: !diverged },
        authoritativeDecision: { allowed: true },
      };
    },
  } as unknown as import('../../runtime/permissions/simulation.ts').PermissionSimulator;
}

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

describe('permission checks', () => {
  test('denies admin-tier actions by default', async () => {
    const dispatcher = new DiagnosticActionDispatcher({});
    const action = {
      ...buildJumpToTaskAction('t1'),
      permission: 'admin' as const,
    };
    const result = await dispatcher.dispatch(action);
    expect(result.success).toBe(false);
    expect(result.permissionDenied).toBe(true);
  });

  test('allows read-tier actions by default', async () => {
    const dispatcher = new DiagnosticActionDispatcher({});
    const action = buildJumpToTaskAction('t1');
    const result = await dispatcher.dispatch(action);
    // No navigateTo registered, but permission passes and we get success=true
    expect(result.success).toBe(true);
    expect(result.permissionDenied).toBeUndefined();
  });

  test('allows operator-tier actions by default', async () => {
    const dispatcher = new DiagnosticActionDispatcher({});
    const action = buildLoadReplayAction('run-001');
    const result = await dispatcher.dispatch(action);
    // No replayEngine registered — fails gracefully, but not due to permission
    expect(result.permissionDenied).toBeUndefined();
  });

  test('custom checkPermission can deny operator tier', async () => {
    const dispatcher = new DiagnosticActionDispatcher({
      checkPermission: (required) => required === 'read',
    });
    const action = buildLoadReplayAction('run-001');
    const result = await dispatcher.dispatch(action);
    expect(result.success).toBe(false);
    expect(result.permissionDenied).toBe(true);
  });

  test('custom checkPermission can allow admin tier', async () => {
    const dispatcher = new DiagnosticActionDispatcher({
      checkPermission: () => true,
    });
    const action = {
      ...buildJumpToTaskAction('t1'),
      permission: 'admin' as const,
    };
    const result = await dispatcher.dispatch(action);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// load-replay
// ---------------------------------------------------------------------------

describe('load-replay', () => {
  test('resets the replay engine and returns success', async () => {
    const engine = new DeterministicReplayEngine();
    const resetMock = mock(() => {});
    (engine as unknown as { reset: () => void }).reset = resetMock;

    const dispatcher = new DiagnosticActionDispatcher({ replayEngine: engine });
    const result = await dispatcher.dispatch(buildLoadReplayAction('run-abc'));

    expect(result.success).toBe(true);
    expect(result.message).toContain('run-abc');
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  test('returns graceful failure when no engine is configured', async () => {
    const dispatcher = new DiagnosticActionDispatcher({});
    const result = await dispatcher.dispatch(buildLoadReplayAction('run-xyz'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('not available');
  });
});

// ---------------------------------------------------------------------------
// run-policy-simulation
// ---------------------------------------------------------------------------

describe('run-policy-simulation', () => {
  test('reports non-diverged result', async () => {
    const simulator = makeSimulator(false);
    const dispatcher = new DiagnosticActionDispatcher({ simulator });
    const result = await dispatcher.dispatch(
      buildRunPolicySimulationAction('write', { path: '/tmp/out.txt' }),
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('allowed');
    expect(result.message).not.toContain('diverged');
  });

  test('reports diverged result', async () => {
    const simulator = makeSimulator(true);
    const dispatcher = new DiagnosticActionDispatcher({ simulator });
    const result = await dispatcher.dispatch(
      buildRunPolicySimulationAction('exec', { cmd: 'rm -rf /' }),
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('diverged');
  });

  test('returns graceful failure when no simulator is configured', async () => {
    const dispatcher = new DiagnosticActionDispatcher({});
    const result = await dispatcher.dispatch(
      buildRunPolicySimulationAction('write', {}),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('not available');
  });
});

// ---------------------------------------------------------------------------
// jump actions
// ---------------------------------------------------------------------------

describe('jump-to-task', () => {
  test('invokes navigateTo callback with correct target and id', async () => {
    const calls: Array<{ target: string; id: string }> = [];
    const dispatcher = new DiagnosticActionDispatcher({
      navigateTo: (target, id) => calls.push({ target, id }),
    });
    const result = await dispatcher.dispatch(buildJumpToTaskAction('task-99'));
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ target: 'task', id: 'task-99' });
  });

  test('succeeds without navigateTo (no-op)', async () => {
    const dispatcher = new DiagnosticActionDispatcher({});
    const result = await dispatcher.dispatch(buildJumpToTaskAction('task-42'));
    expect(result.success).toBe(true);
    expect(result.message).toContain('task-42');
  });
});

describe('jump-to-agent', () => {
  test('invokes navigateTo callback with correct target and id', async () => {
    const calls: Array<{ target: string; id: string }> = [];
    const dispatcher = new DiagnosticActionDispatcher({
      navigateTo: (target, id) => calls.push({ target, id }),
    });
    const result = await dispatcher.dispatch(buildJumpToAgentAction('agent-7'));
    expect(result.success).toBe(true);
    expect(calls[0]).toEqual({ target: 'agent', id: 'agent-7' });
  });
});

describe('jump-to-tool-call', () => {
  test('invokes navigateTo callback with correct target and id', async () => {
    const calls: Array<{ target: string; id: string }> = [];
    const dispatcher = new DiagnosticActionDispatcher({
      navigateTo: (target, id) => calls.push({ target, id }),
    });
    const result = await dispatcher.dispatch(buildJumpToToolCallAction('call-55'));
    expect(result.success).toBe(true);
    expect(calls[0]).toEqual({ target: 'tool-call', id: 'call-55' });
  });
});

// ---------------------------------------------------------------------------
// retry-task
// ---------------------------------------------------------------------------

describe('retry-task', () => {
  test('retries a failed task via control plane', async () => {
    const env = makeControlPlaneEnv();
    const task = makeTask(env);
    env.taskManager.startTask(task.id);
    env.taskManager.failTask(task.id, { error: 'boom' });

    const dispatcher = new DiagnosticActionDispatcher({
      controlPlane: env.controlPlane,
    });
    const result = await dispatcher.dispatch(buildRetryTaskAction(task.id));

    expect(result.success).toBe(true);
    expect(result.message).toContain(task.id);
    expect(env.taskManager.getTask(task.id)?.status).toBe('queued');
  });

  test('returns failure when task cannot be retried', async () => {
    const env = makeControlPlaneEnv();
    const task = makeTask(env);
    // Task is queued (not failed/cancelled) — canRetryTask returns false

    const dispatcher = new DiagnosticActionDispatcher({
      controlPlane: env.controlPlane,
    });
    const result = await dispatcher.dispatch(buildRetryTaskAction(task.id));

    expect(result.success).toBe(false);
    expect(result.message).toContain('cannot be retried');
  });

  test('returns graceful failure when no control plane is configured', async () => {
    const dispatcher = new DiagnosticActionDispatcher({});
    const result = await dispatcher.dispatch(buildRetryTaskAction('task-x'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('not available');
  });
});

// ---------------------------------------------------------------------------
// cancel-task
// ---------------------------------------------------------------------------

describe('cancel-task', () => {
  test('cancels a queued task via control plane', async () => {
    const env = makeControlPlaneEnv();
    const task = makeTask(env);

    const dispatcher = new DiagnosticActionDispatcher({
      controlPlane: env.controlPlane,
    });
    const result = await dispatcher.dispatch(buildCancelTaskAction(task.id));

    expect(result.success).toBe(true);
    expect(env.taskManager.getTask(task.id)?.status).toBe('cancelled');
  });

  test('returns failure when task cannot be cancelled', async () => {
    const env = makeControlPlaneEnv();
    const task = makeTask(env, { cancellable: false });

    const dispatcher = new DiagnosticActionDispatcher({
      controlPlane: env.controlPlane,
    });
    const result = await dispatcher.dispatch(buildCancelTaskAction(task.id));

    expect(result.success).toBe(false);
    expect(result.message).toContain('cannot be cancelled');
  });

  test('returns graceful failure when no control plane is configured', async () => {
    const dispatcher = new DiagnosticActionDispatcher({});
    const result = await dispatcher.dispatch(buildCancelTaskAction('task-y'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('not available');
  });
});

// ---------------------------------------------------------------------------
// cancel-agent
// ---------------------------------------------------------------------------

describe('cancel-agent', () => {
  test('returns graceful failure when no control plane is configured', async () => {
    const dispatcher = new DiagnosticActionDispatcher({});
    const result = await dispatcher.dispatch(buildCancelAgentAction('agent-z'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('not available');
  });

  test('returns failure for non-cancellable agent state', async () => {
    // Create a control plane but no agent is registered — canCancelAgent returns false
    const env = makeControlPlaneEnv();
    const dispatcher = new DiagnosticActionDispatcher({
      controlPlane: env.controlPlane,
    });
    const result = await dispatcher.dispatch(buildCancelAgentAction('ghost-agent'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('cannot be cancelled');
  });
});

// ---------------------------------------------------------------------------
// Factory helpers — acceptance criterion validation
// All high-severity diagnostics must have at least one remediation action.
// ---------------------------------------------------------------------------

describe('HighSeverityDiagnostic factory helpers', () => {
  const COMMON = {
    sessionId: SESSION_ID,
    traceId: TRACE_ID,
    ts: NOW,
  };

  test('diagnosticFromTaskFailure produces non-empty actions', () => {
    const diag = diagnosticFromTaskFailure({
      taskId: 'task-1',
      description: 'build step',
      error: 'exit 1',
      ...COMMON,
    });
    expect(diag.severity).toBe('error');
    expect(diag.actions.length).toBeGreaterThanOrEqual(1);
    // Must include a retry action
    const retryAction = diag.actions.find((a) => a.type === 'retry-task');
    expect(retryAction).toBeDefined();
    // Must include a navigation action
    const jumpAction = diag.actions.find((a) => a.type === 'jump-to-task');
    expect(jumpAction).toBeDefined();
  });

  test('diagnosticFromAgentFailure produces non-empty actions', () => {
    const diag = diagnosticFromAgentFailure({
      agentId: 'agent-1',
      task: 'analyse codebase',
      error: 'context overflow',
      ...COMMON,
    });
    expect(diag.severity).toBe('error');
    expect(diag.actions.length).toBeGreaterThanOrEqual(1);
    const cancelAction = diag.actions.find((a) => a.type === 'cancel-agent');
    expect(cancelAction).toBeDefined();
    const jumpAction = diag.actions.find((a) => a.type === 'jump-to-agent');
    expect(jumpAction).toBeDefined();
  });

  test('diagnosticFromToolContractViolation produces non-empty actions', () => {
    const diag = diagnosticFromToolContractViolation({
      toolName: 'write',
      message: 'missing timeout contract',
      ...COMMON,
    });
    expect(diag.severity).toBe('error');
    expect(diag.actions.length).toBeGreaterThanOrEqual(1);
    const simAction = diag.actions.find((a) => a.type === 'run-policy-simulation');
    expect(simAction).toBeDefined();
  });

  test('diagnosticFromToolContractViolation includes jump-to-tool-call when callId provided', () => {
    const diag = diagnosticFromToolContractViolation({
      toolName: 'exec',
      message: 'idempotency violation',
      callId: 'call-42',
      ...COMMON,
    });
    const jumpAction = diag.actions.find((a) => a.type === 'jump-to-tool-call');
    expect(jumpAction).toBeDefined();
  });

  test('diagnosticFromForensicsRun produces non-empty actions with load-replay', () => {
    const diag = diagnosticFromForensicsRun({
      runId: 'run-007',
      summary: 'State divergence detected in session',
      ...COMMON,
    });
    expect(diag.severity).toBe('error');
    expect(diag.actions.length).toBeGreaterThanOrEqual(1);
    const replayAction = diag.actions.find((a) => a.type === 'load-replay');
    expect(replayAction).toBeDefined();
  });

  test('all factory-produced diagnostics have non-empty actions (acceptance criterion)', () => {
    const diagnostics = [
      diagnosticFromTaskFailure({ taskId: 't1', description: 'desc', error: 'err', ...COMMON }),
      diagnosticFromAgentFailure({ agentId: 'a1', task: 'task', error: 'err', ...COMMON }),
      diagnosticFromToolContractViolation({ toolName: 'write', message: 'msg', ...COMMON }),
      diagnosticFromForensicsRun({ runId: 'r1', summary: 'summary', ...COMMON }),
    ];

    for (const diag of diagnostics) {
      expect(diag.actions.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling — handler throws
// ---------------------------------------------------------------------------

describe('error handling', () => {
  test('catches handler errors and returns failure result', async () => {
    const brokenEngine = {
      reset() { throw new Error('engine exploded'); },
    } as unknown as import('../../core/deterministic-replay.ts').DeterministicReplayEngine;

    const dispatcher = new DiagnosticActionDispatcher({
      replayEngine: brokenEngine,
    });
    const result = await dispatcher.dispatch(buildLoadReplayAction('run-fail'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('engine exploded');
  });
});
