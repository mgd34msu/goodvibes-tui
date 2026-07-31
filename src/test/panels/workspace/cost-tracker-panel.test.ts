import { beforeEach, describe, expect, test } from 'bun:test';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '@/runtime/index.ts';
import { CostTrackerPanel } from '../../../panels/cost-tracker-panel.ts';
import { createRuntimeBusStub, linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('CostTrackerPanel renders shared workspace empty state cleanly', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new CostTrackerPanel(events.turns, events.agents, () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      model: 'unknown',
    }));
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Cost Tracker');
    expect(linesText(lines)).toContain('No agents spawned this session');
  });
});
