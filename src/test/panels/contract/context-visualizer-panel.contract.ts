import { describe, test, expect } from 'bun:test';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { ContextVisualizerPanel } from '../../../panels/context-visualizer-panel.ts';
import { runBasePanelContractSuite, linesText, EMPTY_TURN_EVENT_FEED, EMPTY_SESSION_MEMORY_QUERY, EMPTY_CONFIG_MANAGER } from './_shared.ts';

runBasePanelContractSuite({
  label: 'ContextVisualizerPanel (no usage)',
  factory: () => new ContextVisualizerPanel(EMPTY_TURN_EVENT_FEED as never, EMPTY_SESSION_MEMORY_QUERY, EMPTY_CONFIG_MANAGER),
  skipHandleInput: true,
});

// ---------------------------------------------------------------------------
// ContextVisualizerPanel — shared-workspace empty state (moved from workspace-migration.test.ts)
// ---------------------------------------------------------------------------

describe('workspace panel migrations', () => {
  test('ContextVisualizerPanel renders shared workspace empty state cleanly', async () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = new ContextVisualizerPanel(
      createUiRuntimeEvents(runtimeBus).turns,
      new SessionMemoryStore(),
      new ConfigManager({ surfaceRoot: 'tui', homeDir: '/tmp', workingDir: '/tmp' }),
    );
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Context Usage');
    expect(linesText(lines)).toContain('Context limit unavailable');
  });
});
