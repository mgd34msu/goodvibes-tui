/**
 * Failure Forensics, comprehensive unit tests.
 *
 * Covers:
 * - Classifier: all 9 FailureClass categories + priority ordering
 * - Registry: push/evict/getById/latest/getAll/subscribe
 * - Collector lifecycle: turn terminal states emit reports + bus events
 * - Collector lifecycle: task terminal states emit reports + bus events
 * - Tracker eviction: size cap prevents unbounded Maps
 */

import { describe, test, expect, mock } from 'bun:test';
import { classifyFailure, summariseFailure } from '@/runtime/index.ts';
import { ForensicsRegistry, DEFAULT_REGISTRY_LIMIT } from '@/runtime/index.ts';
import { ForensicsCollector } from '@/runtime/index.ts';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import type { TurnEvent } from '@/runtime/index.ts';
import type { TaskEvent } from '@/runtime/index.ts';
import type { FailureReport } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function makeRegistry(limit?: number) {
  return new ForensicsRegistry(limit);
}

function makeReport(id: string, overrides: Partial<FailureReport> = {}): FailureReport {
  return {
    id,
    traceId: `trace-${id}`,
    sessionId: 'sess-1',
    generatedAt: Date.now(),
    classification: 'unknown',
    summary: 'test',
    phaseTimings: [],
    phaseLedger: [],
    causalChain: [],
    cascadeEvents: [],
    permissionEvidence: [],
    budgetBreaches: [],
    jumpLinks: [],
    ...overrides,
  };
}

