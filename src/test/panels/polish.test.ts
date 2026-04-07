import { describe, expect, test } from 'bun:test';
import { buildPanelLine, buildPanelWorkspace, buildSectionHeader, DEFAULT_PANEL_PALETTE } from '../../panels/polish.ts';

describe('panel polish primitives', () => {
  test('buildPanelLine preserves exact width with wide characters', () => {
    const line = buildPanelLine(30, [
      [' 界🙂 ', DEFAULT_PANEL_PALETTE.info],
      ['status', DEFAULT_PANEL_PALETTE.value],
    ]);
    expect(line).toHaveLength(30);
  });

  test('buildSectionHeader preserves exact width with wide characters', () => {
    const line = buildSectionHeader(32, '状态 Overview', DEFAULT_PANEL_PALETTE);
    expect(line).toHaveLength(32);
  });

  test('buildPanelWorkspace keeps footer lines docked at the bottom', () => {
    const footer = buildPanelLine(32, [[' footer', DEFAULT_PANEL_PALETTE.dim]]);
    const lines = buildPanelWorkspace(32, 8, {
      title: 'Workspace',
      sections: [{
        title: 'Body',
        lines: [buildPanelLine(32, [[' row', DEFAULT_PANEL_PALETTE.value]])],
      }],
      footerLines: [footer],
      palette: DEFAULT_PANEL_PALETTE,
    });
    const lastRow = lines.at(-1)?.map((cell) => cell.char).join('') ?? '';
    expect(lastRow).toContain('footer');
  });
});
