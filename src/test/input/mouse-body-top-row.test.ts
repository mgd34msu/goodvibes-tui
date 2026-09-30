// A click maps to transcript rows from the row after the header block: the
// header, the session chips row when it shows, and the empty row under them
// on the main screen (main.ts sets bodyTopRow each frame).

import { describe, expect, test } from 'bun:test';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import { handleMouseToken, type MouseRouteState } from '../../input/handler-feed-routes.ts';

function state(bodyTopRow: number, starts: number[]): MouseRouteState {
  return {
    conversationManager: null,
    selection: { startSelection: (_col: number, row: number) => { starts.push(row); } } as unknown as MouseRouteState['selection'],
    mouseDownRow: -1, mouseDownCol: -1, scrollTop: 0, viewportHeight: 20, lineCount: 100,
    scroll: () => {}, requestRender: () => {}, handlePaste: () => {}, handleCopy: () => {},
    bodyTopRow: () => bodyTopRow,
  };
}

const press = (row: number): InputToken => ({ type: 'mouse', button: 0, action: 'press', row, col: 10 } as unknown as InputToken);

describe('mouse rows under the header block', () => {
  test('main screen: the header and its gap row sit above the first transcript row', () => {
    const starts: number[] = [];
    handleMouseToken(state(2, starts), press(3)); // 1-based: row 3 is the first transcript row
    expect(starts).toEqual([0]);
  });

  test('main screen with the session chips: header, chips, gap', () => {
    const starts: number[] = [];
    handleMouseToken(state(3, starts), press(4));
    expect(starts).toEqual([0]);
  });

  test('the wheel scrolls the transcript whatever the header block', () => {
    const deltas: number[] = [];
    const s = { ...state(3, []), scroll: (d: number) => { deltas.push(d); } };
    handleMouseToken(s, { type: 'mouse', button: 64, action: 'press', row: 5, col: 5 } as unknown as InputToken);
    handleMouseToken(s, { type: 'mouse', button: 65, action: 'press', row: 5, col: 5 } as unknown as InputToken);
    expect(deltas).toEqual([-3, 3]);
  });
});
