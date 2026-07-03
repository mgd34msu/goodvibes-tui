import { describe, expect, test } from 'bun:test';
import { createOverlayBoxLayout, createOverlayBorderLine } from '../../renderer/overlay-box.ts';

describe('createOverlayBoxLayout', () => {
  test('normal terminal widths are unaffected by the hostile-size clamp', () => {
    // 100-wide terminal, 4-col margin, 72-col requested max — well above the
    // 20-column floor, so the clamp should never engage here.
    const layout = createOverlayBoxLayout(100, 4, 72);
    expect(layout.width).toBe(72);
    expect(layout.contentWidth).toBe(70);
    expect(layout.innerWidth).toBe(68);
  });

  test('clamps the box width to what actually fits on a hostile-narrow terminal', () => {
    // terminalWidth=20, margin=4: available space is 20 - 4*2 = 12 columns,
    // well under the 20-column floor. The box must never claim more width
    // than the terminal actually has.
    const layout = createOverlayBoxLayout(20, 4, 72);
    expect(layout.width).toBeLessThanOrEqual(20 - 4 * 2);
    expect(layout.width).toBe(12);
  });

  test('a border line built from the clamped layout never writes past the terminal width', () => {
    const terminalWidth = 20;
    const margin = 4;
    const layout = createOverlayBoxLayout(terminalWidth, margin, 72);
    const line = createOverlayBorderLine(terminalWidth, layout, '┌', '─', '┐');
    // The border line must stay exactly at the declared terminal width — a
    // pre-fix box width wider than the terminal walks the right border cell
    // off the end of the array, silently growing the line.
    expect(line.length).toBe(terminalWidth);
  });
});
