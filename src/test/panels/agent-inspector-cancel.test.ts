// ---------------------------------------------------------------------------
// agent-inspector-cancel.test.ts
// TASK-043 + TASK-045: cancel affordance + stall watchdog on AgentInspectorPanel
//
// Tests:
//   - cancel offered/not-offered by agent status
//   - confirm accept (Enter / y)
//   - confirm cancel (Esc / n)
//   - absorbed keys while confirm is pending
//   - stalled badge boundary (5-min threshold)
// ---------------------------------------------------------------------------

import { describe, test, expect, mock } from 'bun:test';
import { AgentInspectorPanel } from '../../panels/agent-inspector-panel.ts';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIVE_MIN_MS = 5 * 60 * 1000;

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-test-01',
    task: 'Test task description',
    template: 'engineer',
    tools: [],
    status: 'running',
    startedAt: Date.now() - 1000,
    orchestrationDepth: 0,
    toolCallCount: 0,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'wrfc',
    communicationLane: 'direct',
    fullOutput: null,
    ...overrides,
  };
}

function makePanel(options: {
  records?: AgentRecord[];
  cancelAgent?: (id: string) => boolean;
} = {}) {
  const records = options.records ?? [];
  const cancelAgent = options.cancelAgent ?? mock(() => true);

  const agentManager = {
    list: mock(() => records),
    getStatus: mock((id: string) => records.find(r => r.id === id) ?? null),
    cancel: mock(() => true),
  };

  const agentMessageBus = {
    getMessages: mock(() => []),
  };

  const panel = new AgentInspectorPanel({
    agentManager,
    agentMessageBus,
    workingDirectory: '/tmp/test',
    cancelAgent,
  });

  return { panel, agentManager, cancelAgent };
}

// ---------------------------------------------------------------------------
// Cancel offered/not-offered by agent status
// ---------------------------------------------------------------------------

