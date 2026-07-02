import { describe, expect, test } from 'bun:test';
import { OpsControlPanel } from '../../panels/ops-control-panel.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import type { Line } from '../../types/grid.ts';
import type { OpsApi } from '@/runtime/index.ts';
import { RuntimeEventBus, createEventEnvelope, createUiRuntimeEvents } from '@/runtime/index.ts';

function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

const EMPTY_OPS_EVENT_FEED = {
  on: (_event: string, _cb: unknown) => () => {},
  onEnvelope: (_event: string, _cb: unknown) => () => {},
  emit: () => {},
} as unknown as import('../../runtime/ui-events.ts').UiEventFeed<never>;

// ---------------------------------------------------------------------------
// Seam-stubbed OpsApi — records every dispatched call so tests can assert
// the panel drives the real interface without wiring a full OpsControlPlane.
// ---------------------------------------------------------------------------

interface RecordedOpsCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function makeStubOpsApi(): OpsApi & { readonly calls: RecordedOpsCall[] } {
  const calls: RecordedOpsCall[] = [];
  const notImplemented = () => { throw new Error('not implemented in stub'); };
  return {
    calls,
    tasks: {
      snapshot: () => ({ tasks: [] }),
      list: () => [],
      get: () => null,
      running: () => [],
      create: notImplemented,
      update: notImplemented,
      complete: notImplemented,
      fail: notImplemented,
      cancel: (taskId: string, note?: string) => { calls.push({ method: 'tasks.cancel', args: [taskId, note] }); },
      pause: (taskId: string, note?: string) => { calls.push({ method: 'tasks.pause', args: [taskId, note] }); },
      resume: (taskId: string, note?: string) => { calls.push({ method: 'tasks.resume', args: [taskId, note] }); },
      retry: (taskId: string, note?: string) => { calls.push({ method: 'tasks.retry', args: [taskId, note] }); },
    },
    agents: {
      cancel: (agentId: string, note?: string) => { calls.push({ method: 'agents.cancel', args: [agentId, note] }); },
    },
  } as unknown as OpsApi & { readonly calls: RecordedOpsCall[] };
}

// RuntimeEventBus dispatches each subscriber in its own microtask (so a slow
// or throwing subscriber never blocks the emitter) — flush the microtask
// queue after emitting before asserting on subscriber-driven state.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function emitAudit(
  bus: RuntimeEventBus,
  payload: { action: string; targetId: string; targetKind: 'task' | 'agent'; outcome?: 'success' | 'rejected' | 'error' },
): Promise<void> {
  bus.emit('ops', createEventEnvelope('OPS_AUDIT', {
    type: 'OPS_AUDIT',
    action: payload.action,
    targetId: payload.targetId,
    targetKind: payload.targetKind,
    reason: 'user_requested',
    outcome: payload.outcome ?? 'success',
  }, { sessionId: 'test', traceId: 'trace-1', source: 'ops-control-panel.test' }));
  await flushMicrotasks();
}

