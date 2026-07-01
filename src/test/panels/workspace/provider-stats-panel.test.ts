import { beforeEach, describe, expect, test } from 'bun:test';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { ProviderStatsPanel } from '../../../panels/provider-stats-panel.ts';
import { createTestProviderRegistry } from '../../helpers/test-managers.ts';
import { createRuntimeBusStub, linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('ProviderStatsPanel renders shared workspace empty state cleanly', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const providerRegistry = createTestProviderRegistry();
    const panel = new ProviderStatsPanel(events.turns, events.providers, undefined, {
      getSnapshot: () => ({
        providerIds: [...new Set(providerRegistry.listModels().map((model) => model.provider))].sort(),
      }),
      subscribe: () => () => {},
    });
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Provider Stats');
    expect(linesText(lines)).toContain('No providers registered');
  });
});