/** Emit a turn event envelope onto the bus. */
async function emitTurn(bus: RuntimeEventBus, payload: Record<string, unknown>, sessionId = 'sess-1', traceId = 'trace-1'): Promise<void> {
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

/** Emit a task event envelope onto the bus. */
async function emitTask(bus: RuntimeEventBus, payload: Record<string, unknown>, sessionId = 'sess-1', traceId = 'trace-1'): Promise<void> {
  bus.emit(
    'tasks',
    createEventEnvelope(
      payload['type'] as TaskEvent['type'],
      payload as TaskEvent,
      { sessionId, source: 'test', traceId },
    ),
  );
  await flushMicrotasks();
}

// ---------------------------------------------------------------------------
// 1. Classifier, all 9 categories + priority
// ---------------------------------------------------------------------------

describe('classifyFailure: all 9 categories', () => {
  test('wasCancelled → cancelled (highest priority)', async () => {
    expect(classifyFailure({
      wasCancelled: true,
      hasToolFailure: true,
      hasCompactionError: true,
      stopReason: 'max_tokens',
    })).toBe('cancelled');
  });

  test('stopReason max_tokens → max_tokens', async () => {
    expect(classifyFailure({ stopReason: 'max_tokens' })).toBe('max_tokens');
  });

  test('stopReason context_overflow → max_tokens', async () => {
    expect(classifyFailure({ stopReason: 'context_overflow' })).toBe('max_tokens');
  });

  test('hasCompactionError → compaction_error (outranks permission/tool)', async () => {
    expect(classifyFailure({
      hasCompactionError: true,
      hasPermissionDenial: true,
      hasToolFailure: true,
    })).toBe('compaction_error');
  });

  test('hasPermissionDenial → permission_denied (outranks tool)', async () => {
    expect(classifyFailure({
      hasPermissionDenial: true,
      hasToolFailure: true,
    })).toBe('permission_denied');
  });

  test('stopReason hook_denied → permission_denied', async () => {
    expect(classifyFailure({ stopReason: 'hook_denied' })).toBe('permission_denied');
  });

  test('hasToolFailure → tool_failure', async () => {
    expect(classifyFailure({ hasToolFailure: true })).toBe('tool_failure');
  });

  test('stopReason tool_loop_circuit_breaker → tool_failure', async () => {
    expect(classifyFailure({ stopReason: 'tool_loop_circuit_breaker' })).toBe('tool_failure');
  });

  test('hasCascadeEvents → cascade_failure', async () => {
    expect(classifyFailure({ hasCascadeEvents: true })).toBe('cascade_failure');
  });

  test('error message with "timeout" → turn_timeout', () => {
    expect(classifyFailure({ errorMessage: 'Request timed out after 30s' })).toBe('turn_timeout');
  });

  test('error message with "rate limit" → llm_error', () => {
    expect(classifyFailure({ errorMessage: 'API rate limit exceeded' })).toBe('llm_error');
  });

  test('error message with "overloaded" → llm_error', () => {
    expect(classifyFailure({ errorMessage: 'Model is overloaded' })).toBe('llm_error');
  });

  test('error message with "503" → llm_error', () => {
    expect(classifyFailure({ errorMessage: 'HTTP 503 Service Unavailable' })).toBe('llm_error');
  });

  test('stopReason error → llm_error', async () => {
    expect(classifyFailure({ stopReason: 'error' })).toBe('llm_error');
  });

  test('stopReason provider_exhausted → llm_error', async () => {
    expect(classifyFailure({ stopReason: 'provider_exhausted' })).toBe('llm_error');
  });

  test('stopReason provider_error → llm_error', async () => {
    expect(classifyFailure({ stopReason: 'provider_error' })).toBe('llm_error');
  });

  test('stopReason content_filter → llm_error', async () => {
    expect(classifyFailure({ stopReason: 'content_filter' })).toBe('llm_error');
  });

  test('no signals → unknown', async () => {
    expect(classifyFailure({})).toBe('unknown');
  });
});

describe('classifyFailure: priority ordering', () => {
  test('cancelled beats compaction_error', async () => {
    expect(classifyFailure({ wasCancelled: true, hasCompactionError: true })).toBe('cancelled');
  });

  test('max_tokens beats compaction_error', async () => {
    expect(classifyFailure({ stopReason: 'max_tokens', hasCompactionError: true })).toBe('max_tokens');
  });

  test('compaction_error beats permission_denied', async () => {
    expect(classifyFailure({ hasCompactionError: true, hasPermissionDenial: true })).toBe('compaction_error');
  });

  test('permission_denied beats tool_failure', async () => {
    expect(classifyFailure({ hasPermissionDenial: true, hasToolFailure: true })).toBe('permission_denied');
  });

  test('tool_failure beats cascade_failure', async () => {
    expect(classifyFailure({ hasToolFailure: true, hasCascadeEvents: true })).toBe('tool_failure');
  });
});

describe('summariseFailure', () => {
  test('llm_error with message', async () => {
    expect(summariseFailure('llm_error', 'API rate limit exceeded')).toContain('LLM API error');
  });

  test('llm_error without message', async () => {
    expect(summariseFailure('llm_error')).toBe('LLM API call failed');
  });

  test('max_tokens with length stopReason', async () => {
    expect(summariseFailure('max_tokens', undefined, 'length')).toContain('token limit');
  });

  test('max_tokens with max_tokens stopReason', async () => {
    expect(summariseFailure('max_tokens', undefined, 'max_tokens')).toContain('max_tokens');
  });

  test('cancelled', async () => {
    expect(summariseFailure('cancelled')).toBe('Entity was explicitly cancelled');
  });

  test('permission_denied', async () => {
    expect(summariseFailure('permission_denied')).toBe('Tool call denied by permission policy');
  });

  test('compaction_error', async () => {
    expect(summariseFailure('compaction_error')).toBe('Context compaction failed');
  });

  test('unknown with message', async () => {
    expect(summariseFailure('unknown', 'Some weird error')).toContain('Some weird error');
  });

  test('unknown without message', async () => {
    expect(summariseFailure('unknown')).toContain('inspect causal chain');
  });
});

// ---------------------------------------------------------------------------
// 2. Registry, push/evict/getById/latest
// ---------------------------------------------------------------------------

describe('ForensicsRegistry: push and retrieve', () => {
  test('push adds a report retrievable by getById', async () => {
    const reg = makeRegistry();
    const r = makeReport('abc123');
    reg.push(r);
    expect(reg.getById('abc123')).toBe(r);
  });

  test('latest returns the most recently pushed report', async () => {
    const reg = makeRegistry();
    reg.push(makeReport('r1'));
    reg.push(makeReport('r2'));
    expect(reg.latest()?.id).toBe('r2');
  });

  test('getAll returns reports newest-first', async () => {
    const reg = makeRegistry();
    reg.push(makeReport('r1'));
    reg.push(makeReport('r2'));
    reg.push(makeReport('r3'));
    const all = reg.getAll();
    expect(all.map(r => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  test('count returns number of retained reports', async () => {
    const reg = makeRegistry();
    reg.push(makeReport('r1'));
    reg.push(makeReport('r2'));
    expect(reg.count()).toBe(2);
  });

  test('getById returns undefined for unknown ID', async () => {
    const reg = makeRegistry();
    expect(reg.getById('nope')).toBeUndefined();
  });

  test('latest returns null when empty', async () => {
    expect(makeRegistry().latest()).toBeNull();
  });
});

describe('ForensicsRegistry: eviction', () => {
  test('evicts oldest report when at capacity', async () => {
    const reg = makeRegistry(3);
    reg.push(makeReport('r1'));
    reg.push(makeReport('r2'));
    reg.push(makeReport('r3'));
    reg.push(makeReport('r4')); // evicts r1
    expect(reg.count()).toBe(3);
    expect(reg.getById('r1')).toBeUndefined();
    expect(reg.getById('r4')).toBeDefined();
  });

  test('default limit is DEFAULT_REGISTRY_LIMIT', async () => {
    const reg = makeRegistry();
    for (let i = 0; i < DEFAULT_REGISTRY_LIMIT + 5; i++) {
      reg.push(makeReport(`r${i}`));
    }
    expect(reg.count()).toBe(DEFAULT_REGISTRY_LIMIT);
  });

  test('evicted report is removed from ID index', async () => {
    const reg = makeRegistry(2);
    reg.push(makeReport('old'));
    reg.push(makeReport('mid'));
    reg.push(makeReport('new')); // evicts 'old'
    expect(reg.getById('old')).toBeUndefined();
  });
});

describe('ForensicsRegistry: subscribe', () => {
  test('subscriber is called on push', async () => {
    const reg = makeRegistry();
    let called = 0;
    reg.subscribe(() => { called++; });
    reg.push(makeReport('r1'));
    expect(called).toBe(1);
  });

  test('unsubscribe stops notifications', async () => {
    const reg = makeRegistry();
    let called = 0;
    const unsub = reg.subscribe(() => { called++; });
    unsub();
    reg.push(makeReport('r1'));
    expect(called).toBe(0);
  });

  test('exportAsJson returns JSON for known ID', async () => {
    const reg = makeRegistry();
    const r = makeReport('r1');
    reg.push(r);
    const json = reg.exportAsJson('r1');
    expect(json).toBeDefined();
    const parsed = JSON.parse(json!);
    expect(parsed.id).toBe('r1');
  });

  test('exportAsJson returns undefined for unknown ID', async () => {
    expect(makeRegistry().exportAsJson('nope')).toBeUndefined();
  });

  test('buildBundle derives incident evidence summary from the report', async () => {
    const reg = makeRegistry();
    reg.push(makeReport('r-bundle', {
      turnId: 'turn-123',
      phaseLedger: [
        {
          seq: 1,
          domain: 'turn',
          phase: 'STREAM',
          enterEventType: 'STREAM_START',
          enteredAt: 10,
          exitEventType: 'TURN_ERROR',
          exitedAt: 25,
          durationMs: 15,
          outcome: 'failed',
          error: 'socket reset',
        },
      ],
      causalChain: [
        {
          seq: 1,
          ts: 25,
          description: 'Turn error: socket reset',
          sourceEventType: 'TURN_ERROR',
          isRootCause: true,
        },
      ],
      jumpLinks: [{ label: 'Replay turn', kind: 'command', target: 'replay load', args: 'turn-123' }],
    }));

    const bundle = reg.buildBundle('r-bundle');
    expect(bundle).toBeDefined();
    expect(bundle!.schemaVersion).toBe('v1');
    expect(bundle!.evidence.rootCause).toBe('Turn error: socket reset');
    expect(bundle!.evidence.terminalPhase).toBe('STREAM');
    expect(bundle!.evidence.terminalOutcome).toBe('failed');
    expect(bundle!.evidence.relatedIds.turnId).toBe('turn-123');
    expect(bundle!.replay.status).toBe('unavailable');
    expect(bundle!.replay.relatedMismatches).toEqual([]);
    expect(bundle!.replay.mismatchBreakdown.byKind).toEqual({});
  });

  test('buildBundle attaches replay evidence and matching turn summary when available', async () => {
    const reg = makeRegistry();
    reg.push(makeReport('r-replay', { turnId: 'turn-1' }));

    const bundle = reg.buildBundle('r-replay', {
      replaySnapshot: {
        status: 'exhausted',
        runId: 'run-42',
        currentRev: 4,
        totalRevisions: 4,
        mismatches: [
          {
            rev: 4,
            kind: 'state_divergence',
            description: 'turn stop reason diverged',
            eventName: 'TURN_COMPLETED',
            ownerDomain: 'turn',
            failureMode: 'stop_reason_diverged',
            relatedTurnId: 'turn-1',
          },
        ],
        turnSummaries: [
          {
            turnId: 'turn-1',
            outcome: 'failed',
            terminalEvent: 'TURN_ERROR',
            startedRev: 1,
            terminalRev: 4,
            stopReason: 'provider_error',
            message: 'provider failed',
          },
        ],
      },
    });

    expect(bundle).toBeDefined();
    expect(bundle!.replay.status).toBe('available');
    expect(bundle!.replay.runId).toBe('run-42');
    expect(bundle!.replay.mismatchCount).toBe(1);
    expect(bundle!.replay.matchingTurnSummary?.turnId).toBe('turn-1');
    expect(bundle!.replay.matchingTurnSummary?.terminalEvent).toBe('TURN_ERROR');
    expect(bundle!.replay.relatedMismatches).toHaveLength(1);
    expect(bundle!.replay.relatedMismatches[0]?.failureMode).toBe('stop_reason_diverged');
    expect(bundle!.replay.mismatchBreakdown.byFailureMode.stop_reason_diverged).toBe(1);
    expect(bundle!.replay.mismatchBreakdown.byOwnerDomain.turn).toBe(1);
  });

  test('exportBundleAsJson returns bundle JSON for known ID', async () => {
    const reg = makeRegistry();
    reg.push(makeReport('r-bundle-json', { turnId: 'turn-7' }));
    const json = reg.exportBundleAsJson('r-bundle-json');
    expect(json).toBeDefined();
    const parsed = JSON.parse(json!);
    expect(parsed.schemaVersion).toBe('v1');
    expect(parsed.report.id).toBe('r-bundle-json');
    expect(parsed.replay.status).toBe('unavailable');
    expect(parsed.replay.relatedMismatches).toEqual([]);
  });

  test('exportBundleAsJson returns undefined for unknown ID', async () => {
    expect(makeRegistry().exportBundleAsJson('nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Collector lifecycle, turn terminal states
// ---------------------------------------------------------------------------

describe('ForensicsCollector: turn lifecycle', () => {
  function makeCollector() {
    const bus = new RuntimeEventBus();
    const registry = makeRegistry();
    const collector = new ForensicsCollector(bus, registry);
    return { bus, registry, collector };
  }

  test('TURN_ERROR produces a report in the registry', async () => {
    const { bus, registry } = makeCollector();
    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hello' });
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 't1', error: 'stream failed' });
    expect(registry.count()).toBe(1);
  });

  test('TURN_ERROR report is classified correctly', async () => {
    const { bus, registry } = makeCollector();
    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hello' });
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 't1', error: 'Request timed out' });
    const report = registry.latest()!;
    expect(report.classification).toBe('turn_timeout');
    expect(report.errorMessage).toBe('Request timed out');
    expect(report.turnId).toBe('t1');
  });

  test('TURN_ERROR report includes ordered phase ledger entries', async () => {
    const { bus, registry } = makeCollector();
    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 'ledger-turn', prompt: 'hello' });
    await emitTurn(bus, { type: 'PREFLIGHT_OK', turnId: 'ledger-turn' });
    await emitTurn(bus, { type: 'STREAM_START', turnId: 'ledger-turn' });
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 'ledger-turn', error: 'network reset' });
    const report = registry.latest()!;
    expect(report.phaseLedger.map((entry) => entry.phase)).toEqual(['SUBMITTED', 'PREFLIGHT', 'STREAM']);
    expect(report.phaseLedger.at(-1)?.outcome).toBe('failed');
    expect(report.phaseLedger.at(-1)?.exitEventType).toBe('TURN_ERROR');
  });

  test('TURN_CANCEL produces a report classified as cancelled', async () => {
    const { bus, registry } = makeCollector();
    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't2', prompt: 'hello' });
    await emitTurn(bus, { type: 'TURN_CANCEL', turnId: 't2', reason: 'user abort' });
    const report = registry.latest()!;
    expect(report.classification).toBe('cancelled');
    expect(report.turnId).toBe('t2');
  });

  test('PREFLIGHT_FAIL produces a report', async () => {
    const { bus, registry } = makeCollector();
    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't3', prompt: 'hello' });
    await emitTurn(bus, { type: 'PREFLIGHT_FAIL', turnId: 't3', reason: 'no provider' });
    expect(registry.count()).toBe(1);
    expect(registry.latest()!.turnId).toBe('t3');
  });

  test('TURN_COMPLETED does NOT produce a report', async () => {
    const { bus, registry } = makeCollector();
    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't4', prompt: 'hello' });
    await emitTurn(bus, { type: 'TURN_COMPLETED', turnId: 't4' });
    expect(registry.count()).toBe(0);
  });

  test('TURN_ERROR without prior TURN_SUBMITTED produces no report', async () => {
    const { bus, registry } = makeCollector();
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 'ghost', error: 'late' });
    expect(registry.count()).toBe(0);
  });

  test('TURN_ERROR emits FORENSICS_REPORT_CREATED on the bus', async () => {
    const { bus, registry } = makeCollector();
    const received: unknown[] = [];
    bus.onDomain('forensics', (env) => { received.push(env.payload); });
    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't5', prompt: 'hello' });
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 't5', error: 'oops' });
    expect(received.length).toBe(1);
    const payload = received[0] as { type: string; reportId: string; classification: string; turnId: string };
    expect(payload.type).toBe('FORENSICS_REPORT_CREATED');
    expect(payload.reportId).toBe(registry.latest()!.id);
    expect(payload.classification).toBe('unknown');
    expect(payload.turnId).toBe('t5');
  });

  test('causal chain includes turn error entry', async () => {
    const { bus, registry } = makeCollector();
    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't6', prompt: 'hello' });
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 't6', error: 'network reset' });
    const report = registry.latest()!;
    expect(report.causalChain.length).toBeGreaterThan(0);
    expect(report.causalChain[0].sourceEventType).toBe('TURN_ERROR');
  });

  test('dispose removes all subscriptions (no further reports)', async () => {
    const bus = new RuntimeEventBus();
    const registry = makeRegistry();
    const collector = new ForensicsCollector(bus, registry);
    collector.dispose();
    await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't7', prompt: 'hello' });
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 't7', error: 'after dispose' });
    expect(registry.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Collector lifecycle, task terminal states
// ---------------------------------------------------------------------------

describe('ForensicsCollector: task lifecycle', () => {
  function makeCollector() {
    const bus = new RuntimeEventBus();
    const registry = makeRegistry();
    const collector = new ForensicsCollector(bus, registry);
    return { bus, registry, collector };
  }

  test('TASK_FAILED produces a report in the registry', async () => {
    const { bus, registry } = makeCollector();
    await emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-1' });
    await emitTask(bus, { type: 'TASK_FAILED', taskId: 'task-1', error: 'agent crashed' });
    expect(registry.count()).toBe(1);
  });

  test('TASK_FAILED report has taskId and errorMessage', async () => {
    const { bus, registry } = makeCollector();
    await emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-2' });
    await emitTask(bus, { type: 'TASK_FAILED', taskId: 'task-2', error: 'agent crashed' });
    const report = registry.latest()!;
    expect(report.taskId).toBe('task-2');
    expect(report.errorMessage).toBe('agent crashed');
  });

  test('TASK_FAILED report includes ordered phase ledger entries', async () => {
    const { bus, registry } = makeCollector();
    await emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-ledger' });
    await emitTask(bus, { type: 'TASK_STARTED', taskId: 'task-ledger' });
    await emitTask(bus, { type: 'TASK_FAILED', taskId: 'task-ledger', error: 'agent crashed' });
    const report = registry.latest()!;
    expect(report.phaseLedger.map((entry) => entry.phase)).toEqual(['CREATED', 'RUNNING']);
    expect(report.phaseLedger.at(-1)?.outcome).toBe('failed');
    expect(report.phaseLedger.at(-1)?.domain).toBe('task');
  });

  test('TASK_CANCELLED produces a report classified as cancelled', async () => {
    const { bus, registry } = makeCollector();
    await emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-3' });
    await emitTask(bus, { type: 'TASK_CANCELLED', taskId: 'task-3', reason: 'timeout' });
    const report = registry.latest()!;
    expect(report.classification).toBe('cancelled');
    expect(report.taskId).toBe('task-3');
  });

  test('TASK_COMPLETED does NOT produce a report', async () => {
    const { bus, registry } = makeCollector();
    await emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-4' });
    await emitTask(bus, { type: 'TASK_COMPLETED', taskId: 'task-4' });
    expect(registry.count()).toBe(0);
  });

  test('TASK_FAILED emits FORENSICS_REPORT_CREATED on the bus', async () => {
    const { bus, registry } = makeCollector();
    const received: unknown[] = [];
    bus.onDomain('forensics', (env) => { received.push(env.payload); });
    await emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-5' });
    await emitTask(bus, { type: 'TASK_FAILED', taskId: 'task-5', error: 'crash' });
    expect(received.length).toBe(1);
    const payload = received[0] as { type: string; taskId: string };
    expect(payload.type).toBe('FORENSICS_REPORT_CREATED');
    expect(payload.taskId).toBe('task-5');
  });

  test('TASK_FAILED without prior TASK_CREATED produces no report', async () => {
    const { bus, registry } = makeCollector();
    await emitTask(bus, { type: 'TASK_FAILED', taskId: 'ghost-task', error: 'late' });
    expect(registry.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Tracker size cap, orphan eviction
// ---------------------------------------------------------------------------

describe('ForensicsCollector: tracker size cap', () => {
  test('orphaned turn trackers are capped at 500 (evicts oldest)', async () => {
    const bus = new RuntimeEventBus();
    const registry = makeRegistry();
    new ForensicsCollector(bus, registry);

    // Add 501 turns without ever terminating them
    for (let i = 0; i < 501; i++) {
      await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: `orphan-${i}`, prompt: 'p' });
    }

    // Now terminate the first turn (orphan-0), it should have been evicted
    // so no report is generated
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 'orphan-0', error: 'late error' });
    expect(registry.count()).toBe(0);

    // The most recent turn (orphan-500) should still be tracked
    await emitTurn(bus, { type: 'TURN_ERROR', turnId: 'orphan-500', error: 'error' });
    expect(registry.count()).toBe(1);
  });
});