describe('OpsControlPanel', () => {
  test('empty render surfaces outcome tallies, live posture, and context hints (no signpost)', () => {
    const panel = new OpsControlPanel(EMPTY_OPS_EVENT_FEED);
    const lines = panel.render(100, 24);
    expect(lines).toHaveLength(24);
    expect(lines.every((line) => line.length === 100)).toBe(true);

    const text = linesText(lines);
    expect(text).toContain('Operator Control Plane');
    // Outcome posture counts (most important runtime info first).
    expect(text).toContain('logged');
    expect(text).toContain('rejected');
    // WO-120: live posture (pending intervention counts) replaces the old
    // '/cockpit' signpost in the empty state.
    expect(text).toContain('running');
    expect(text).toContain('blocked');
    expect(text).toContain('retryable');
    expect(text).not.toContain('/cockpit');
    expect(text).toContain('No operator interventions recorded');
    expect(text).toContain('browse log');
  });

  test('registers as \'ops-control\' so /panel open ops-control resolves (not a phantom id)', () => {
    const manager = new PanelManager();
    manager.registerType({
      id: 'ops-control',
      name: 'Ops Control',
      icon: 'Q',
      category: 'runtime-ops',
      description: 'Operator intervention console',
      factory: () => new OpsControlPanel(EMPTY_OPS_EVENT_FEED),
    });

    const opened = manager.open('ops-control');
    expect(opened).toBeInstanceOf(OpsControlPanel);
    expect(manager.getPanel('ops-control')).toBe(opened);
  });

  test('c on a running task dispatches opsApi.tasks.cancel after confirm (target-entry mode)', async () => {
    const bus = new RuntimeEventBus();
    const feed = createUiRuntimeEvents(bus).ops;
    const opsApi = makeStubOpsApi();
    const panel = new OpsControlPanel(feed, opsApi);

    await emitAudit(bus, { action: 'task.create', targetId: 'task-123', targetKind: 'task' });

    // c requests the action against the selected (only, newest) row's target —
    // no id entry required.
    expect(panel.handleInput('c')).toBe(true);
    let text = linesText(panel.render(100, 24));
    expect(text).toContain('Cancel "task task-123"?');
    expect(opsApi.calls).toHaveLength(0);

    expect(panel.handleInput('y')).toBe(true); // confirm
    expect(opsApi.calls).toEqual([{ method: 'tasks.cancel', args: ['task-123', undefined] }]);

    text = linesText(panel.render(100, 24));
    expect(text).not.toContain('Cancel "task task-123"?');
  });

  test('p/u/y (pause/resume/retry) are task-only; pressing them against a selected agent row sets an error, not a confirm', async () => {
    const bus = new RuntimeEventBus();
    const feed = createUiRuntimeEvents(bus).ops;
    const opsApi = makeStubOpsApi();
    const panel = new OpsControlPanel(feed, opsApi);

    await emitAudit(bus, { action: 'agent.spawn', targetId: 'agent-9', targetKind: 'agent' });

    expect(panel.handleInput('p')).toBe(true);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('Only cancel is supported for agent targets');
    expect(text).not.toContain('Pause "agent agent-9"?');
    expect(opsApi.calls).toHaveLength(0);
  });

  test('c on a selected agent row dispatches opsApi.agents.cancel after confirm', async () => {
    const bus = new RuntimeEventBus();
    const feed = createUiRuntimeEvents(bus).ops;
    const opsApi = makeStubOpsApi();
    const panel = new OpsControlPanel(feed, opsApi);

    await emitAudit(bus, { action: 'agent.spawn', targetId: 'agent-9', targetKind: 'agent' });

    expect(panel.handleInput('c')).toBe(true);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('Cancel "agent agent-9"?');

    expect(panel.handleInput('enter')).toBe(true); // Enter also confirms
    expect(opsApi.calls).toEqual([{ method: 'agents.cancel', args: ['agent-9', undefined] }]);
  });

  test('n cancels a pending confirm without dispatching', async () => {
    const bus = new RuntimeEventBus();
    const feed = createUiRuntimeEvents(bus).ops;
    const opsApi = makeStubOpsApi();
    const panel = new OpsControlPanel(feed, opsApi);

    await emitAudit(bus, { action: 'task.create', targetId: 'task-1', targetKind: 'task' });

    expect(panel.handleInput('c')).toBe(true);
    expect(panel.handleInput('n')).toBe(true);
    expect(opsApi.calls).toHaveLength(0);
    const text = linesText(panel.render(100, 24));
    expect(text).not.toContain('Cancel "task task-1"?');
  });

  test('dispatched actions re-appear as OPS_AUDIT rows, closing the loop', async () => {
    const bus = new RuntimeEventBus();
    const feed = createUiRuntimeEvents(bus).ops;
    const opsApi = makeStubOpsApi();
    const panel = new OpsControlPanel(feed, opsApi);

    await emitAudit(bus, { action: 'task.create', targetId: 'task-loop', targetKind: 'task' });
    let text = linesText(panel.render(100, 24));
    expect(text).toContain('logged'); // tallies present, 1 entry

    panel.handleInput('c');
    panel.handleInput('y');

    // The real OpsControlPlane emits a fresh OPS_AUDIT row for the dispatched
    // action; the stub doesn't (it only records the call), so this test
    // simulates the loop-closing row directly to prove the panel re-renders it.
    await emitAudit(bus, { action: 'task.cancel', targetId: 'task-loop', targetKind: 'task', outcome: 'success' });
    text = linesText(panel.render(100, 24));
    const loggedLine = text.split('\n').find((line) => line.includes('logged'));
    expect(loggedLine).toContain('2');
  });
});
