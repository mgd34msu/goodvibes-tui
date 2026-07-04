/**
 * PermissionPromptUI.getPromptHeight(request, hunkState) must equal the
 * actual number of Line rows PermissionPromptUI.createPromptLines(width,
 * request, hunkState) returns — main.ts's render loop reserves viewport
 * space from getPromptHeight *before* the real render happens (see
 * src/main.ts's overlayRows computation), so any drift between the two
 * clips or misplaces the conversation viewport. This is the single
 * highest-value regression test for the W1.3 hunk-selection feature
 * (Risk 2 in the work order brief).
 */
import { describe, expect, test } from 'bun:test';
import { PermissionPromptUI, type PermissionPromptRequest } from '../../permissions/prompt.ts';
import { analyzePermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { HunkSelectionState } from '../../permissions/hunk-selection.ts';

const WIDTH = 80;

function makeRequest(editCount: number): PermissionPromptRequest & { resolve: (approved: boolean) => void } {
  const edits = Array.from({ length: editCount }, (_, i) => ({
    path: `file${i}.ts`,
    find: `needle${i}`,
    replace: `replacement${i}`,
  }));
  return {
    callId: 'parity-test',
    tool: 'edit',
    args: { edits },
    category: 'write',
    analysis: analyzePermissionRequest('edit', { edits }, 'write'),
    resolve: (_approved: boolean) => {},
  };
}

function makeHunkState(count: number, cursor = 0): HunkSelectionState {
  return {
    hunks: Array.from({ length: count }, (_, i) => ({
      path: `file${i}.ts`,
      find: `needle${i}`,
      replace: `replacement${i}`,
    })),
    cursor,
    selected: new Set(Array.from({ length: count }, (_, i) => i)),
  };
}

describe('PermissionPromptUI.getPromptHeight / createPromptLines parity', () => {
  test('non-hunk-mode baseline (hunkState omitted): height matches exactly, unaffected by this feature', () => {
    const request = makeRequest(0);
    const height = PermissionPromptUI.getPromptHeight(request);
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request);
    expect(lines.length).toBe(height);
  });

  for (const hunkCount of [1, 3, 8, 20]) {
    test(`hunk-mode with ${hunkCount} hunks: height matches exactly`, () => {
      const request = makeRequest(hunkCount);
      const hunkState = makeHunkState(hunkCount);
      const height = PermissionPromptUI.getPromptHeight(request, hunkState);
      const lines = PermissionPromptUI.createPromptLines(WIDTH, request, hunkState);
      expect(lines.length).toBe(height);
    });
  }

  test('cursor position does not change the row count', () => {
    const request = makeRequest(8);
    const hunkState = makeHunkState(8, 5);
    const height = PermissionPromptUI.getPromptHeight(request, hunkState);
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request, hunkState);
    expect(lines.length).toBe(height);
  });

  test('partial selection does not change the row count', () => {
    const request = makeRequest(5);
    const hunkState: HunkSelectionState = { ...makeHunkState(5), selected: new Set([0, 2]) };
    const height = PermissionPromptUI.getPromptHeight(request, hunkState);
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request, hunkState);
    expect(lines.length).toBe(height);
  });
});
