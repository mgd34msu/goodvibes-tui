/**
 * Failure Forensics — comprehensive unit tests.
 *
 * Covers:
 * - Classifier: all 9 FailureClass categories + priority ordering
 * - Registry: push/evict/getById/latest/getAll/subscribe
 * - Collector lifecycle: turn terminal states emit reports + bus events
 * - Collector lifecycle: task terminal states emit reports + bus events
 * - Tracker eviction: size cap prevents unbounded Maps
 */

import { describe, test, expect, mock } from 'bun:test';
import { classifyFailure, summariseFailure } from '../../../runtime/forensics/classifier.ts';
import { ForensicsRegistry, DEFAULT_REGISTRY_LIMIT } from '../../../runtime/forensics/registry.ts';
import { ForensicsCollector } from '../../../runtime/forensics/collector.ts';
import { RuntimeEventBus } from '../../../runtime/events/index.ts';
import { createEventEnvelope } from '../../../runtime/events/index.ts';
import type { FailureReport } from '../../../runtime/forensics/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    causalChain: [],
    cascadeEvents: [],
    jumpLinks: [],
    ...overrides,
  };
}

/** Emit a turn event envelope onto the bus. */
function emitTurn(bus: RuntimeEventBus, payload: Record<string, unknown>, sessionId = 'sess-1', traceId = 'trace-1') {
  bus.emit(
    'turn',
    createEventEnvelope(
      payload['type'] as string,
      payload,
      { sessionId, source: 'test', traceId },
    ) as Parameters<RuntimeEventBus['emit']>[1],
  );
}

/** Emit a task event envelope onto the bus. */
function emitTask(bus: RuntimeEventBus, payload: Record<string, unknown>, sessionId = 'sess-1', traceId = 'trace-1') {
  bus.emit(
    'tasks',
    createEventEnvelope(
      payload['type'] as string,
      payload,
      { sessionId, source: 'test', traceId },
    ) as Parameters<RuntimeEventBus['emit']>[1],
  );
}

// ---------------------------------------------------------------------------
// 1. Classifier — all 9 categories + priority
// ---------------------------------------------------------------------------

