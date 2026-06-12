// ---------------------------------------------------------------------------
// agent-detail-cancel.test.ts
// TASK-043 + TASK-045: cancel affordance + stall watchdog on AgentDetailModal
//
// Tests:
//   - cancel offered/not-offered by agent status
//   - confirm accept (Enter / return / y)
//   - confirm cancel (Esc / n)
//   - absorbed keys while confirm is pending
//   - handleKey returns false when modal is inactive
//   - isCurrentAgentStalled boundary (5-min threshold)
//   - getStalledAgentCount across all agents
// ---------------------------------------------------------------------------

import { describe, test, expect, mock } from 'bun:test';
import { AgentDetailModal } from '../../renderer/agent-detail-modal.ts';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIVE_MIN_MS = 5 * 60 * 1000;

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'modal-agent-01',
    task: 'Modal test task',
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

function makeModal(options: {
  records?: AgentRecord[];
  cancelAgent?: (id: string) => boolean;
} = {}) {
  const records = options.records ?? [];
  const cancelAgent = options.cancelAgent ?? mock(() => true);

  const agentManager = {
    getStatus: mock((id: string) => records.find(r => r.id === id) ?? null),
    list: mock(() => records),
  };

  const modal = new AgentDetailModal({
    agentManager,
    agentMessageBus: { getMessages: mock(() => []) },
    sessionLogPathResolver: (id: string) => `/tmp/sessions/${id}.jsonl`,
    cancelAgent,
  });

  return { modal, agentManager, cancelAgent };
}

/** Open modal for the first record in records. */
function openFor(modal: AgentDetailModal, rec: AgentRecord): void {
  // Patch open to avoid actual file I/O from loadLog
  const orig = modal.loadLog.bind(modal);
  modal.loadLog = async () => {};
  modal.open(rec.id);
  modal.loadLog = orig;
}

// ---------------------------------------------------------------------------
// Inactive modal guard
// ---------------------------------------------------------------------------

