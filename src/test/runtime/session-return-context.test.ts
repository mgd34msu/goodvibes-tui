import { describe, expect, test } from 'bun:test';
import { buildLocalReturnContextSummary, formatReturnContextForDisplay } from '@/runtime/index.ts';

describe('runtime/session-return-context', () => {
  test('builds deterministic summary from message flow', () => {
    const summary = buildLocalReturnContextSummary([
      { role: 'user', content: 'Please inspect the failing build.' },
      { role: 'assistant', content: 'I am checking the repo.', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: {} }] },
      { role: 'tool', callId: 'call-1', content: 'tsc failed in src/main.ts' },
      { role: 'assistant', content: 'The error is in src/main.ts.' },
    ], {
      pendingApprovals: 2,
      activeTasks: 3,
      blockedTasks: 1,
      remoteContracts: 2,
      remoteRunners: ['runner-a', 'runner-b'],
      worktreeCount: 1,
      worktreePaths: ['/tmp/wt-a'],
      openPanels: ['remote', 'approval'],
    });

    expect(summary.activityLabel).toBe('assistant replied');
    expect(summary.statusLabel).toBe('ready for next turn');
    expect(summary.userTurnCount).toBe(1);
    expect(summary.assistantTurnCount).toBe(2);
    expect(summary.toolCallCount).toBe(1);
    expect(summary.toolResultCount).toBe(1);
    expect(summary.pendingApprovals).toBe(2);
    expect(summary.activeTasks).toBe(3);
    expect(summary.remoteRunners).toEqual(['runner-a', 'runner-b']);
    expect(summary.worktreePaths).toEqual(['/tmp/wt-a']);
    expect(summary.lines.some((line) => line.includes('Tasks: active 3, blocked 1'))).toBe(true);
    expect(summary.lines.some((line) => line.includes('Remote runners: runner-a, runner-b'))).toBe(true);
    expect(summary.lines.some((line) => line.includes('Worktree paths: /tmp/wt-a'))).toBe(true);
    expect(summary.lines.some((line) => line.includes('Open panels: remote, approval'))).toBe(true);
    expect(summary.lines[0]).toContain('Activity');
  });

  test('display formatting prepends assisted narrative when present', () => {
    const lines = formatReturnContextForDisplay({
      activityLabel: 'assistant replied',
      statusLabel: 'ready for next turn',
      pendingApprovals: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      assistantTurnCount: 1,
      userTurnCount: 1,
      lines: ['Activity: assistant replied', 'Status: ready for next turn'],
      assistedNarrative: 'Look at the most recent assistant reply first.',
    });

    expect(lines[0]).toContain('Assist:');
    expect(lines[1]).toContain('Activity:');
  });
});
