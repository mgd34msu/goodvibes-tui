// ---------------------------------------------------------------------------
// scrollable-window-summary-budget.test.ts
//
// Reproduces the row-budget defect: resolveScrollablePanelSection appended its
// "showing X-Y of Z" window-summary row AFTER the row-budget calculation, so a
// panel with a budget-truncated list plus a multi-line footer would silently
// drop its last footer line (typically the keyboard-hints row).
//
// The render contract requires EXACTLY `height` lines with the footer intact.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import type { Line } from '../../types/grid.ts';
import { createEmptyLine } from '../../types/grid.ts';
import { ScrollableListPanel } from '../../panels/scrollable-list-panel.ts';
import {
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolveStackedScrollableSections,
} from '../../panels/polish.ts';

function lineText(line: Line): string {
  return line.map((cell) => cell.char).join('').replace(/\s+$/, '');
}

const FOOTER_DETAIL = 'DETAIL-ROW-MARKER';
const HINTS_MARKER = 'HINTS-ROW-MARKER';

class FooteredListPanel extends ScrollableListPanel<string> {
  private _items: string[];

  constructor(count: number) {
    super('footered', 'Footered', 'F', 'monitoring');
    this._items = Array.from({ length: count }, (_, i) => `item-${i}`);
  }

  protected getItems(): readonly string[] {
    return this._items;
  }

  protected renderItem(item: string, _index: number, _selected: boolean, width: number): Line {
    const line = createEmptyLine(width);
    for (let i = 0; i < item.length && i < width; i++) {
      line[i] = { char: item[i]!, fg: '#fff', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    }
    return line;
  }

  public render(width: number, height: number): Line[] {
    const palette = this.getPalette();
    // A two-line footer: a detail row plus a keyboard-hints row at the very tail.
    const footer: Line[] = [
      buildPanelLine(width, [[` ${FOOTER_DETAIL}`, palette.dim]]),
    ];
    const hints = [{ keys: HINTS_MARKER, label: 'help' }];
    return this.renderList(width, height, { footer, hints });
  }
}

describe('resolveScrollablePanelSection — window-summary row stays inside the budget', () => {
  const WIDTH = 40;
  const HEIGHT = 12;

  test('truncated list + multi-line footer keeps the tail hints row', () => {
    const panel = new FooteredListPanel(40); // far more than fits at HEIGHT=12
    const lines = panel.render(WIDTH, HEIGHT);

    // Contract: exactly HEIGHT lines.
    expect(lines.length).toBe(HEIGHT);

    const texts = lines.map(lineText);

    // The window is truncated, so a summary row must be present...
    expect(texts.some((t) => /showing \d+-\d+ of \d+/.test(t))).toBe(true);

    // ...AND the footer must survive intact: both the detail row and the
    // tail keyboard-hints row must still be rendered.
    expect(texts.some((t) => t.includes(FOOTER_DETAIL))).toBe(true);
    expect(texts.some((t) => t.includes(HINTS_MARKER))).toBe(true);

    // The hints row is the last non-empty line of the frame.
    const lastNonEmptyIdx = [...texts].map((t, i) => [t, i] as const)
      .filter(([t]) => t.length > 0)
      .map(([, i]) => i)
      .pop();
    expect(lastNonEmptyIdx).toBeDefined();
    expect(texts[lastNonEmptyIdx!]).toContain(HINTS_MARKER);
  });
});

describe('resolveStackedScrollableSections — per-section summaries stay inside the stack budget', () => {
  const WIDTH = 40;
  const HEIGHT = 14;
  const C = DEFAULT_PANEL_PALETTE;

  test('two truncated sections + footer keep the tail hints row', () => {
    const mkLines = (label: string, count: number): Line[] =>
      Array.from({ length: count }, (_, i) => buildPanelLine(WIDTH, [[` ${label}-${i}`, C.value]]));

    // Mirrors the sandbox-panel wiring: stacked sections resolved with the
    // footer declared, then the same footer passed to buildPanelWorkspace.
    const footer: Line[] = [buildPanelLine(WIDTH, [[` ${HINTS_MARKER}`, C.dim]])];
    const resolved = resolveStackedScrollableSections(WIDTH, HEIGHT, {
      palette: C,
      footerLines: footer,
      sections: [
        { title: 'Alpha', scrollableLines: mkLines('alpha', 30), scrollOffset: 0, minRows: 2, appendWindowSummary: { dimColor: C.dim } },
        { title: 'Beta', scrollableLines: mkLines('beta', 30), scrollOffset: 0, minRows: 2, appendWindowSummary: { dimColor: C.dim } },
      ],
    });

    const lines = buildPanelWorkspace(WIDTH, HEIGHT, {
      title: 'Stacked',
      sections: resolved.map((entry) => entry.section),
      footerLines: footer,
      palette: C,
    });

    // Contract: exactly HEIGHT lines.
    expect(lines.length).toBe(HEIGHT);
    const texts = lines.map(lineText);

    // Both sections are truncated, so both summary rows must be present...
    expect(texts.filter((t) => /showing \d+-\d+ of \d+/.test(t)).length).toBe(2);

    // ...AND the tail keyboard-hints row must survive as the last non-empty line.
    const lastNonEmptyIdx = [...texts].map((t, i) => [t, i] as const)
      .filter(([t]) => t.length > 0)
      .map(([, i]) => i)
      .pop();
    expect(lastNonEmptyIdx).toBeDefined();
    expect(texts[lastNonEmptyIdx!]).toContain(HINTS_MARKER);
  });
});
