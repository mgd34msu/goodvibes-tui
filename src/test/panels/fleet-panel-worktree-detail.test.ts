// ---------------------------------------------------------------------------
// fleet-panel-worktree-detail.test.ts
//
// Pure unit tests for the Fleet panel's per-work-item worktree-isolation
// detail text (extracted from fleet-panel.ts to stay under the architecture
// check's 800-line cap — see that module's header doc).
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { WorkItem } from '@pellux/goodvibes-sdk/platform/orchestration';
import {
  formatWorkItemIsolationDetail,
  formatWorkItemIsolationDetailFromRaw,
} from '../../panels/fleet-panel-worktree-detail.ts';

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item-1',
    title: 'do the work',
    task: 'do the work',
    currentPhaseId: null,
    state: 'passed',
    allAgentIds: [],
    visits: new Map(),
    touchedPaths: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' },
    transportRetryCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('formatWorkItemIsolationDetail', () => {
  test('a shared-isolation item (no worktree fields at all) is null', () => {
    expect(formatWorkItemIsolationDetail(makeItem())).toBeNull();
  });

  test('merged with a hash shows a truncated hash', () => {
    const item = makeItem({ worktreePath: undefined, mergeState: 'merged', mergeHash: 'abcdef1234567890' });
    expect(formatWorkItemIsolationDetail(item)).toBe('worktree — merged abcdef123456');
  });

  test('merged with no hash (the "empty" integration no-op) reads honestly', () => {
    const item = makeItem({ mergeState: 'merged', mergeHash: undefined });
    expect(formatWorkItemIsolationDetail(item)).toBe('worktree — merged (no changes)');
  });

  test('conflict names the kept worktree', () => {
    const item = makeItem({ mergeState: 'conflict', worktreeKept: true });
    expect(formatWorkItemIsolationDetail(item)).toBe('worktree — merge-conflict (kept for inspection)');
  });

  test('pending (still in the integration lane)', () => {
    const item = makeItem({ mergeState: 'pending' });
    expect(formatWorkItemIsolationDetail(item)).toBe('worktree — merge pending');
  });

  test('a worktree-mode item that has not entered the lane yet (mergeState absent, path present) reads "not yet integrated"', () => {
    const item = makeItem({ worktreePath: '/repo/.goodvibes/.worktrees/ws/a/b', worktreeBranch: 'ws/a/b' });
    expect(formatWorkItemIsolationDetail(item)).toBe('worktree — not yet integrated');
  });

  test('a fail/kill-kept worktree with no mergeState reads "kept"', () => {
    const item = makeItem({ worktreePath: '/repo/.goodvibes/.worktrees/ws/a/b', worktreeKept: true, state: 'failed' });
    expect(formatWorkItemIsolationDetail(item)).toBe('worktree — kept');
  });
});

describe('formatWorkItemIsolationDetailFromRaw', () => {
  test('narrows ProcessNode.raw = { item, workstreamId } exactly like adaptWorkItem produces it', () => {
    const item = makeItem({ mergeState: 'merged', mergeHash: 'deadbeef00001111' });
    expect(formatWorkItemIsolationDetailFromRaw({ item, workstreamId: 'ws-1' })).toBe('worktree — merged deadbeef0000');
  });

  test('undefined/foreign raw shapes degrade to null rather than throwing', () => {
    expect(formatWorkItemIsolationDetailFromRaw(undefined)).toBeNull();
    expect(formatWorkItemIsolationDetailFromRaw({})).toBeNull();
    expect(formatWorkItemIsolationDetailFromRaw('not an object')).toBeNull();
  });
});
