import { describe, test, expect } from 'bun:test';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { AgentLogsPanel } from '../../../panels/agent-logs-panel.ts';
import { runBasePanelContractSuite, linesText, EMPTY_OPS_EVENT_FEED, EMPTY_AGENT_DEPS } from './_shared.ts';

runBasePanelContractSuite({
  label: 'AgentLogsPanel',
  factory: () => new AgentLogsPanel(EMPTY_OPS_EVENT_FEED as never, EMPTY_AGENT_DEPS),
  hasSelectionGutter: true, // I5: non-color selection affordance
});

// ---------------------------------------------------------------------------
// AgentLogsPanel — shared-workspace empty state (moved from workspace-migration.test.ts)
// ---------------------------------------------------------------------------

function createAgentLogsPanel(runtimeBus: RuntimeEventBus): AgentLogsPanel {
  return new AgentLogsPanel(createUiRuntimeEvents(runtimeBus).agents, {
    agentManager: {
      list: () => [],
    },
    workingDirectory: '/tmp/goodvibes-test',
  });
}

describe('workspace panel migrations', () => {
  test('AgentLogsPanel renders shared workspace empty state cleanly', async () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createAgentLogsPanel(runtimeBus);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Agents');
    expect(linesText(lines)).toContain('No agents running');
  });
});
