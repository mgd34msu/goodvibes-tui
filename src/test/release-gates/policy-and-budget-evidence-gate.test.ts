import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { TurnEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { TaskEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { ForensicsCollector } from '@pellux/goodvibes-sdk/platform/runtime/forensics/collector';
import { ForensicsRegistry } from '@pellux/goodvibes-sdk/platform/runtime/forensics/registry';
import { PhasedToolExecutor } from '@pellux/goodvibes-sdk/platform/runtime/tools/phased-executor';
import type { ToolRuntimeContext } from '@pellux/goodvibes-sdk/platform/runtime/tools/context';
import type { Tool, ToolCall } from '@pellux/goodvibes-sdk/platform/types/tools';

function emitTurn(
  bus: RuntimeEventBus,
  payload: Record<string, unknown>,
  sessionId = 'sess-policy-budget-gate',
  traceId = 'trace-policy-budget-gate',
): void {
  bus.emit(
    'turn',
    createEventEnvelope(
      payload['type'] as TurnEvent['type'],
      payload as TurnEvent,
      { sessionId, source: 'test', traceId },
    ),
  );
}

function makeContext(
  bus: RuntimeEventBus,
  overrides: Partial<ToolRuntimeContext> = {},
): ToolRuntimeContext {
  return {
    runtime: { getState: () => ({}), subscribe: () => () => {} },
    ids: {
      sessionId: 'sess-policy-budget-gate',
      conversationId: 'conv-policy-budget-gate',
      turnId: 'turn-policy-budget-gate',
      toolCallId: 'call-policy-budget-gate',
      traceId: 'trace-policy-budget-gate',
    },
    tasks: {},
    resources: {
      fileCache: {} as never,
      projectIndex: {} as never,
    },
    provider: {
      providerId: 'mock',
      modelId: 'mock-model',
      contextWindow: 8192,
    },
    cancellation: {
      signal: new AbortController().signal,
    },
    executionMode: 'interactive',
    runtimeBus: bus,
    permissionManager: {
      check: async () => true,
      getCategory: () => 'write',
    } as never,
    hookDispatcher: {
      fire: async () => ({ ok: true, decision: 'allow' }),
    } as never,
    ...overrides,
  };
}

describe('policy and budget evidence gate', () => {
  test('permission-denied tool failure carries permission evidence into the forensic bundle', async () => {
    const bus = new RuntimeEventBus();
    const registry = new ForensicsRegistry();
    const collector = new ForensicsCollector(bus, registry);
    const executor = new PhasedToolExecutor({
      enableHooks: false,
      enablePermissions: true,
      enableEvents: true,
    });

    const call: ToolCall = { id: 'call-perm', name: 'write', arguments: { path: '/tmp/out.txt' } };
    const tool: Tool = {
      name: 'write',
      definition: { name: 'write', description: '', parameters: {} },
      execute: async () => ({ callId: 'call-perm', success: true }),
    } as never;

    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 'turn-policy-budget-gate', prompt: 'write a file' });

    const result = await executor.execute(call, tool, makeContext(bus, {
      permissionManager: {
        check: async () => false,
        getCategory: () => 'write',
      } as never,
    }));

    expect(result.success).toBe(false);
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 'turn-policy-budget-gate', error: result.error ?? 'permission denied' });

    const report = registry.latest()!;
    const bundle = registry.buildBundle(report.id)!;

    expect(report.permissionEvidence).toHaveLength(1);
    expect(report.permissionEvidence[0]?.approved).toBe(false);
    expect(report.permissionEvidence[0]?.source).toBe('permission-manager');
    expect(bundle.evidence.permissionDecisionCount).toBe(1);
    expect(bundle.evidence.deniedPermissionCount).toBe(1);
    collector.dispose();
  });

  test('budget-breached tool failure carries budget evidence into the forensic bundle', async () => {
    const bus = new RuntimeEventBus();
    const registry = new ForensicsRegistry();
    const collector = new ForensicsCollector(bus, registry);
    const executor = new PhasedToolExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: true,
      enableBudgetEnforcement: true,
    });

    const call: ToolCall = { id: 'call-budget', name: 'analyze', arguments: {} };
    const tool: Tool = {
      name: 'analyze',
      definition: { name: 'analyze', description: '', parameters: {} },
      execute: async () => ({ callId: 'call-budget', success: true, tokenCount: 5000 }),
    } as never;

    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 'turn-policy-budget-gate', prompt: 'analyze with token budget' });

    const result = await executor.execute(call, tool, makeContext(bus, {
      budget: { maxTokens: 10 },
    }));

    expect(result.success).toBe(false);
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 'turn-policy-budget-gate', error: result.error ?? 'budget exceeded' });

    const report = registry.latest()!;
    const bundle = registry.buildBundle(report.id)!;

    expect(report.budgetBreaches).toHaveLength(1);
    expect(report.budgetBreaches[0]?.eventType).toBe('BUDGET_EXCEEDED_TOKENS');
    expect(report.budgetBreaches[0]?.meta['usedTokens']).toBe(5000);
    expect(bundle.evidence.budgetBreachCount).toBe(1);
    collector.dispose();
  });
});
