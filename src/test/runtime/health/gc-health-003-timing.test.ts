/**
 * GC-HEALTH-003: Cascade timing emission tests.
 *
 * Verifies that CascadeTimer:
 * - Attaches latencyMs to every CascadeResult
 * - Attaches severity derived from effect type
 * - Attaches remediationPlaybookIds from the playbook map
 * - Reports totalLatencyMs >= 0
 * - Handles domains with no matching rules (empty results)
 * - Correctly separates cascades from pendingRecovery in timed results
 */

import { describe, test, expect } from 'bun:test';
import { CascadeTimer, deriveCascadeSeverity } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-timing';
import { CascadeEngine } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-engine';
import { RuntimeHealthAggregator } from '@pellux/goodvibes-sdk/platform/runtime/health/aggregator';
import { CASCADE_RULES } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-rules';
import { createCascadeAppliedEvent } from '@pellux/goodvibes-sdk/platform/runtime/health/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSystem(recoveryAttempts = 0, maxRecoveryAttempts = 3) {
  const aggregator = new RuntimeHealthAggregator();
  // Simulate the domain having had some recovery attempts by updating its health
  if (recoveryAttempts > 0) {
    aggregator.updateDomainHealth('toolExecution', 'degraded', {
      recoveryAttempts,
      maxRecoveryAttempts,
    });
    aggregator.updateDomainHealth('mcp', 'degraded', {
      recoveryAttempts,
      maxRecoveryAttempts,
    });
    aggregator.updateDomainHealth('transport', 'degraded', {
      recoveryAttempts,
      maxRecoveryAttempts,
    });
    aggregator.updateDomainHealth('compaction', 'degraded', {
      recoveryAttempts,
      maxRecoveryAttempts,
    });
  }
  const engine = new CascadeEngine(CASCADE_RULES, aggregator);
  const timer = new CascadeTimer(engine);
  return { aggregator, engine, timer };
}

// ---------------------------------------------------------------------------
// 1. Timing emission
// ---------------------------------------------------------------------------

