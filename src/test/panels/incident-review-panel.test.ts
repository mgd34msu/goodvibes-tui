import { describe, expect, test } from 'bun:test';
import { ForensicsRegistry } from '../../runtime/forensics/registry.ts';
import type { FailureReport } from '../../runtime/forensics/types.ts';
import { IncidentReviewPanel } from '../../panels/incident-review-panel.ts';
import type { Line } from '../../types/grid.ts';
import type { ReplaySnapshotInput } from '../../runtime/forensics/registry.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeReport(id: string): FailureReport {
  return {
    id,
    traceId: `trace-${id}`,
    sessionId: 'sess-incident',
    generatedAt: Date.now(),
    classification: 'tool_failure',
    summary: 'tool failed during deploy',
    taskId: 'task-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    stopReason: 'tool_loop_circuit_breaker',
    errorMessage: 'tool failed',
    phaseTimings: [{ phase: 'EXECUTE', startedAt: 1, endedAt: 2, durationMs: 1, success: false, error: 'boom' }],
    phaseLedger: [{ seq: 1, domain: 'task', phase: 'EXECUTE', enterEventType: 'TASK_STARTED', enteredAt: 1, exitEventType: 'TASK_FAILED', exitedAt: 2, durationMs: 1, outcome: 'failed', error: 'boom' }],
    causalChain: [{ seq: 1, ts: 1, description: 'tool failure', sourceEventType: 'TASK_FAILED', isRootCause: true }],
    cascadeEvents: [],
    permissionEvidence: [{ callId: 'call-1', tool: 'exec', approved: false, summary: 'denied' }],
    budgetBreaches: [{ callId: 'call-1', tool: 'exec', eventType: 'BUDGET_EXCEEDED_MS', phase: 'EXECUTE', ts: 2, meta: { durationMs: 5000 } }],
    jumpLinks: [],
  };
}

describe('IncidentReviewPanel', () => {
  test('renders empty guidance when there are no incidents', () => {
    const panel = new IncidentReviewPanel(new ForensicsRegistry());
    const text = linesText(panel.render(120, 12));
    expect(text).toContain('Incident Review Workspace');
    expect(text).toContain('No incidents recorded yet');
    expect(text).toContain('/recall capture incident latest');
  });

  test('renders bundle evidence for the selected incident', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-1'));
    const panel = new IncidentReviewPanel(registry);
    const text = linesText(panel.render(140, 16));
    expect(text).toContain('Incident Review Workspace');
    expect(text).toContain('tool failed during deploy');
    expect(text).toContain('Root cause');
    expect(text).toContain('Permissions denied');
    expect(text).toContain('Budget breaches');
    expect(text).toContain('Related IDs');
    expect(text).toContain('Action Rail');
  });

  test('renders replay and permission detail from the selected bundle', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-2'));
    const snapshot: ReplaySnapshotInput = {
      status: 'loaded',
      runId: 'replay-1',
      currentRev: 4,
      totalRevisions: 4,
      mismatches: [
        {
          rev: 4,
          kind: 'state_divergence',
          description: 'terminal outcome drift',
          ownerDomain: 'turn',
          failureMode: 'terminal_outcome',
          relatedTurnId: 'turn-1',
        },
      ],
      turnSummaries: [
        {
          turnId: 'turn-1',
          outcome: 'failed',
          terminalEvent: 'TURN_ERROR',
          terminalRev: 4,
          stopReason: 'tool_loop_circuit_breaker',
        },
      ],
    };
    const panel = new IncidentReviewPanel(registry);
    const originalBuildBundle = registry.buildBundle.bind(registry);
    registry.buildBundle = ((id: string) => originalBuildBundle(id, { replaySnapshot: snapshot })) as typeof registry.buildBundle;
    const text = linesText(panel.render(140, 18));
    expect(text).toContain('Root event');
    expect(text).toContain('Permission:');
    expect(text).toContain('Replay link:');
    expect(text).toContain('Replay owners:');
    expect(text).toContain('turn:1');
  });

  test('supports focused incident review actions for the selected bundle', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('incident-3'));
    registry.push(makeReport('incident-4'));
    const panel = new IncidentReviewPanel(registry);
    expect(panel.handleInput('end')).toBe(true);
    const text = linesText(panel.render(140, 20));
    expect(text).toContain('selected 2/2');
    expect(text).toContain('Action Rail');
    expect(text).toMatch(/\/recall capture incident incident-[34]/);
  });
});
