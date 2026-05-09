import { describe, expect, test } from 'bun:test';
import { summarizeRunningAgents } from '../../renderer/process-summary.ts';

describe('summarizeRunningAgents', () => {
  test('counts active manager and runtime agents once', () => {
    const summary = summarizeRunningAgents(
      [{ id: 'agent-1', progress: 'doing work' }],
      [{ id: 'agent-1', latestProgress: 'runtime work' }, { id: 'agent-2' }],
      [],
    );

    expect(summary.count).toBe(2);
    expect(summary.progress).toBe('doing work');
  });

  test('keeps WRFC owner counted while a child is still active', () => {
    const summary = summarizeRunningAgents(
      [{ id: 'engineer-1', progress: 'reviewing implementation' }],
      [],
      [{
        state: 'reviewing',
        ownerAgentId: 'owner-1',
        engineerAgentId: 'engineer-1',
        allAgentIds: ['owner-1', 'engineer-1'],
      }],
    );

    expect(summary.count).toBe(2);
  });

  test('ignores terminal WRFC chains', () => {
    const summary = summarizeRunningAgents(
      [{ id: 'engineer-1' }],
      [],
      [{
        state: 'passed',
        ownerAgentId: 'owner-1',
        engineerAgentId: 'engineer-1',
      }],
    );

    expect(summary.count).toBe(1);
  });

  test('uses WRFC chain progress when child work has no progress text', () => {
    const summary = summarizeRunningAgents(
      [{ id: 'reviewer-1' }],
      [],
      [{
        state: 'fixing',
        ownerAgentId: 'owner-1',
        reviewerAgentId: 'reviewer-1',
      }],
    );

    expect(summary.progress).toBe('WRFC chain fixing');
  });
});