describe('AgentDetailModal.handleKey — inactive guard', () => {
  test('returns false when modal is not active', () => {
    const rec = makeRecord({ status: 'running' });
    const { modal } = makeModal({ records: [rec] });
    // modal is not open
    expect(modal.handleKey('c')).toBe(false);
    expect(modal.handleKey('y')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cancel offered/not-offered by agent status
// ---------------------------------------------------------------------------

describe('AgentDetailModal — cancel initiation by status', () => {
  test('c key initiates confirm for running agent', () => {
    const rec = makeRecord({ id: 'modal-run', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    expect(modal.handleKey('c')).toBe(true);
    expect(modal.confirmCancel).not.toBeNull();
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('c key initiates confirm for pending agent', () => {
    const rec = makeRecord({ id: 'modal-pend', status: 'pending' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    expect(modal.handleKey('c')).toBe(true);
    expect(modal.confirmCancel).not.toBeNull();
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('c key does NOT initiate confirm for completed agent', () => {
    const rec = makeRecord({ id: 'modal-done', status: 'completed' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    expect(modal.handleKey('c')).toBe(true); // absorbed silently
    expect(modal.confirmCancel).toBeNull();
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('c key does NOT initiate confirm for failed agent', () => {
    const rec = makeRecord({ id: 'modal-fail', status: 'failed' });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    expect(modal.confirmCancel).toBeNull();
  });

  test('c key does NOT initiate confirm for cancelled agent', () => {
    const rec = makeRecord({ id: 'modal-cxd', status: 'cancelled' });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    expect(modal.confirmCancel).toBeNull();
  });

  test('confirmCancel.subject is set to the agent id', () => {
    const rec = makeRecord({ id: 'modal-subj', status: 'running', task: 'My important task' });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    expect(modal.confirmCancel?.subject).toBe(rec.id);
  });

  test('confirmCancel.label is derived from first 40 chars of task', () => {
    const longTask = 'A'.repeat(60);
    const rec = makeRecord({ id: 'modal-label', status: 'running', task: longTask });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    expect(modal.confirmCancel?.label.length).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Confirm accept
// ---------------------------------------------------------------------------

describe('AgentDetailModal — confirm accept', () => {
  test('Enter confirms and calls cancelAgent', () => {
    const rec = makeRecord({ id: 'modal-ca', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    const consumed = modal.handleKey('enter');
    expect(consumed).toBe(true);
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
    expect(modal.confirmCancel).toBeNull();
  });

  test('return key confirms cancel', () => {
    const rec = makeRecord({ id: 'modal-cb', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    modal.handleKey('return');
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });

  test('y key confirms cancel', () => {
    const rec = makeRecord({ id: 'modal-cc', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    modal.handleKey('y');
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
    expect(modal.confirmCancel).toBeNull();
  });

  test('cancel is invoked exactly once per confirm', () => {
    const rec = makeRecord({ id: 'modal-cd', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    modal.handleKey('y');
    modal.handleKey('y'); // confirm already cleared
    expect(cancelAgent).toHaveBeenCalledTimes(1);
  });

  test('does NOT cancel if agent became terminal before confirm', () => {
    const rec = makeRecord({ id: 'modal-ce', status: 'running' });
    const { modal, agentManager, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c'); // initiate confirm
    // Simulate agent completing between c and confirm key
    agentManager.getStatus.mockImplementation(() => ({ ...rec, status: 'completed' as const }));

    modal.handleKey('y');
    expect(cancelAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Confirm cancel (Esc / n)
// ---------------------------------------------------------------------------

describe('AgentDetailModal — confirm cancel (Esc / n)', () => {
  test('n key dismisses confirm without calling cancelAgent', () => {
    const rec = makeRecord({ id: 'modal-cn', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    const consumed = modal.handleKey('n');
    expect(consumed).toBe(true);
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(modal.confirmCancel).toBeNull();
  });

  test('escape key dismisses confirm without calling cancelAgent', () => {
    const rec = makeRecord({ id: 'modal-ce2', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    const consumed = modal.handleKey('escape');
    expect(consumed).toBe(true);
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(modal.confirmCancel).toBeNull();
  });

  test('after Esc, c can re-initiate confirm', () => {
    const rec = makeRecord({ id: 'modal-cf', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    modal.handleKey('escape'); // dismiss
    modal.handleKey('c');     // re-initiate
    modal.handleKey('y');     // confirm
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });
});

// ---------------------------------------------------------------------------
// Absorbed keys while confirm pending
// ---------------------------------------------------------------------------

describe('AgentDetailModal — absorbed keys while confirm pending', () => {
  test('unrelated keys are consumed (return true) while confirm is pending', () => {
    const rec = makeRecord({ id: 'modal-abs', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');

    for (const key of ['up', 'down', 'tab', 'x', 'd', ' ', 'pagedown']) {
      expect(modal.handleKey(key)).toBe(true);
    }
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  test('absorbed keys do not clear confirmCancel', () => {
    const rec = makeRecord({ id: 'modal-abs2', status: 'running' });
    const { modal, cancelAgent } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    modal.handleKey('x');  // absorbed
    modal.handleKey('up'); // absorbed
    expect(modal.confirmCancel).not.toBeNull();
    modal.handleKey('y'); // confirm still pending → executes
    expect(cancelAgent).toHaveBeenCalledWith(rec.id);
  });
});

// ---------------------------------------------------------------------------
// close() resets confirmCancel
// ---------------------------------------------------------------------------

describe('AgentDetailModal.close', () => {
  test('close() resets confirmCancel to null', () => {
    const rec = makeRecord({ id: 'modal-cl', status: 'running' });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);

    modal.handleKey('c');
    expect(modal.confirmCancel).not.toBeNull();

    modal.close();
    expect(modal.confirmCancel).toBeNull();
    expect(modal.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCurrentAgentStalled — TASK-045
// ---------------------------------------------------------------------------

describe('AgentDetailModal.isCurrentAgentStalled', () => {
  test('returns false when no agentId is set', () => {
    const { modal } = makeModal();
    expect(modal.isCurrentAgentStalled()).toBe(false);
  });

  test('returns false for running agent under threshold', () => {
    const rec = makeRecord({ id: 'st-a', status: 'running', startedAt: Date.now() - FIVE_MIN_MS + 5000 });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);
    expect(modal.isCurrentAgentStalled()).toBe(false);
  });

  test('returns true for running agent exactly at threshold', () => {
    const rec = makeRecord({ id: 'st-b', status: 'running', startedAt: Date.now() - FIVE_MIN_MS });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);
    expect(modal.isCurrentAgentStalled()).toBe(true);
  });

  test('returns true for running agent past threshold', () => {
    const rec = makeRecord({ id: 'st-c', status: 'running', startedAt: Date.now() - FIVE_MIN_MS - 2000 });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);
    expect(modal.isCurrentAgentStalled()).toBe(true);
  });

  test('returns false for completed agent even if past threshold', () => {
    const rec = makeRecord({ id: 'st-d', status: 'completed', startedAt: Date.now() - FIVE_MIN_MS - 1000 });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);
    expect(modal.isCurrentAgentStalled()).toBe(false);
  });

  test('returns false for failed agent even if past threshold', () => {
    const rec = makeRecord({ id: 'st-e', status: 'failed', startedAt: Date.now() - FIVE_MIN_MS - 1000 });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);
    expect(modal.isCurrentAgentStalled()).toBe(false);
  });

  test('returns false for cancelled agent even if past threshold', () => {
    const rec = makeRecord({ id: 'st-f', status: 'cancelled', startedAt: Date.now() - FIVE_MIN_MS - 1000 });
    const { modal } = makeModal({ records: [rec] });
    openFor(modal, rec);
    expect(modal.isCurrentAgentStalled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getStalledAgentCount — TASK-045
// ---------------------------------------------------------------------------

describe('AgentDetailModal.getStalledAgentCount', () => {
  test('returns 0 when no agents', () => {
    const { modal } = makeModal({ records: [] });
    expect(modal.getStalledAgentCount()).toBe(0);
  });

  test('returns 0 when all agents are terminal', () => {
    const ago = Date.now() - FIVE_MIN_MS - 1000;
    const records = [
      makeRecord({ id: 'sc-a1', status: 'completed', startedAt: ago }),
      makeRecord({ id: 'sc-a2', status: 'failed', startedAt: ago }),
      makeRecord({ id: 'sc-a3', status: 'cancelled', startedAt: ago }),
    ];
    const { modal } = makeModal({ records });
    expect(modal.getStalledAgentCount()).toBe(0);
  });

  test('returns 0 for running agent under threshold', () => {
    const records = [
      makeRecord({ id: 'sc-b', status: 'running', startedAt: Date.now() - FIVE_MIN_MS + 5000 }),
    ];
    const { modal } = makeModal({ records });
    expect(modal.getStalledAgentCount()).toBe(0);
  });

  test('returns 1 for running agent exactly at threshold', () => {
    const records = [
      makeRecord({ id: 'sc-c', status: 'running', startedAt: Date.now() - FIVE_MIN_MS }),
    ];
    const { modal } = makeModal({ records });
    expect(modal.getStalledAgentCount()).toBe(1);
  });

  test('counts only non-terminal stalled agents across all agents', () => {
    const ago = Date.now() - FIVE_MIN_MS - 1000;
    const records = [
      makeRecord({ id: 'sc-d1', status: 'running', startedAt: ago }),   // stalled
      makeRecord({ id: 'sc-d2', status: 'pending', startedAt: ago }),   // stalled
      makeRecord({ id: 'sc-d3', status: 'completed', startedAt: ago }), // terminal
      makeRecord({ id: 'sc-d4', status: 'failed', startedAt: ago }),    // terminal
      makeRecord({ id: 'sc-d5', status: 'running', startedAt: Date.now() - 1000 }), // fresh
    ];
    const { modal } = makeModal({ records });
    expect(modal.getStalledAgentCount()).toBe(2);
  });
});
