import { describe, expect, test } from 'bun:test';
import { buildIncidentMemoryAddOptions } from '../../state/memory-ingest.ts';
import type { ForensicsBundle } from '@pellux/goodvibes-sdk/platform/runtime/forensics/types';

describe('buildIncidentMemoryAddOptions', () => {
  test('maps a forensics bundle into a durable incident memory record', () => {
    const bundle: ForensicsBundle = {
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      report: {
        id: 'incident-1',
        traceId: 'trace-1',
        sessionId: 'session-1',
        generatedAt: Date.now(),
        classification: 'permission_denied',
        summary: 'permission prompt denied write access',
        stopReason: 'hook_denied',
        turnId: 'turn-1',
        taskId: 'task-1',
        phaseTimings: [],
        phaseLedger: [],
        causalChain: [],
        cascadeEvents: [],
        permissionEvidence: [],
        budgetBreaches: [],
        jumpLinks: [],
      },
      evidence: {
        rootCause: 'operator denied filesystem mutation',
        terminalPhase: 'PERMISSION',
        terminalOutcome: 'failed',
        phaseCount: 1,
        causalCount: 0,
        cascadeCount: 0,
        permissionDecisionCount: 1,
        deniedPermissionCount: 1,
        budgetBreachCount: 0,
        slowPhases: [],
        jumpLinkCount: 0,
        relatedIds: {
          turnId: 'turn-1',
          taskId: 'task-1',
        },
      },
      replay: {
        status: 'available',
        runId: 'run-1',
        currentRev: 2,
        totalRevisions: 4,
        mismatchCount: 0,
        mismatches: [],
        relatedMismatches: [],
        mismatchBreakdown: { byKind: {}, byFailureMode: {}, byOwnerDomain: {} },
        turnSummaries: [],
      },
    };

    const options = buildIncidentMemoryAddOptions(bundle);
    expect(options.cls).toBe('incident');
    expect(options.summary).toBe('permission prompt denied write access');
    expect(options.tags).toContain('forensics');
    expect(options.tags).toContain('permission_denied');
    expect(options.review?.state).toBe('fresh');
    expect(options.review?.confidence).toBe(90);
    expect(options.provenance).toEqual([
      { kind: 'session', ref: 'session-1' },
      { kind: 'turn', ref: 'turn-1' },
      { kind: 'task', ref: 'task-1' },
    ]);
    expect(options.detail).toContain('rootCause=operator denied filesystem mutation');
  });
});
