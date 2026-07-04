import { describe, expect, test } from 'bun:test';
import type { PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import {
  applyHunkKey,
  buildHunkSelectionState,
  buildModifiedEditArgs,
  isHunkSelectable,
  type HunkSelectionState,
} from '../../permissions/hunk-selection.ts';

function makeRequest(tool: string, args: Record<string, unknown>): PermissionPromptRequest {
  return {
    callId: 'call-1',
    tool,
    args,
    category: 'write',
    analysis: {
      classification: 'write',
      riskLevel: 'medium',
      summary: 'test',
      reasons: [],
    },
  };
}

const threeEdits = [
  { path: 'a.ts', find: 'one', replace: 'ONE' },
  { path: 'a.ts', find: 'two', replace: 'TWO' },
  { path: 'b.ts', find: 'three', replace: 'THREE' },
];

describe('isHunkSelectable', () => {
  test('true for an edit call with 2+ edits', () => {
    expect(isHunkSelectable(makeRequest('edit', { edits: threeEdits }))).toBe(true);
  });

  test('false for an edit call with exactly 1 edit', () => {
    expect(isHunkSelectable(makeRequest('edit', { edits: [threeEdits[0]] }))).toBe(false);
  });

  test('false for a write call', () => {
    expect(isHunkSelectable(makeRequest('write', { files: [{ path: 'a.ts', content: 'x' }] }))).toBe(false);
  });

  test('false for exec/read/other tools', () => {
    expect(isHunkSelectable(makeRequest('exec', { command: 'ls' }))).toBe(false);
    expect(isHunkSelectable(makeRequest('read', { path: 'a.ts' }))).toBe(false);
    expect(isHunkSelectable(makeRequest('agent', { task: 'x' }))).toBe(false);
  });

  test('false when edits is missing or malformed', () => {
    expect(isHunkSelectable(makeRequest('edit', {}))).toBe(false);
    expect(isHunkSelectable(makeRequest('edit', { edits: 'not-an-array' }))).toBe(false);
    expect(isHunkSelectable(makeRequest('edit', { edits: [{ path: 'a.ts' }, { path: 'b.ts' }] }))).toBe(false);
  });
});

describe('buildHunkSelectionState', () => {
  test('all hunks selected by default, cursor at 0', () => {
    const state = buildHunkSelectionState(makeRequest('edit', { edits: threeEdits }));
    expect(state.hunks).toHaveLength(3);
    expect(state.cursor).toBe(0);
    expect(state.selected.size).toBe(3);
    expect([...state.selected].sort()).toEqual([0, 1, 2]);
  });
});

describe('applyHunkKey reducer', () => {
  function makeState(n: number): HunkSelectionState {
    return {
      hunks: threeEdits.slice(0, n),
      cursor: 0,
      selected: new Set(Array.from({ length: n }, (_, i) => i)),
    };
  }

  test('j/down moves cursor forward, clamped at the end', () => {
    let state = makeState(3);
    ({ state } = applyHunkKey(state, 'j'));
    expect(state.cursor).toBe(1);
    ({ state } = applyHunkKey(state, 'j'));
    expect(state.cursor).toBe(2);
    ({ state } = applyHunkKey(state, 'j'));
    expect(state.cursor).toBe(2); // clamped
  });

  test('k/up moves cursor backward, clamped at 0', () => {
    let state = { ...makeState(3), cursor: 1 };
    ({ state } = applyHunkKey(state, 'k'));
    expect(state.cursor).toBe(0);
    ({ state } = applyHunkKey(state, 'k'));
    expect(state.cursor).toBe(0); // clamped
  });

  test('arrow-key escape sequences behave the same as j/k', () => {
    let state = makeState(3);
    ({ state } = applyHunkKey(state, '\x1b[B'));
    expect(state.cursor).toBe(1);
    ({ state } = applyHunkKey(state, '\x1b[A'));
    expect(state.cursor).toBe(0);
  });

  test('space toggles only the cursor row', () => {
    let state = makeState(3);
    ({ state } = applyHunkKey(state, ' '));
    expect(state.selected.has(0)).toBe(false);
    expect(state.selected.has(1)).toBe(true);
    expect(state.selected.has(2)).toBe(true);
    ({ state } = applyHunkKey(state, ' '));
    expect(state.selected.has(0)).toBe(true);
  });

  test('a re-selects all after a prior deselect', () => {
    let state = makeState(3);
    ({ state } = applyHunkKey(state, ' ')); // deselect hunk 0
    expect(state.selected.size).toBe(2);
    ({ state } = applyHunkKey(state, 'a'));
    expect(state.selected.size).toBe(3);
  });

  test('enter with nothing selected is a no-op — does not commit', () => {
    const state: HunkSelectionState = { ...makeState(3), selected: new Set() };
    const result = applyHunkKey(state, '\r');
    expect(result.commit).toBeNull();
    expect(result.state).toBe(state); // unchanged, prompt stays open
  });

  test('enter with a selection commits apply', () => {
    const state = makeState(3);
    const result = applyHunkKey(state, '\r');
    expect(result.commit).toBe('apply');
  });

  test('y commits apply-all regardless of prior toggles', () => {
    const state = makeState(3);
    const result = applyHunkKey({ ...state, selected: new Set([1]) }, 'y');
    expect(result.commit).toBe('apply');
    expect(result.state.selected.size).toBe(3);
  });

  test('n/esc/ctrl-c commit cancel', () => {
    const state = makeState(3);
    expect(applyHunkKey(state, 'n').commit).toBe('cancel');
    expect(applyHunkKey(state, '\x1b').commit).toBe('cancel');
    expect(applyHunkKey(state, '\x03').commit).toBe('cancel');
  });
});

describe('buildModifiedEditArgs', () => {
  test('filters edits to exactly the selected indices in original order', () => {
    const request = makeRequest('edit', {
      edits: threeEdits,
      match: { mode: 'exact' },
      transaction: { mode: 'atomic' },
      output: { format: 'minimal' },
      dry_run: false,
      validate: { after: ['typecheck'] },
    });
    const state: HunkSelectionState = {
      hunks: threeEdits,
      cursor: 0,
      selected: new Set([0, 2]),
    };

    const result = buildModifiedEditArgs(request, state);

    expect(result['edits']).toEqual([threeEdits[0], threeEdits[2]]);
    // All other EditInput fields preserved unchanged.
    expect(result['match']).toEqual({ mode: 'exact' });
    expect(result['transaction']).toEqual({ mode: 'atomic' });
    expect(result['output']).toEqual({ format: 'minimal' });
    expect(result['dry_run']).toBe(false);
    expect(result['validate']).toEqual({ after: ['typecheck'] });
  });
});