describe('classifyFailure — all 9 categories', () => {
  test('wasCancelled → cancelled (highest priority)', () => {
    expect(classifyFailure({
      wasCancelled: true,
      hasToolFailure: true,
      hasCompactionError: true,
      stopReason: 'max_tokens',
    })).toBe('cancelled');
  });

  test('stopReason max_tokens → max_tokens', () => {
    expect(classifyFailure({ stopReason: 'max_tokens' })).toBe('max_tokens');
  });

  test('stopReason length → max_tokens', () => {
    expect(classifyFailure({ stopReason: 'length' })).toBe('max_tokens');
  });

  test('hasCompactionError → compaction_error (outranks permission/tool)', () => {
    expect(classifyFailure({
      hasCompactionError: true,
      hasPermissionDenial: true,
      hasToolFailure: true,
    })).toBe('compaction_error');
  });

  test('hasPermissionDenial → permission_denied (outranks tool)', () => {
    expect(classifyFailure({
      hasPermissionDenial: true,
      hasToolFailure: true,
    })).toBe('permission_denied');
  });

  test('hasToolFailure → tool_failure', () => {
    expect(classifyFailure({ hasToolFailure: true })).toBe('tool_failure');
  });

  test('hasCascadeEvents → cascade_failure', () => {
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

  test('stopReason error → llm_error', () => {
    expect(classifyFailure({ stopReason: 'error' })).toBe('llm_error');
  });

  test('stopReason content_filter → llm_error', () => {
    expect(classifyFailure({ stopReason: 'content_filter' })).toBe('llm_error');
  });

  test('no signals → unknown', () => {
    expect(classifyFailure({})).toBe('unknown');
  });
});

describe('classifyFailure — priority ordering', () => {
  test('cancelled beats compaction_error', () => {
    expect(classifyFailure({ wasCancelled: true, hasCompactionError: true })).toBe('cancelled');
  });

  test('max_tokens beats compaction_error', () => {
    expect(classifyFailure({ stopReason: 'max_tokens', hasCompactionError: true })).toBe('max_tokens');
  });

  test('compaction_error beats permission_denied', () => {
    expect(classifyFailure({ hasCompactionError: true, hasPermissionDenial: true })).toBe('compaction_error');
  });

  test('permission_denied beats tool_failure', () => {
    expect(classifyFailure({ hasPermissionDenial: true, hasToolFailure: true })).toBe('permission_denied');
  });

  test('tool_failure beats cascade_failure', () => {
    expect(classifyFailure({ hasToolFailure: true, hasCascadeEvents: true })).toBe('tool_failure');
  });
});

describe('summariseFailure', () => {
  test('llm_error with message', () => {
    expect(summariseFailure('llm_error', 'API rate limit exceeded')).toContain('LLM API error');
  });

  test('llm_error without message', () => {
    expect(summariseFailure('llm_error')).toBe('LLM API call failed');
  });

  test('max_tokens with length stopReason', () => {
    expect(summariseFailure('max_tokens', undefined, 'length')).toContain('length stop');
  });

  test('max_tokens with max_tokens stopReason', () => {
    expect(summariseFailure('max_tokens', undefined, 'max_tokens')).toContain('max_tokens');
  });

  test('cancelled', () => {
    expect(summariseFailure('cancelled')).toBe('Entity was explicitly cancelled');
  });

  test('permission_denied', () => {
    expect(summariseFailure('permission_denied')).toBe('Tool call denied by permission policy');
  });

  test('compaction_error', () => {
    expect(summariseFailure('compaction_error')).toBe('Context compaction failed');
  });

  test('unknown with message', () => {
    expect(summariseFailure('unknown', 'Some weird error')).toContain('Some weird error');
  });

  test('unknown without message', () => {
    expect(summariseFailure('unknown')).toContain('inspect causal chain');
  });
});

// ---------------------------------------------------------------------------
// 2. Registry — push/evict/getById/latest
// ---------------------------------------------------------------------------

describe('ForensicsRegistry — push and retrieve', () => {
  test('push adds a report retrievable by getById', () => {
    const reg = makeRegistry();
    const r = makeReport('abc123');
    reg.push(r);
    expect(reg.getById('abc123')).toBe(r);
  });

  test('latest returns the most recently pushed report', () => {
    const reg = makeRegistry();
    reg.push(makeReport('r1'));
    reg.push(makeReport('r2'));
    expect(reg.latest()?.id).toBe('r2');
  });

  test('getAll returns reports newest-first', () => {
    const reg = makeRegistry();
    reg.push(makeReport('r1'));
    reg.push(makeReport('r2'));
    reg.push(makeReport('r3'));
    const all = reg.getAll();
    expect(all.map(r => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  test('count returns number of retained reports', () => {
    const reg = makeRegistry();
    reg.push(makeReport('r1'));
    reg.push(makeReport('r2'));
    expect(reg.count()).toBe(2);
  });

  test('getById returns undefined for unknown ID', () => {
    const reg = makeRegistry();
    expect(reg.getById('nope')).toBeUndefined();
  });

  test('latest returns undefined when empty', () => {
    expect(makeRegistry().latest()).toBeUndefined();
  });
});

describe('ForensicsRegistry — eviction', () => {
  test('evicts oldest report when at capacity', () => {
    const reg = makeRegistry(3);
    reg.push(makeReport('r1'));
    reg.push(makeReport('r2'));
    reg.push(makeReport('r3'));
    reg.push(makeReport('r4')); // evicts r1
    expect(reg.count()).toBe(3);
    expect(reg.getById('r1')).toBeUndefined();
    expect(reg.getById('r4')).toBeDefined();
  });

  test('default limit is DEFAULT_REGISTRY_LIMIT', () => {
    const reg = makeRegistry();
    for (let i = 0; i < DEFAULT_REGISTRY_LIMIT + 5; i++) {
      reg.push(makeReport(`r${i}`));
    }
    expect(reg.count()).toBe(DEFAULT_REGISTRY_LIMIT);
  });

  test('evicted report is removed from ID index', () => {
    const reg = makeRegistry(2);
    reg.push(makeReport('old'));
    reg.push(makeReport('mid'));
    reg.push(makeReport('new')); // evicts 'old'
    expect(reg.getById('old')).toBeUndefined();
  });
});

describe('ForensicsRegistry — subscribe', () => {
  test('subscriber is called on push', () => {
    const reg = makeRegistry();
    let called = 0;
    reg.subscribe(() => { called++; });
    reg.push(makeReport('r1'));
    expect(called).toBe(1);
  });

  test('unsubscribe stops notifications', () => {
    const reg = makeRegistry();
    let called = 0;
    const unsub = reg.subscribe(() => { called++; });
    unsub();
    reg.push(makeReport('r1'));
    expect(called).toBe(0);
  });

  test('exportAsJson returns JSON for known ID', () => {
    const reg = makeRegistry();
    const r = makeReport('r1');
    reg.push(r);
    const json = reg.exportAsJson('r1');
    expect(json).toBeDefined();
    const parsed = JSON.parse(json!);
    expect(parsed.id).toBe('r1');
  });

  test('exportAsJson returns undefined for unknown ID', () => {
    expect(makeRegistry().exportAsJson('nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Collector lifecycle — turn terminal states
// ---------------------------------------------------------------------------

describe('ForensicsCollector — turn lifecycle', () => {
  function makeCollector() {
    const bus = new RuntimeEventBus();
    const registry = makeRegistry();
    const collector = new ForensicsCollector(bus, registry);
    return { bus, registry, collector };
  }

  test('TURN_ERROR produces a report in the registry', () => {
    const { bus, registry } = makeCollector();
    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hello' });
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 't1', error: 'stream failed' });
    expect(registry.count()).toBe(1);
  });

  test('TURN_ERROR report is classified correctly', () => {
    const { bus, registry } = makeCollector();
    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hello' });
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 't1', error: 'Request timed out' });
    const report = registry.latest()!;
    expect(report.classification).toBe('turn_timeout');
    expect(report.errorMessage).toBe('Request timed out');
    expect(report.turnId).toBe('t1');
  });

  test('TURN_CANCEL produces a report classified as cancelled', () => {
    const { bus, registry } = makeCollector();
    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't2', prompt: 'hello' });
    emitTurn(bus, { type: 'TURN_CANCEL', turnId: 't2', reason: 'user abort' });
    const report = registry.latest()!;
    expect(report.classification).toBe('cancelled');
    expect(report.turnId).toBe('t2');
  });

  test('PREFLIGHT_FAIL produces a report', () => {
    const { bus, registry } = makeCollector();
    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't3', prompt: 'hello' });
    emitTurn(bus, { type: 'PREFLIGHT_FAIL', turnId: 't3', reason: 'no provider' });
    expect(registry.count()).toBe(1);
    expect(registry.latest()!.turnId).toBe('t3');
  });

  test('TURN_COMPLETED does NOT produce a report', () => {
    const { bus, registry } = makeCollector();
    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't4', prompt: 'hello' });
    emitTurn(bus, { type: 'TURN_COMPLETED', turnId: 't4' });
    expect(registry.count()).toBe(0);
  });

  test('TURN_ERROR without prior TURN_SUBMITTED produces no report', () => {
    const { bus, registry } = makeCollector();
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 'ghost', error: 'late' });
    expect(registry.count()).toBe(0);
  });

  test('TURN_ERROR emits FORENSICS_REPORT_CREATED on the bus', () => {
    const { bus, registry } = makeCollector();
    const received: unknown[] = [];
    bus.onDomain('forensics', (env) => { received.push(env.payload); });
    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't5', prompt: 'hello' });
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 't5', error: 'oops' });
    expect(received.length).toBe(1);
    const payload = received[0] as { type: string; reportId: string; classification: string; turnId: string };
    expect(payload.type).toBe('FORENSICS_REPORT_CREATED');
    expect(payload.reportId).toBe(registry.latest()!.id);
    expect(payload.classification).toBe('unknown');
    expect(payload.turnId).toBe('t5');
  });

  test('causal chain includes turn error entry', () => {
    const { bus, registry } = makeCollector();
    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't6', prompt: 'hello' });
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 't6', error: 'network reset' });
    const report = registry.latest()!;
    expect(report.causalChain.length).toBeGreaterThan(0);
    expect(report.causalChain[0].sourceEventType).toBe('TURN_ERROR');
  });

  test('dispose removes all subscriptions (no further reports)', () => {
    const bus = new RuntimeEventBus();
    const registry = makeRegistry();
    const collector = new ForensicsCollector(bus, registry);
    collector.dispose();
    emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't7', prompt: 'hello' });
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 't7', error: 'after dispose' });
    expect(registry.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Collector lifecycle — task terminal states
// ---------------------------------------------------------------------------

describe('ForensicsCollector — task lifecycle', () => {
  function makeCollector() {
    const bus = new RuntimeEventBus();
    const registry = makeRegistry();
    const collector = new ForensicsCollector(bus, registry);
    return { bus, registry, collector };
  }

  test('TASK_FAILED produces a report in the registry', () => {
    const { bus, registry } = makeCollector();
    emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-1' });
    emitTask(bus, { type: 'TASK_FAILED', taskId: 'task-1', error: 'agent crashed' });
    expect(registry.count()).toBe(1);
  });

  test('TASK_FAILED report has taskId and errorMessage', () => {
    const { bus, registry } = makeCollector();
    emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-2' });
    emitTask(bus, { type: 'TASK_FAILED', taskId: 'task-2', error: 'agent crashed' });
    const report = registry.latest()!;
    expect(report.taskId).toBe('task-2');
    expect(report.errorMessage).toBe('agent crashed');
  });

  test('TASK_CANCELLED produces a report classified as cancelled', () => {
    const { bus, registry } = makeCollector();
    emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-3' });
    emitTask(bus, { type: 'TASK_CANCELLED', taskId: 'task-3', reason: 'timeout' });
    const report = registry.latest()!;
    expect(report.classification).toBe('cancelled');
    expect(report.taskId).toBe('task-3');
  });

  test('TASK_COMPLETED does NOT produce a report', () => {
    const { bus, registry } = makeCollector();
    emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-4' });
    emitTask(bus, { type: 'TASK_COMPLETED', taskId: 'task-4' });
    expect(registry.count()).toBe(0);
  });

  test('TASK_FAILED emits FORENSICS_REPORT_CREATED on the bus', () => {
    const { bus, registry } = makeCollector();
    const received: unknown[] = [];
    bus.onDomain('forensics', (env) => { received.push(env.payload); });
    emitTask(bus, { type: 'TASK_CREATED', taskId: 'task-5' });
    emitTask(bus, { type: 'TASK_FAILED', taskId: 'task-5', error: 'crash' });
    expect(received.length).toBe(1);
    const payload = received[0] as { type: string; taskId: string };
    expect(payload.type).toBe('FORENSICS_REPORT_CREATED');
    expect(payload.taskId).toBe('task-5');
  });

  test('TASK_FAILED without prior TASK_CREATED produces no report', () => {
    const { bus, registry } = makeCollector();
    emitTask(bus, { type: 'TASK_FAILED', taskId: 'ghost-task', error: 'late' });
    expect(registry.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Tracker size cap — orphan eviction
// ---------------------------------------------------------------------------

describe('ForensicsCollector — tracker size cap', () => {
  test('orphaned turn trackers are capped at 500 (evicts oldest)', () => {
    const bus = new RuntimeEventBus();
    const registry = makeRegistry();
    new ForensicsCollector(bus, registry);

    // Add 501 turns without ever terminating them
    for (let i = 0; i < 501; i++) {
      emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: `orphan-${i}`, prompt: 'p' });
    }

    // Now terminate the first turn (orphan-0) — it should have been evicted
    // so no report is generated
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 'orphan-0', error: 'late error' });
    expect(registry.count()).toBe(0);

    // The most recent turn (orphan-500) should still be tracked
    emitTurn(bus, { type: 'TURN_ERROR', turnId: 'orphan-500', error: 'error' });
    expect(registry.count()).toBe(1);
  });
});
