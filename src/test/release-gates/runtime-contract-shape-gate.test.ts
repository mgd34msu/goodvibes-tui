import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import type { TurnEvent } from '@/runtime/index.ts';
import { ForensicsCollector } from '@/runtime/index.ts';
import { ForensicsRegistry } from '@/runtime/index.ts';
import { PhasedToolExecutor } from '@/runtime/index.ts';
import type { ToolRuntimeContext } from '@/runtime/index.ts';
import type { Tool, ToolCall } from '@pellux/goodvibes-sdk/platform/types';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

async function emitTurn(
  bus: RuntimeEventBus,
  payload: Record<string, unknown>,
  sessionId = 'sess-runtime-certification',
  traceId = 'trace-runtime-certification',
): Promise<void> {
  bus.emit(
    'turn',
    createEventEnvelope(
      payload['type'] as TurnEvent['type'],
      payload as TurnEvent,
      { sessionId, source: 'test', traceId },
    ),
  );
  await flushMicrotasks();
}

function makeContext(
  bus: RuntimeEventBus,
  overrides: Partial<ToolRuntimeContext> = {},
): ToolRuntimeContext {
  return {
    runtime: { getState: () => ({}), subscribe: () => () => {} },
    ids: {
      sessionId: 'sess-runtime-certification',
      conversationId: 'conv-runtime-certification',
      turnId: 'turn-runtime-certification',
      toolCallId: 'call-runtime-certification',
      traceId: 'trace-runtime-certification',
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

describe('runtime contract shape gate', () => {
  test('critical release gates and chaos packs exist', async () => {
    const root = join(import.meta.dir, '..');
    const required = [
      ['release-gates', 'runtime-substrate-gate.test.ts'],
      ['release-gates', 'operability-gate.test.ts'],
      ['release-gates', 'policy-and-budget-evidence-gate.test.ts'],
      ['chaos', 'provider-failures.test.ts'],
      ['chaos', 'hook-failures.test.ts'],
      ['chaos', 'plugin-crash.test.ts'],
      ['chaos', 'mcp-reconnect.test.ts'],
      ['chaos', 'health-cascades.test.ts'],
    ];
    for (const parts of required) {
      expect(existsSync(join(root, ...parts))).toBe(true);
    }
  });

  test('forensic bundle evidence is export-ready for a denied side-effecting flow', async () => {
    const bus = new RuntimeEventBus();
    const registry = new ForensicsRegistry();
    const collector = new ForensicsCollector(bus, registry);
    const executor = new PhasedToolExecutor({
      enableHooks: false,
      enablePermissions: true,
      enableEvents: true,
      enableBudgetEnforcement: true,
    });

    const call: ToolCall = { id: 'call-runtime-certification', name: 'write', arguments: { path: '/tmp/out.txt' } };
    const tool: Tool = {
      name: 'write',
      definition: { name: 'write', description: '', parameters: {} },
      execute: async () => ({ callId: 'call-runtime-certification', success: true }),
    } as never;

    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 'turn-runtime-certification', prompt: 'write a file' });
    const result = await executor.execute(call, tool, makeContext(bus, {
      permissionManager: {
        check: async () => false,
        getCategory: () => 'write',
      } as never,
    }));
    expect(result.success).toBe(false);
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 'turn-runtime-certification', error: result.error ?? 'permission denied' });

    const report = registry.latest()!;
    const bundle = registry.buildBundle(report.id)!;

    expect(report.phaseLedger.length).toBeGreaterThan(0);
    expect(report.permissionEvidence).toHaveLength(1);
    expect(bundle.report.id).toBe(report.id);
    expect(bundle.evidence.permissionDecisionCount).toBe(1);
    expect(bundle.evidence.deniedPermissionCount).toBe(1);
    expect(bundle.evidence.budgetBreachCount).toBe(0);
    expect(bundle.evidence.slowPhases).toBeArray();

    collector.dispose();
  });
});
