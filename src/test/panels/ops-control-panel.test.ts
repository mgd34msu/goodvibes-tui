import { describe, expect, test } from 'bun:test';
import { OpsControlPanel } from '../../panels/ops-control-panel.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

const EMPTY_OPS_EVENT_FEED = {
  on: (_event: string, _cb: unknown) => () => {},
  onEnvelope: (_event: string, _cb: unknown) => () => {},
  emit: () => {},
} as unknown as import('../../runtime/ui-events.ts').UiEventFeed<never>;

describe('OpsControlPanel', () => {
  test('empty render surfaces outcome tallies, actionable empty state, and context hints', () => {
    const panel = new OpsControlPanel(EMPTY_OPS_EVENT_FEED);
    const lines = panel.render(100, 24);
    expect(lines).toHaveLength(24);
    expect(lines.every((line) => line.length === 100)).toBe(true);

    const text = linesText(lines);
    expect(text).toContain('Operator Control Plane');
    // Outcome posture counts (most important runtime info first).
    expect(text).toContain('logged');
    expect(text).toContain('rejected');
    // Actionable empty state + context-aware footer hints.
    expect(text).toContain('No operator interventions recorded');
    expect(text).toContain('/cockpit');
    expect(text).toContain('browse log');
  });
});