describe('CascadeTimer — timing emission', () => {
  test('totalLatencyMs is a non-negative number', () => {
    const { timer } = makeSystem();
    const result = timer.evaluate('turn', 'failed');
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.totalLatencyMs).toBe('number');
  });

  test('each cascade result carries latencyMs equal to totalLatencyMs', () => {
    const { timer } = makeSystem();
    const result = timer.evaluate('turn', 'failed');
    expect(result.cascades.length).toBeGreaterThan(0);
    for (const cascade of result.cascades) {
      expect(cascade.latencyMs).toBe(result.totalLatencyMs);
      expect(typeof cascade.latencyMs).toBe('number');
    }
  });

  test('each pendingRecovery result carries latencyMs', () => {
    const { timer } = makeSystem(0, 3);
    const result = timer.evaluate('toolExecution', 'failed');
    expect(result.pendingRecovery.length).toBeGreaterThan(0);
    for (const pending of result.pendingRecovery) {
      expect(pending.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('domain with no matching rules returns zero results and totalLatencyMs >= 0', () => {
    const { timer } = makeSystem();
    // 'model' has no cascade rules defined
    const result = timer.evaluate('model', 'failed');
    expect(result.cascades).toHaveLength(0);
    expect(result.pendingRecovery).toHaveLength(0);
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test('monotonic clock: totalLatencyMs is consistent across repeated calls', () => {
    const { timer } = makeSystem();
    const r1 = timer.evaluate('turn', 'failed');
    const r2 = timer.evaluate('agents', 'failed');
    // Both should be non-negative; we cannot guarantee order without mocking
    expect(r1.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(r2.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Severity attachment
// ---------------------------------------------------------------------------

describe('CascadeTimer — severity attachment', () => {
  test('cascade results carry a severity string', () => {
    const { timer } = makeSystem();
    const result = timer.evaluate('turn', 'failed');
    for (const cascade of result.cascades) {
      expect(typeof cascade.severity).toBe('string');
      expect(['critical', 'high', 'medium', 'low']).toContain(cascade.severity);
    }
  });

  test('CANCEL_INFLIGHT effect is severity high', () => {
    // turn-failed-cancels-tools → CANCEL_INFLIGHT
    const { timer } = makeSystem();
    const result = timer.evaluate('turn', 'failed');
    const cascade = result.cascades.find((c) => c.ruleId === 'turn-failed-cancels-tools');
    expect(cascade).toBeDefined();
    expect(cascade!.severity).toBe('high');
  });

  test('EMIT_EVENT SESSION_UNRECOVERABLE is severity critical', () => {
    // session-recovery-failed-unrecoverable → EMIT_EVENT SESSION_UNRECOVERABLE → target ALL
    const { timer } = makeSystem();
    const result = timer.evaluate('session', 'failed');
    const cascade = result.cascades.find((c) => c.ruleId === 'session-recovery-failed-unrecoverable');
    expect(cascade).toBeDefined();
    expect(cascade!.severity).toBe('critical');
  });

  test('DEREGISTER_TOOLS effect is severity medium', () => {
    // plugin-error-deregisters-tools → DEREGISTER_TOOLS (no recoveryFirst)
    const { timer } = makeSystem();
    const result = timer.evaluate('plugins', 'failed');
    const cascade = result.cascades.find((c) => c.ruleId === 'plugin-error-deregisters-tools');
    expect(cascade).toBeDefined();
    expect(cascade!.severity).toBe('medium');
  });

  test('MARK_CHILDREN effect is severity high', () => {
    // agent-failed-marks-child-tasks → MARK_CHILDREN
    const { timer } = makeSystem();
    const result = timer.evaluate('agents', 'failed');
    const cascade = result.cascades.find((c) => c.ruleId === 'agent-failed-marks-child-tasks');
    expect(cascade).toBeDefined();
    expect(cascade!.severity).toBe('high');
  });

  test('BLOCK_NEW effect is severity high', () => {
    // compaction-failed-blocks-new-turns with recovery exhausted → BLOCK_NEW
    const { timer } = makeSystem(3, 3);
    const result = timer.evaluate('compaction', 'failed');
    const cascade = result.cascades.find((c) => c.ruleId === 'compaction-failed-blocks-new-turns');
    expect(cascade).toBeDefined();
    expect(cascade!.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// 3. Remediation playbook ID attachment
// ---------------------------------------------------------------------------

describe('CascadeTimer — remediationPlaybookIds attachment', () => {
  test('cascade results carry remediationPlaybookIds array', () => {
    const { timer } = makeSystem();
    const result = timer.evaluate('turn', 'failed');
    for (const cascade of result.cascades) {
      expect(Array.isArray(cascade.remediationPlaybookIds)).toBe(true);
    }
  });

  test('turn-failed-cancels-tools maps to stuck-turn playbook', () => {
    const { timer } = makeSystem();
    const result = timer.evaluate('turn', 'failed');
    const cascade = result.cascades.find((c) => c.ruleId === 'turn-failed-cancels-tools');
    expect(cascade).toBeDefined();
    expect(cascade!.remediationPlaybookIds).toContain('stuck-turn');
  });

  test('plugin-error-deregisters-tools maps to plugin-degradation playbook', () => {
    const { timer } = makeSystem();
    const result = timer.evaluate('plugins', 'failed');
    const cascade = result.cascades.find((c) => c.ruleId === 'plugin-error-deregisters-tools');
    expect(cascade).toBeDefined();
    expect(cascade!.remediationPlaybookIds).toContain('plugin-degradation');
  });

  test('session-recovery-failed-unrecoverable maps to session-unrecoverable playbook', () => {
    const { timer } = makeSystem();
    const result = timer.evaluate('session', 'failed');
    const cascade = result.cascades.find((c) => c.ruleId === 'session-recovery-failed-unrecoverable');
    expect(cascade).toBeDefined();
    expect(cascade!.remediationPlaybookIds).toContain('session-unrecoverable');
  });

  test('compaction-failed-blocks-new-turns maps to compaction-failure playbook', () => {
    const { timer } = makeSystem(3, 3);
    const result = timer.evaluate('compaction', 'failed');
    const cascade = result.cascades.find((c) => c.ruleId === 'compaction-failed-blocks-new-turns');
    expect(cascade).toBeDefined();
    expect(cascade!.remediationPlaybookIds).toContain('compaction-failure');
  });

  test('pendingRecovery results also carry remediationPlaybookIds', () => {
    const { timer } = makeSystem(0, 3);
    const result = timer.evaluate('mcp', 'failed');
    expect(result.pendingRecovery.length).toBeGreaterThan(0);
    for (const pending of result.pendingRecovery) {
      expect(Array.isArray(pending.remediationPlaybookIds)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. deriveCascadeSeverity — unit tests
// ---------------------------------------------------------------------------

describe('deriveCascadeSeverity', () => {
  function makeResult(overrides: Partial<Parameters<typeof deriveCascadeSeverity>[0]>) {
    return {
      ruleId: 'test',
      source: 'turn' as const,
      target: 'toolExecution' as const,
      effect: { type: 'CANCEL_INFLIGHT' as const, scope: 'all' },
      timestamp: Date.now(),
      recoveryExhausted: false,
      ...overrides,
    };
  }

  test('EMIT_EVENT with SESSION_UNRECOVERABLE → critical', () => {
    const result = makeResult({
      target: 'ALL',
      effect: { type: 'EMIT_EVENT', eventType: 'SESSION_UNRECOVERABLE' },
    });
    expect(deriveCascadeSeverity(result)).toBe('critical');
  });

  test('target ALL → critical', () => {
    const result = makeResult({
      target: 'ALL',
      effect: { type: 'EMIT_EVENT', eventType: 'SOMETHING_ELSE' },
    });
    expect(deriveCascadeSeverity(result)).toBe('critical');
  });

  test('CANCEL_INFLIGHT → high', () => {
    const result = makeResult({ effect: { type: 'CANCEL_INFLIGHT', scope: 'all' } });
    expect(deriveCascadeSeverity(result)).toBe('high');
  });

  test('BLOCK_NEW → high', () => {
    const result = makeResult({ effect: { type: 'BLOCK_NEW', scope: 'new-turns' } });
    expect(deriveCascadeSeverity(result)).toBe('high');
  });

  test('BLOCK_DISPATCH recoveryExhausted=false → high', () => {
    const result = makeResult({
      effect: { type: 'BLOCK_DISPATCH', scope: 'mcp-tools', queueable: true },
      recoveryExhausted: false,
    });
    expect(deriveCascadeSeverity(result)).toBe('high');
  });

  test('BLOCK_DISPATCH recoveryExhausted=true → medium', () => {
    const result = makeResult({
      effect: { type: 'BLOCK_DISPATCH', scope: 'mcp-tools', queueable: true },
      recoveryExhausted: true,
    });
    expect(deriveCascadeSeverity(result)).toBe('medium');
  });

  test('DEREGISTER_TOOLS → medium', () => {
    const result = makeResult({ effect: { type: 'DEREGISTER_TOOLS' } });
    expect(deriveCascadeSeverity(result)).toBe('medium');
  });

  test('EMIT_EVENT (non-unrecoverable) → low', () => {
    const result = makeResult({ effect: { type: 'EMIT_EVENT', eventType: 'TOOL_DISPATCH_ERROR' } });
    expect(deriveCascadeSeverity(result)).toBe('low');
  });

  test('MARK_CHILDREN → high', () => {
    const result = makeResult({
      effect: { type: 'MARK_CHILDREN', status: 'failed', notifyParent: true },
    });
    expect(deriveCascadeSeverity(result)).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// 5. createCascadeAppliedEvent — timing field preservation
// ---------------------------------------------------------------------------

describe('createCascadeAppliedEvent — timing field preservation', () => {
  test('preserves latencyMs, severity, and remediationPlaybookIds from TimedCascadeResult', () => {
    const { timer } = makeSystem();
    // timer.evaluate returns TimedCascadeResult objects with all three fields populated
    const { cascades } = timer.evaluate('turn', 'failed');
    expect(cascades.length).toBeGreaterThan(0);

    for (const timedResult of cascades) {
      const event = createCascadeAppliedEvent(timedResult);

      // Timing fields must be propagated — not dropped
      expect(event.latencyMs).toBe(timedResult.latencyMs);
      expect(event.severity).toBe(timedResult.severity);
      expect(event.remediationPlaybookIds).toEqual(timedResult.remediationPlaybookIds);

      // Core fields must still be present
      expect(event.type).toBe('CASCADE_APPLIED');
      expect(event.ruleId).toBe(timedResult.ruleId);
      expect(event.source).toBe(timedResult.source);
      expect(event.target).toBe(timedResult.target);
    }
  });

  test('latencyMs is a non-negative number on the produced event', () => {
    const { timer } = makeSystem();
    const { cascades } = timer.evaluate('turn', 'failed');
    expect(cascades.length).toBeGreaterThan(0);
    const event = createCascadeAppliedEvent(cascades[0]);
    expect(typeof event.latencyMs).toBe('number');
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('severity is one of the valid CascadeSeverity values on the produced event', () => {
    const { timer } = makeSystem();
    const { cascades } = timer.evaluate('turn', 'failed');
    expect(cascades.length).toBeGreaterThan(0);
    const event = createCascadeAppliedEvent(cascades[0]);
    const severity = event.severity;
    expect(severity).toBeDefined();
    if (severity !== undefined) {
      expect(['critical', 'high', 'medium', 'low']).toContain(severity);
    }
  });

  test('remediationPlaybookIds is an array on the produced event', () => {
    const { timer } = makeSystem();
    const { cascades } = timer.evaluate('turn', 'failed');
    expect(cascades.length).toBeGreaterThan(0);
    const event = createCascadeAppliedEvent(cascades[0]);
    expect(Array.isArray(event.remediationPlaybookIds)).toBe(true);
  });

  test('undefined timing fields on plain CascadeResult produce undefined on event', () => {
    // A plain CascadeResult (not from CascadeTimer) lacks timing fields
    const plainResult = {
      ruleId: 'turn-failed-cancels-tools',
      source: 'turn' as const,
      target: 'toolExecution' as const,
      effect: { type: 'CANCEL_INFLIGHT' as const, scope: 'all' },
      timestamp: Date.now(),
      recoveryExhausted: false,
    };
    const event = createCascadeAppliedEvent(plainResult);
    expect(event.latencyMs).toBeUndefined();
    expect(event.severity).toBeUndefined();
    expect(event.remediationPlaybookIds).toBeUndefined();
  });
});
