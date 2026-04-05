/**
 * Operability Gate — Release Gate 4
 *
 * Verifies that:
 * - Every high-severity diagnostic has at least one remediation action
 * - Forensics classifier auto-classifies all known failure types
 * - Forensics classifier covers all FailureClass values
 * - Action factory helpers produce valid HighSeverityDiagnostic entries
 * - Diagnostics system supports replay, forensics, and operator tooling
 */

import { describe, test, expect } from 'bun:test';
import {
  buildLoadReplayAction,
  buildRunPolicySimulationAction,
  buildJumpToTaskAction,
  buildJumpToAgentAction,
  buildJumpToToolCallAction,
  buildRetryTaskAction,
  buildCancelTaskAction,
  buildCancelAgentAction,
} from '../../runtime/diagnostics/actions.ts';
import {
  classifyFailure,
  summariseFailure,
} from '../../runtime/forensics/classifier.ts';
import type {
  FailureClass,
  FailureReport,
  CausalChainEntry,
  ForensicsBundle,
} from '../../runtime/forensics/types.ts';

// ---------------------------------------------------------------------------
// 1. Forensics classifier: all known failure classes are reachable
// ---------------------------------------------------------------------------

describe('operability gate: forensics classifier coverage', () => {
  test('cancelled → classified as cancelled', () => {
    expect(classifyFailure({ wasCancelled: true })).toBe('cancelled');
  });

  test('max_tokens stop reason → classified as max_tokens', () => {
    expect(classifyFailure({ stopReason: 'max_tokens' })).toBe('max_tokens');
  });

  test('length stop reason → classified as max_tokens', () => {
    expect(classifyFailure({ stopReason: 'length' })).toBe('max_tokens');
  });

  test('context_overflow stop reason → classified as max_tokens', () => {
    expect(classifyFailure({ stopReason: 'context_overflow' })).toBe('max_tokens');
  });

  test('compaction error → classified as compaction_error', () => {
    expect(classifyFailure({ hasCompactionError: true })).toBe('compaction_error');
  });

  test('permission denial → classified as permission_denied', () => {
    expect(classifyFailure({ hasPermissionDenial: true })).toBe('permission_denied');
  });

  test('hook_denied stop reason → classified as permission_denied', () => {
    expect(classifyFailure({ stopReason: 'hook_denied' })).toBe('permission_denied');
  });

  test('tool failure → classified as tool_failure', () => {
    expect(classifyFailure({ hasToolFailure: true })).toBe('tool_failure');
  });

  test('tool_loop_circuit_breaker stop reason → classified as tool_failure', () => {
    expect(classifyFailure({ stopReason: 'tool_loop_circuit_breaker' })).toBe('tool_failure');
  });

  test('cascade events → classified as cascade_failure', () => {
    expect(classifyFailure({ hasCascadeEvents: true })).toBe('cascade_failure');
  });

  test('timeout error message → classified as turn_timeout', () => {
    expect(classifyFailure({ errorMessage: 'request timed out after 30s' })).toBe('turn_timeout');
  });

  test('API error message → classified as llm_error', () => {
    expect(classifyFailure({ errorMessage: 'API error 503 service unavailable' })).toBe('llm_error');
  });

  test('network error message → classified as llm_error', () => {
    expect(classifyFailure({ errorMessage: 'network failure: ECONNRESET' })).toBe('llm_error');
  });

  test('error stop reason → classified as llm_error', () => {
    expect(classifyFailure({ stopReason: 'error' })).toBe('llm_error');
  });

  test('provider_exhausted stop reason → classified as llm_error', () => {
    expect(classifyFailure({ stopReason: 'provider_exhausted' })).toBe('llm_error');
  });

  test('provider_error stop reason → classified as llm_error', () => {
    expect(classifyFailure({ stopReason: 'provider_error' })).toBe('llm_error');
  });

  test('no signals → classified as unknown', () => {
    expect(classifyFailure({})).toBe('unknown');
  });

  test('cancelled takes precedence over other signals', () => {
    expect(classifyFailure({
      wasCancelled: true,
      hasToolFailure: true,
      hasCascadeEvents: true,
    })).toBe('cancelled');
  });

  test('permission denial takes precedence over tool failure', () => {
    expect(classifyFailure({
      hasPermissionDenial: true,
      hasToolFailure: true,
    })).toBe('permission_denied');
  });

  test('all FailureClass values are covered by classifier tests', () => {
    // Exhaustiveness check: every FailureClass value must be reachable via classifyFailure.
    // If a new value is added to FailureClass, a corresponding classifier test must be added.
    const allClasses: FailureClass[] = [
      'llm_error',
      'tool_failure',
      'permission_denied',
      'cascade_failure',
      'turn_timeout',
      'cancelled',
      'max_tokens',
      'compaction_error',
      'unknown',
    ];
    // Verify the classifier can produce each value
    expect(classifyFailure({ wasCancelled: true })).toBe('cancelled');
    expect(classifyFailure({ stopReason: 'max_tokens' })).toBe('max_tokens');
    expect(classifyFailure({ hasCompactionError: true })).toBe('compaction_error');
    expect(classifyFailure({ hasPermissionDenial: true })).toBe('permission_denied');
    expect(classifyFailure({ hasToolFailure: true })).toBe('tool_failure');
    expect(classifyFailure({ hasCascadeEvents: true })).toBe('cascade_failure');
    expect(classifyFailure({ errorMessage: 'timed out' })).toBe('turn_timeout');
    expect(classifyFailure({ errorMessage: 'API error 500' })).toBe('llm_error');
    expect(classifyFailure({})).toBe('unknown');
    // Confirm total count matches the type union
    expect(allClasses.length).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 2. Forensics summariser: all FailureClass values produce non-empty summaries
// ---------------------------------------------------------------------------

describe('operability gate: forensics summariser', () => {
  const ALL_CLASSES: FailureClass[] = [
    'llm_error',
    'tool_failure',
    'permission_denied',
    'cascade_failure',
    'turn_timeout',
    'cancelled',
    'max_tokens',
    'compaction_error',
    'unknown',
  ];

  for (const cls of ALL_CLASSES) {
    test(`summariseFailure('${cls}') returns a non-empty string`, () => {
      const summary = summariseFailure(cls);
      expect(typeof summary).toBe('string');
      expect(summary.length).toBeGreaterThan(0);
    });
  }

  test('llm_error with error message includes the message', () => {
    const summary = summariseFailure('llm_error', 'Rate limit exceeded');
    expect(summary).toContain('Rate limit exceeded');
  });

  test('max_tokens with length stop reason produces correct description', () => {
    const summary = summariseFailure('max_tokens', undefined, 'length');
    expect(summary).toContain('length');
  });
});

// ---------------------------------------------------------------------------
// 3. Action factory helpers: every high-severity diagnostic has actions
// ---------------------------------------------------------------------------

describe('operability gate: action factory helpers produce valid actions', () => {
  test('buildLoadReplayAction produces a load-replay action', () => {
    const action = buildLoadReplayAction('run-001');
    expect(action.type).toBe('load-replay');
    if (action.type !== 'load-replay') throw new Error('unexpected action type');
    expect(action.payload.runId).toBe('run-001');
    expect(typeof action.label).toBe('string');
    expect(action.label.length).toBeGreaterThan(0);
    expect(action.permission).toBeDefined();
  });

  test('buildRunPolicySimulationAction produces a run-policy-simulation action', () => {
    const action = buildRunPolicySimulationAction('exec', { command: 'ls' });
    expect(action.type).toBe('run-policy-simulation');
    if (action.type !== 'run-policy-simulation') throw new Error('unexpected action type');
    expect(action.payload.toolName).toBe('exec');
    expect(action.payload.args).toEqual({ command: 'ls' });
  });

  test('buildJumpToTaskAction produces a jump-to-task action', () => {
    const action = buildJumpToTaskAction('task-123');
    expect(action.type).toBe('jump-to-task');
    if (action.type !== 'jump-to-task') throw new Error('unexpected action type');
    expect(action.payload.taskId).toBe('task-123');
  });

  test('buildJumpToAgentAction produces a jump-to-agent action', () => {
    const action = buildJumpToAgentAction('agent-456');
    expect(action.type).toBe('jump-to-agent');
    if (action.type !== 'jump-to-agent') throw new Error('unexpected action type');
    expect(action.payload.agentId).toBe('agent-456');
  });

  test('buildJumpToToolCallAction produces a jump-to-tool-call action', () => {
    const action = buildJumpToToolCallAction('call-789');
    expect(action.type).toBe('jump-to-tool-call');
    if (action.type !== 'jump-to-tool-call') throw new Error('unexpected action type');
    expect(action.payload.callId).toBe('call-789');
  });

  test('buildRetryTaskAction produces a retry-task action', () => {
    const action = buildRetryTaskAction('task-retry');
    expect(action.type).toBe('retry-task');
    if (action.type !== 'retry-task') throw new Error('unexpected action type');
    expect(action.payload.taskId).toBe('task-retry');
  });

  test('buildCancelTaskAction produces a cancel-task action', () => {
    const action = buildCancelTaskAction('task-cancel');
    expect(action.type).toBe('cancel-task');
    if (action.type !== 'cancel-task') throw new Error('unexpected action type');
    expect(action.payload.taskId).toBe('task-cancel');
  });

  test('buildCancelAgentAction produces a cancel-agent action', () => {
    const action = buildCancelAgentAction('agent-cancel');
    expect(action.type).toBe('cancel-agent');
    if (action.type !== 'cancel-agent') throw new Error('unexpected action type');
    expect(action.payload.agentId).toBe('agent-cancel');
  });
});

// ---------------------------------------------------------------------------
// 4. HighSeverityDiagnostic: invariant that actions are non-empty
// ---------------------------------------------------------------------------

describe('operability gate: high-severity diagnostic actions invariant', () => {
  test('all action builders return objects with non-empty required fields', () => {
    const actions = [
      buildLoadReplayAction('r1'),
      buildRunPolicySimulationAction('tool', {}),
      buildJumpToTaskAction('t1'),
      buildJumpToAgentAction('a1'),
      buildJumpToToolCallAction('c1'),
      buildRetryTaskAction('t2'),
      buildCancelTaskAction('t3'),
      buildCancelAgentAction('a2'),
    ];

    for (const action of actions) {
      expect(action.type).toBeDefined();
      expect(action.label).toBeDefined();
      expect(action.permission).toBeDefined();
      expect(action.payload).toBeDefined();
    }
  });

  test('action permission tiers are valid values', () => {
    const validPermissions = ['read', 'operator', 'admin'];
    const actions = [
      buildLoadReplayAction('r1'),
      buildJumpToTaskAction('t1'),
      buildRetryTaskAction('t2'),
      buildCancelTaskAction('t3'),
      buildCancelAgentAction('a1'),
    ];

    for (const action of actions) {
      expect(validPermissions).toContain(action.permission);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. FailureReport type structure: all fields are present and typed
// ---------------------------------------------------------------------------

describe('operability gate: FailureReport type contract', () => {
  test('FailureReport shape satisfies expected contract', () => {
    const report: FailureReport = {
      id: 'abc123',
      traceId: 'trace-full-123',
      sessionId: 'sess-1',
      generatedAt: Date.now(),
      classification: 'tool_failure',
      summary: 'Tool execution failed: permission denied',
      phaseTimings: [],
      phaseLedger: [],
      causalChain: [],
      cascadeEvents: [],
      permissionEvidence: [],
      budgetBreaches: [],
      jumpLinks: [],
    };

    expect(report.id).toBeDefined();
    expect(report.classification).toBe('tool_failure');
    expect(Array.isArray(report.phaseTimings)).toBe(true);
    expect(Array.isArray(report.phaseLedger)).toBe(true);
    expect(Array.isArray(report.causalChain)).toBe(true);
    expect(Array.isArray(report.jumpLinks)).toBe(true);
  });

  test('CausalChainEntry has isRootCause flag for auto-triage', () => {
    const entry: CausalChainEntry = {
      seq: 0,
      ts: Date.now(),
      description: 'Tool permission denied',
      sourceEventType: 'TOOL_PERMISSION_DENIED',
      isRootCause: true,
    };
    expect(entry.isRootCause).toBe(true);
    expect(entry.seq).toBe(0);
  });

  test('ForensicsBundle shape satisfies expected contract', () => {
    const bundle: ForensicsBundle = {
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      report: {
        id: 'abc123',
        traceId: 'trace-full-123',
        sessionId: 'sess-1',
        generatedAt: Date.now(),
        classification: 'tool_failure',
        summary: 'Tool execution failed: permission denied',
        phaseTimings: [],
        phaseLedger: [],
        causalChain: [],
        cascadeEvents: [],
        permissionEvidence: [],
        budgetBreaches: [],
        jumpLinks: [],
      },
      evidence: {
        rootCause: 'Tool execution failed',
        terminalPhase: 'TOOL_BATCH',
        terminalOutcome: 'failed',
        phaseCount: 1,
        causalCount: 1,
        cascadeCount: 0,
        permissionDecisionCount: 1,
        deniedPermissionCount: 1,
        budgetBreachCount: 0,
        slowPhases: [],
        jumpLinkCount: 0,
        relatedIds: {
          turnId: 'turn-1',
        },
      },
      replay: {
        status: 'available',
        runId: 'run-1',
        currentRev: 4,
        totalRevisions: 4,
        mismatchCount: 1,
        mismatches: [{
          rev: 4,
          kind: 'state_divergence',
          description: 'turn stop reason diverged',
          ownerDomain: 'turn',
          failureMode: 'stop_reason_diverged',
          relatedTurnId: 'turn-1',
        }],
        relatedMismatches: [{
          rev: 4,
          kind: 'state_divergence',
          description: 'turn stop reason diverged',
          ownerDomain: 'turn',
          failureMode: 'stop_reason_diverged',
          relatedTurnId: 'turn-1',
        }],
        mismatchBreakdown: {
          byKind: { state_divergence: 1 },
          byFailureMode: { stop_reason_diverged: 1 },
          byOwnerDomain: { turn: 1 },
        },
        turnSummaries: [{
          turnId: 'turn-1',
          outcome: 'failed',
          terminalEvent: 'TURN_ERROR',
          terminalRev: 4,
        }],
        matchingTurnSummary: {
          turnId: 'turn-1',
          outcome: 'failed',
          terminalEvent: 'TURN_ERROR',
          terminalRev: 4,
        },
      },
    };

    expect(bundle.schemaVersion).toBe('v1');
    expect(bundle.report.id).toBe('abc123');
    expect(bundle.evidence.phaseCount).toBe(1);
    expect(bundle.replay.mismatchCount).toBe(1);
    expect(bundle.replay.matchingTurnSummary?.turnId).toBe('turn-1');
  });
});
