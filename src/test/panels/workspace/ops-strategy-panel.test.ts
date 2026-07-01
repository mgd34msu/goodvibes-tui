import { beforeEach, describe, expect, test } from 'bun:test';
import { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { OpsStrategyPanel } from '../../../panels/ops-strategy-panel.ts';
import { createRuntimeBusStub, linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('OpsStrategyPanel renders shared workspace empty state cleanly', async () => {
    const panel = new OpsStrategyPanel(createUiRuntimeEvents(runtimeBus).planner, new AdaptivePlanner());
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Ops Strategy');
    expect(linesText(lines)).toContain('No decisions recorded yet');
    // UX: empty state offers a concrete next-step command instead of a dead end.
    expect(linesText(lines)).toContain('/ops');
  });
});
