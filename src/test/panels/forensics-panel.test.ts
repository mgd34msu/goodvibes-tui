import { describe, expect, test } from 'bun:test';
import { ForensicsRegistry } from '@/runtime/index.ts';
import type { FailureReport } from '@/runtime/index.ts';
import { ForensicsPanel } from '../../panels/forensics-panel.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeReport(id: string, overrides: Partial<FailureReport> = {}): FailureReport {
  return {
    id,
    traceId: `trace-${id}`,
    sessionId: 'sess-forensics',
    generatedAt: Date.now(),
    classification: 'tool_failure',
    summary: 'tool failed during deploy',
    taskId: 'task-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    stopReason: 'tool_loop_circuit_breaker',
    errorMessage: 'tool failed',
    phaseTimings: [{ phase: 'EXECUTE', startedAt: 1, endedAt: 2, durationMs: 1, success: false, error: 'boom' }],
    phaseLedger: [],
    causalChain: [{ seq: 1, ts: 1, description: 'tool failure', sourceEventType: 'TASK_FAILED', isRootCause: true }],
    cascadeEvents: [],
    permissionEvidence: [],
    budgetBreaches: [],
    jumpLinks: [],
    ...overrides,
  };
}

describe('ForensicsPanel', () => {
  test('renders actionable empty state when no failure reports exist', () => {
    const panel = new ForensicsPanel(new ForensicsRegistry());
    const text = linesText(panel.render(100, 16));
    expect(text).toContain('Failure Forensics');
    expect(text).toContain('No failure reports');
    expect(text).toContain('/incident');
  });

  test('list view shows a posture summary with report and error counts', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('rep-1'));
    registry.push(makeReport('rep-2', { classification: 'cancelled' }));
    const panel = new ForensicsPanel(registry);
    const text = linesText(panel.render(110, 20));
    expect(text).toContain('reports');
    expect(text).toContain('errors');
    expect(text).toContain('newest');
    expect(text).toContain('tool failed during deploy');
  });

  test('Enter expands a report into detail view; Esc returns to the list', () => {
    const registry = new ForensicsRegistry();
    registry.push(makeReport('rep-detail'));
    const panel = new ForensicsPanel(registry);
    expect(panel.handleInput('enter')).toBe(true);
    const detail = linesText(panel.render(110, 24));
    expect(detail).toContain('Report Detail');
    expect(detail).toContain('Causal Chain');
    expect(panel.handleInput('escape')).toBe(true);
    const list = linesText(panel.render(110, 24));
    expect(list).toContain('reports');
  });
});
