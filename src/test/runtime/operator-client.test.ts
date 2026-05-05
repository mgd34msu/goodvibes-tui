import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createOperatorClientServices } from '@/runtime/index.ts';
import { createEventEnvelope, RuntimeEventBus } from '@/runtime/index.ts';
import { createOperatorClient } from '@/runtime/index.ts';
import { createInitialTasksState, type RuntimeTask } from '@/runtime/index.ts';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';


// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 500, intervalMs = 5): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for value');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('operator client', () => {
  let runtimeServices: ReturnType<typeof getTestRuntimeServices>;
  let operatorServices: ReturnType<typeof createOperatorClientServices>;
  let client: ReturnType<typeof createOperatorClient>;

  beforeEach(async () => {
    resetTestRuntimeServices();
    runtimeServices = getTestRuntimeServices();
    operatorServices = createOperatorClientServices(runtimeServices, {
      getControlPlaneRecentEvents: () => [{
        id: 'evt-1',
        event: 'session-created',
        createdAt: 123,
        payload: { sessionId: 'sess-1' },
      }],
    });
    client = createOperatorClient(operatorServices);
  });

  afterEach(async () => {
    resetTestRuntimeServices();
  });

  test('exposes shell paths and current session/control-plane snapshots', async () => {
    const session = await client.sessions.ensureSession({
      sessionId: 'sess-1',
      title: 'Operator Session',
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'local-shell',
        lastSeenAt: 123,
      },
    });

    const approvalRequest = client.approvals.request({
      request: {
        callId: 'call-1',
        tool: 'edit',
        args: { path: 'src/index.ts' },
        category: 'write',
        analysis: {
          classification: 'write',
          riskLevel: 'medium',
          summary: 'Update a file',
          reasons: ['The client should expose approval flows.'],
          target: 'src/index.ts',
          targetKind: 'path',
        },
      },
      sessionId: session.id,
      metadata: { origin: 'operator-client-test' },
    });

    const approval = await waitFor(() => client.approvals.list()[0]);
    await client.approvals.approve(approval.id, 'tester', 'tui', 'approved in test');
    await expect(approvalRequest).resolves.toEqual({ approved: true });

    const controlPlane = client.controlPlane.snapshot();
    expect(controlPlane.sessions).toHaveLength(1);
    expect(controlPlane.approvals).toHaveLength(1);
    expect(client.controlPlane.recentEvents()).toHaveLength(1);
    expect(client.sessions.current()).toEqual(operatorServices.readModels.session.getSnapshot());
    expect(client.sessions.get(session.id)?.title).toBe('Operator Session');
    expect(client.sessions.messages(session.id)).toHaveLength(0);
    expect(client.shellPaths.workingDirectory).toBe(runtimeServices.shellPaths.workingDirectory);
    expect(client.shellPaths.resolveProjectPath('tui', 'sessions')).toBe(join(runtimeServices.shellPaths.resolveProjectPath('tui'), 'sessions'));
  });

  test('tasks are surfaced as a stable read model', async () => {
    const task: RuntimeTask = {
      id: 'task-1',
      kind: 'scheduler',
      title: 'Synchronize schedule',
      status: 'running',
      owner: 'scheduler',
      cancellable: true,
      childTaskIds: [],
      queuedAt: 1,
      startedAt: 2,
    };
    const tasksState = createInitialTasksState();
    tasksState.tasks.set(task.id, task);
    tasksState.runningIds = [task.id];
    tasksState.totalCreated = 1;
    tasksState.source = 'test';
    runtimeServices.runtimeStore.setState((state) => ({
      ...state,
      tasks: tasksState,
    }));

    expect(client.tasks.snapshot().tasks).toHaveLength(1);
    expect(client.tasks.list()).toEqual([task]);
    expect(client.tasks.get(task.id)).toEqual(task);
    expect(client.tasks.running()).toEqual([task]);
  });

  test('providers expose stable runtime, account, and auth snapshots', async () => {
    const providerIds = client.providers.listIds();
    const snapshot = await client.providers.snapshot();

    expect(snapshot.providerIds).toEqual(providerIds);
    expect(Array.isArray(snapshot.runtimeSnapshots)).toBe(true);
    expect(Array.isArray(snapshot.accountSnapshot.providers)).toBe(true);
    expect(Array.isArray(snapshot.authInspection.providers)).toBe(true);
    expect(snapshot.accountSnapshot.configuredCount).toBeGreaterThanOrEqual(0);
    expect(snapshot.authInspection.secretKeyCount).toBeGreaterThanOrEqual(0);
  });

  test('events are direct in-process feeds over the runtime bus', async () => {
    const runtimeBus = new RuntimeEventBus();
    const eventServices = createOperatorClientServices({
      ...runtimeServices,
      runtimeBus,
    });
    const eventClient = createOperatorClient(eventServices);
    const seen: Array<{ type: 'PROVIDERS_CHANGED'; added: string[]; removed: string[]; updated: string[] }> = [];

    const unsubscribe = eventClient.events.providers.on('PROVIDERS_CHANGED', (event) => {
      seen.push(event);
    });

    runtimeBus.emit('providers', createEventEnvelope('PROVIDERS_CHANGED', {
      type: 'PROVIDERS_CHANGED',
      added: ['openai'],
      removed: [],
      updated: ['anthropic'],
    }, {
      sessionId: 'sess-events',
      source: 'operator-client-test',
    }));

    await flushMicrotasks();
    expect(seen).toEqual([{
      type: 'PROVIDERS_CHANGED',
      added: ['openai'],
      removed: [],
      updated: ['anthropic'],
    }]);

    unsubscribe();
  });
});
