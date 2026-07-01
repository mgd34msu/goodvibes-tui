import { describe, expect, test } from 'bun:test';
import { AgentInspectorPanel } from '../../../panels/agent-inspector-panel.ts';
import { linesText } from './_shared.ts';

function createAgentInspectorPanel(): AgentInspectorPanel {
  return new AgentInspectorPanel({
    agentManager: {
      list: () => [],
      getStatus: () => null,
    },
    agentMessageBus: {
      getMessages: () => [],
    },
    workingDirectory: '/tmp/goodvibes-test',
  });
}

describe('workspace panel migrations', () => {
  test('AgentInspectorPanel renders shared workspace empty state cleanly', async () => {
    const panel = createAgentInspectorPanel();
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Inspector');
    expect(linesText(lines)).toContain('No agents running');
  });
});
