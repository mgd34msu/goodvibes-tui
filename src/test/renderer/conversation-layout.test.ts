import { describe, expect, test } from 'bun:test';
import { createStyledCell } from '../../types/grid.ts';
import { overlayViewportBottom, replaceViewportWithOverlay } from '../../renderer/conversation-layout.ts';

function makeLine(width: number, fill: string) {
  return Array.from({ length: width }, () => createStyledCell(fill, {}));
}

describe('conversation layout helpers', () => {
  test('overlayViewportBottom replaces the bottom rows and preserves rows above', () => {
    const width = 6;
    const viewport = [
      makeLine(width, 'A'),
      makeLine(width, 'B'),
      makeLine(width, 'C'),
      makeLine(width, 'D'),
    ];
    const overlay = [
      makeLine(width, 'X'),
      makeLine(width, 'Y'),
    ];

    const next = overlayViewportBottom(viewport, overlay, width, 4);
    expect(next).toHaveLength(4);
    expect(next[0][0]?.char).toBe('A');
    expect(next[1][0]?.char).toBe('B');
    expect(next[2][0]?.char).toBe('X');
    expect(next[3][0]?.char).toBe('Y');
  });

  test('overlayViewportBottom pads up to target start when viewport is short', () => {
    const width = 4;
    const viewport = [makeLine(width, 'A')];
    const overlay = [makeLine(width, 'X'), makeLine(width, 'Y')];

    const next = overlayViewportBottom(viewport, overlay, width, 5);
    expect(next).toHaveLength(5);
    expect(next[0][0]?.char).toBe('A');
    expect(next[3][0]?.char).toBe('X');
    expect(next[4][0]?.char).toBe('Y');
  });

  test('replaceViewportWithOverlay builds a full-height padded overlay surface', () => {
    const width = 5;
    const overlay = [makeLine(width, 'X'), makeLine(width, 'Y')];
    const next = replaceViewportWithOverlay(overlay, width, 4);
    expect(next).toHaveLength(4);
    expect(next[0][0]?.char).toBe(' ');
    expect(next[1][0]?.char).toBe(' ');
    expect(next[2][0]?.char).toBe('X');
    expect(next[3][0]?.char).toBe('Y');
  });
});