describe('AgentInspectorPanel — cancel initiation', () => {
  test('c key initiates confirm for running agent', () => {
    const rec = makeRecord({ id: 'agent-run', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    // Press c — should enter confirm state (no cancel called yet)
    panel.handleInput('c');
    expect(cancelAgent).not.toHaveBeenCalled();

    // Confirm with y — should trigger cancel
    panel.handleInput('y');
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });

  test('c key initiates confirm for pending agent', () => {
    const rec = makeRecord({ id: 'agent-pend', status: 'pending' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    expect(cancelAgent).not.toHaveBeenCalled();

    panel.handleInput('enter');
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });

  test('c key does NOT cancel completed agent', () => {
    const rec = makeRecord({ id: 'agent-done', status: 'completed' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    // Even pressing y afterwards should not call cancelAgent
    panel.handleInput('y');
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('c key does NOT cancel failed agent', () => {
    const rec = makeRecord({ id: 'agent-fail', status: 'failed' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    panel.handleInput('y');
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('c key does NOT cancel already-cancelled agent', () => {
    const rec = makeRecord({ id: 'agent-cxd', status: 'cancelled' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    panel.handleInput('y');
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('c key without selected agent is a noop', () => {
    const rec = makeRecord({ status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    // No inspectAgent() call — no selection

    panel.handleInput('c');
    panel.handleInput('y');
    expect(cancelAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Confirm accept
// ---------------------------------------------------------------------------

describe('AgentInspectorPanel — confirm accept', () => {
  test('Enter confirms cancel', () => {
    const rec = makeRecord({ id: 'agent-a', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    const consumed = panel.handleInput('enter');
    expect(consumed).toBe(true);
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });

  test('return key confirms cancel', () => {
    const rec = makeRecord({ id: 'agent-b', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    panel.handleInput('return');
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });

  test('y key confirms cancel', () => {
    const rec = makeRecord({ id: 'agent-c', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    panel.handleInput('y');
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });

  test('cancel is invoked exactly once per confirm', () => {
    const rec = makeRecord({ id: 'agent-d', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    panel.handleInput('y');
    panel.handleInput('y'); // second y — confirm is already cleared
    expect(cancelAgent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Confirm cancel (Esc / n)
// ---------------------------------------------------------------------------

describe('AgentInspectorPanel — confirm cancel', () => {
  test('Esc key cancels the confirm — does not call cancelAgent', () => {
    const rec = makeRecord({ id: 'agent-e', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    const consumed = panel.handleInput('escape');
    expect(consumed).toBe(true);
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('n key cancels the confirm — does not call cancelAgent', () => {
    const rec = makeRecord({ id: 'agent-f', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    panel.handleInput('n');
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('after Esc, c can initiate a new confirm', () => {
    const rec = makeRecord({ id: 'agent-g', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    panel.handleInput('escape'); // dismiss
    panel.handleInput('c');
    panel.handleInput('y');     // confirm this time
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });
});

// ---------------------------------------------------------------------------
// Absorbed keys while confirm is pending
// ---------------------------------------------------------------------------

describe('AgentInspectorPanel — confirm absorbs non-confirm keys', () => {
  test('unrelated keys return true while confirm is pending', () => {
    const rec = makeRecord({ id: 'agent-h', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c'); // enter confirm mode

    for (const key of ['up', 'down', 'tab', 'x', 'd', ' ']) {
      const consumed = panel.handleInput(key);
      expect(consumed).toBe(true); // absorbed
    }

    // confirm still pending — cancelAgent not called
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('absorbed keys do not clear confirm state', () => {
    const rec = makeRecord({ id: 'agent-i', status: 'running' });
    const { panel, cancelAgent } = makePanel({ records: [rec] });
    panel.inspectAgent(rec.id);

    panel.handleInput('c');
    panel.handleInput('up');  // absorbed
    panel.handleInput('down'); // absorbed
    panel.handleInput('y'); // confirm still pending → executed now
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });
});

// ---------------------------------------------------------------------------
// Stalled agent count — TASK-045
// ---------------------------------------------------------------------------

describe('AgentInspectorPanel — getStalledAgentCount', () => {
  test('returns 0 when no agents', () => {
    const { panel } = makePanel({ records: [] });
    expect(panel.getStalledAgentCount()).toBe(0);
  });

  test('returns 0 when all agents are terminal (completed)', () => {
    const records = [
      makeRecord({ id: 'a1', status: 'completed', startedAt: Date.now() - FIVE_MIN_MS - 1 }),
      makeRecord({ id: 'a2', status: 'failed', startedAt: Date.now() - FIVE_MIN_MS - 1 }),
      makeRecord({ id: 'a3', status: 'cancelled', startedAt: Date.now() - FIVE_MIN_MS - 1 }),
    ];
    const { panel } = makePanel({ records });
    expect(panel.getStalledAgentCount()).toBe(0);
  });

  test('returns 0 for running agent under threshold', () => {
    const records = [
      makeRecord({ id: 'a4', status: 'running', startedAt: Date.now() - FIVE_MIN_MS + 5000 }),
    ];
    const { panel } = makePanel({ records });
    expect(panel.getStalledAgentCount()).toBe(0);
  });

  test('returns 1 for running agent exactly at threshold', () => {
    const records = [
      makeRecord({ id: 'a5', status: 'running', startedAt: Date.now() - FIVE_MIN_MS }),
    ];
    const { panel } = makePanel({ records });
    expect(panel.getStalledAgentCount()).toBe(1);
  });

  test('returns 1 for running agent past threshold', () => {
    const records = [
      makeRecord({ id: 'a6', status: 'running', startedAt: Date.now() - FIVE_MIN_MS - 1000 }),
    ];
    const { panel } = makePanel({ records });
    expect(panel.getStalledAgentCount()).toBe(1);
  });

  test('counts only non-terminal stalled agents', () => {
    const ago = Date.now() - FIVE_MIN_MS - 1000;
    const records = [
      makeRecord({ id: 'b1', status: 'running', startedAt: ago }),   // stalled
      makeRecord({ id: 'b2', status: 'pending', startedAt: ago }),   // stalled
      makeRecord({ id: 'b3', status: 'completed', startedAt: ago }), // terminal — not stalled
      makeRecord({ id: 'b4', status: 'failed', startedAt: ago }),    // terminal — not stalled
      makeRecord({ id: 'b5', status: 'running', startedAt: Date.now() - 1000 }), // fresh — not stalled
    ];
    const { panel } = makePanel({ records });
    expect(panel.getStalledAgentCount()).toBe(2);
  });
});
