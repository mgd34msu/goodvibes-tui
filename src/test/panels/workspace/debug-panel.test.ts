import { beforeEach, describe, expect, test } from 'bun:test';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { DebugPanel } from '../../../panels/debug-panel.ts';
import { createRuntimeBusStub, linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('DebugPanel renders shared workspace empty state cleanly', async () => {
    const panel = new DebugPanel(createUiRuntimeEvents(runtimeBus).turns);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('API Debug');
    expect(linesText(lines)).toContain('No calls yet');
  });
});
