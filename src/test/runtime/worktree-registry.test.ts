import { describe, expect, test } from 'bun:test';
import { summarizeWorktreeOwnership, type ManagedWorktreeMeta } from '@/runtime/index.ts';

describe('runtime/worktree/registry', () => {
  test('summarizes ownership and lifecycle posture', () => {
    const records: ManagedWorktreeMeta[] = [
      {
        path: '/tmp/agent-a',
        kind: 'agent',
        state: 'active',
        ownerId: 'agent-a',
        sessionId: 'sess-1',
        taskId: 'task-1',
        updatedAt: 1,
      },
      {
        path: '/tmp/orchestrator',
        kind: 'orchestrator',
        state: 'paused',
        sessionId: 'sess-1',
        updatedAt: 2,
      },
      {
        path: '/tmp/manual',
        kind: 'manual',
        state: 'kept',
        updatedAt: 3,
      },
      {
        path: '/tmp/discard',
        kind: 'agent',
        state: 'discard',
        ownerId: 'agent-b',
        taskId: 'task-2',
        updatedAt: 4,
      },
    ];

    const summary = summarizeWorktreeOwnership(records);
    expect(summary.total).toBe(4);
    expect(summary.active).toBe(1);
    expect(summary.paused).toBe(1);
    expect(summary.kept).toBe(1);
    expect(summary.discard).toBe(1);
    expect(summary.sessionAttached).toBe(2);
    expect(summary.taskAttached).toBe(2);
    expect(summary.agentOwned).toBe(2);
    expect(summary.orchestratorOwned).toBe(1);
    expect(summary.manualOwned).toBe(1);
  });
});
