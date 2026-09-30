import { describe, expect, test } from 'bun:test';
import {
  buildDetailBlock,
  buildViewLine,
  buildViewListRow,
  buildViewWorkspace,
  buildSectionHeader,
  DEFAULT_VIEW_PALETTE,
} from '../../views/polish.ts';

describe('view polish primitives', () => {
  test('buildViewLine preserves exact width with wide characters', () => {
    const line = buildViewLine(30, [
      [' 界🙂 ', DEFAULT_VIEW_PALETTE.info],
      ['status', DEFAULT_VIEW_PALETTE.value],
    ]);
    expect(line).toHaveLength(30);
  });

  test('buildSectionHeader preserves exact width with wide characters', () => {
    const line = buildSectionHeader(32, '状态 Overview', DEFAULT_VIEW_PALETTE);
    expect(line).toHaveLength(32);
  });

  test('buildViewListRow renders a selected marker and fill background', () => {
    const line = buildViewListRow(24, [
      { text: 'Remote', fg: DEFAULT_VIEW_PALETTE.value },
    ], DEFAULT_VIEW_PALETTE, { selected: true });
    expect(line[0]?.char).toBe('▸');
    expect(line[0]?.bg).toBe(DEFAULT_VIEW_PALETTE.selectBg);
    expect(line[3]?.bg).toBe(DEFAULT_VIEW_PALETTE.selectBg);
  });

  test('buildDetailBlock lifts rows onto the shared surface background', () => {
    const block = buildDetailBlock(24, 'Selected', [
      buildViewLine(24, [[' detail row', DEFAULT_VIEW_PALETTE.value]]),
    ], DEFAULT_VIEW_PALETTE);
    expect(block).toHaveLength(2);
    expect(block[1]?.[0]?.bg).toBe(DEFAULT_VIEW_PALETTE.surfaceBg);
  });

  test('buildViewWorkspace keeps footer lines docked at the bottom', () => {
    const footer = buildViewLine(32, [[' footer', DEFAULT_VIEW_PALETTE.dim]]);
    const lines = buildViewWorkspace(32, 8, {
      title: 'Workspace',
      sections: [{
        title: 'Body',
        lines: [buildViewLine(32, [[' row', DEFAULT_VIEW_PALETTE.value]])],
      }],
      footerLines: [footer],
      palette: DEFAULT_VIEW_PALETTE,
    });
    const lastRow = lines.at(-1)?.map((cell) => cell.char).join('') ?? '';
    expect(lastRow).toContain('footer');
  });
});
