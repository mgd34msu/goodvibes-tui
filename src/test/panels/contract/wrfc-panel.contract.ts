import { describe, test, expect } from 'bun:test';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { WrfcPanel } from '../../../panels/wrfc-panel.ts';
import { runBasePanelContractSuite, linesText, EMPTY_WORKFLOW_EVENT_FEED, EMPTY_WRFC_DEPS } from './_shared.ts';

runBasePanelContractSuite({
  label: 'WrfcPanel (no chains)',
  factory: () => new WrfcPanel(EMPTY_WORKFLOW_EVENT_FEED as never, EMPTY_WRFC_DEPS),
});

// ---------------------------------------------------------------------------
// WrfcPanel — shared-workspace empty state (moved from workspace-migration.test.ts)
// ---------------------------------------------------------------------------

function createWrfcPanel(runtimeBus: RuntimeEventBus): WrfcPanel {
  return new WrfcPanel(createUiRuntimeEvents(runtimeBus).workflows, {
    controller: {
      listChains: () => [],
    },
  });
}

describe('workspace panel migrations', () => {
  test('WrfcPanel renders shared workspace empty state cleanly', async () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createWrfcPanel(runtimeBus);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('WRFC Chain Monitor');
    expect(linesText(lines)).toContain('No WRFC chains yet');
  });
});
