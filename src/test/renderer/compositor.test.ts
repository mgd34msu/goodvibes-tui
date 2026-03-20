import { describe, test, expect, beforeEach } from 'bun:test';
import { Compositor } from '../../renderer/compositor.ts';
import { createStyledCell, createEmptyLine } from '../../types/grid.ts';
import type { Line, Cell } from '../../types/grid.ts';
import type { CompositeRequest, PanelCompositeData, SelectionInfo } from '../../renderer/compositor.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal mock WriteStream — records all writes. */
function makeMockStream() {
  const writes: string[] = [];
  const stream = {
    write: (data: string) => { writes.push(data); return true; },
    writes,
  };
  return stream as unknown as NodeJS.WriteStream & { writes: string[] };
}

function makeCompositor() {
  const stream = makeMockStream() as NodeJS.WriteStream & { writes: string[] };
  const compositor = new Compositor(stream as NodeJS.WriteStream);
  return { compositor, stream };
}

/** Create a Line filled with a repeating character. */
function makeLine(width: number, char = ' '): Line {
  return Array.from({ length: width }, () => createStyledCell(char));
}

/** Stamp a visible character at a specific column within a line. */
function stampChar(line: Line, col: number, char: string): void {
  if (col >= 0 && col < line.length) {
    line[col] = createStyledCell(char);
  }
}

/** Read char at (x, y) from the compositor's last buffer. */
function cellAt(compositor: Compositor, x: number, y: number): Cell | undefined {
  return compositor.lastBufferForTest?.getCell(x, y);
}

// ---------------------------------------------------------------------------
// Common dimensions
// ---------------------------------------------------------------------------

const WIDTH = 40;
const HEIGHT = 10;
const PANEL_WIDTH = 15;
// leftWidth = 40 - 15 - 1 = 24, sepX = 24

function makeBaseRequest(overrides: Partial<CompositeRequest> = {}): CompositeRequest {
  return {
    width: WIDTH,
    height: HEIGHT,
    header: [makeLine(WIDTH, 'H'), makeLine(WIDTH, 'H')],  // rows 0-1
    viewport: Array.from({ length: 6 }, () => makeLine(WIDTH, '.')),  // rows 2-7
    footer: [makeLine(WIDTH, 'F'), makeLine(WIDTH, 'F')],  // rows 8-9
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Compositor — no panel', () => {
  test('produces output (stdout.write called)', () => {
    const { compositor, stream } = makeCompositor();
    compositor.composite(makeBaseRequest());
    expect(stream.writes.length).toBeGreaterThan(0);
  });

  test('renders viewport lines via full-width blit (no panel fast path)', () => {
    const { compositor } = makeCompositor();
    const viewport = Array.from({ length: 6 }, () => makeLine(WIDTH, '.'));
    // Stamp a recognisable character at col 30 on viewport row 0 (screen row 2)
    stampChar(viewport[0], 30, 'X');
    compositor.composite(makeBaseRequest({ viewport }));
    // Without a panel, the full line is blitted — col 30 on screen row 2 should be 'X'
    expect(cellAt(compositor, 30, 2)?.char).toBe('X');
  });

  test('tab bar is on screen row 2 when no panel (header=2 rows)', () => {
    const { compositor } = makeCompositor();
    const header = [makeLine(WIDTH, 'A'), makeLine(WIDTH, 'B')];
    compositor.composite(makeBaseRequest({ header }));
    expect(cellAt(compositor, 0, 0)?.char).toBe('A');
    expect(cellAt(compositor, 0, 1)?.char).toBe('B');
  });
});

describe('Compositor — with panel', () => {
  function makePanelData(): PanelCompositeData {
    const tabBar = makeLine(PANEL_WIDTH, 'T');
    const content = Array.from({ length: 5 }, () => makeLine(PANEL_WIDTH, 'P'));
    return { tabBar, content, separator: true };
  }

  test('separator drawn at correct column (sepX = leftWidth)', () => {
    const { compositor } = makeCompositor();
    const panel = makePanelData();
    compositor.composite(makeBaseRequest({ panel, panelWidth: PANEL_WIDTH }));
    // leftWidth = 40 - 15 - 1 = 24; separator at col 24
    const sepX = WIDTH - PANEL_WIDTH - 1; // = 24
    // Check separator on screen row 2 (first viewport row)
    expect(cellAt(compositor, sepX, 2)?.char).toBe('│');
  });

  test('panel tab bar renders at viewport row 0 (screen row 2)', () => {
    const { compositor } = makeCompositor();
    const panel = makePanelData();
    // Stamp distinct char on tabBar col 0
    panel.tabBar[0] = createStyledCell('T');
    compositor.composite(makeBaseRequest({ panel, panelWidth: PANEL_WIDTH }));
    const panelStartX = (WIDTH - PANEL_WIDTH - 1) + 1; // = 25
    expect(cellAt(compositor, panelStartX, 2)?.char).toBe('T');
  });

  test('panel content renders at viewport rows 1+ (screen rows 3+)', () => {
    const { compositor } = makeCompositor();
    const panel = makePanelData();
    // Stamp distinct char on content[0] col 0
    panel.content[0][0] = createStyledCell('C');
    compositor.composite(makeBaseRequest({ panel, panelWidth: PANEL_WIDTH }));
    const panelStartX = (WIDTH - PANEL_WIDTH - 1) + 1; // = 25
    // viewport row 1 → screen row 3 → content[0]
    expect(cellAt(compositor, panelStartX, 3)?.char).toBe('C');
  });

  test('left viewport cells stay within leftWidth (panel chars not overwritten)', () => {
    const { compositor } = makeCompositor();
    const panel = makePanelData();
    const viewport = Array.from({ length: 6 }, () => makeLine(WIDTH, '.'));
    compositor.composite(makeBaseRequest({ panel, panelWidth: PANEL_WIDTH, viewport }));
    // Left side: cols 0..leftWidth-1 = 0..23 should be '.'
    const leftWidth = WIDTH - PANEL_WIDTH - 1; // = 24
    expect(cellAt(compositor, 0, 2)?.char).toBe('.');
    expect(cellAt(compositor, leftWidth - 1, 2)?.char).toBe('.');
    // Panel area should be 'T' (tabBar char) at panelStartX on screen row 2
    const panelStartX = leftWidth + 1;
    expect(cellAt(compositor, panelStartX, 2)?.char).toBe('T');
  });
});

describe('Compositor — degenerate panelWidth >= width', () => {
  test('leftWidth clamped to 1 when panelWidth >= width - 1', () => {
    const { compositor } = makeCompositor();
    // panelWidth = width - 1 → leftWidth would be -1 without clamp, clamped to 1
    const hugePanel: PanelCompositeData = {
      tabBar: makeLine(WIDTH - 1, 'T'),
      content: Array.from({ length: 6 }, () => makeLine(WIDTH - 1, 'P')),
      separator: false,
    };
    // Should not throw
    expect(() => {
      compositor.composite(makeBaseRequest({ panel: hugePanel, panelWidth: WIDTH - 1 }));
    }).not.toThrow();
    // leftWidth = max(1, 40 - 39 - 1) = max(1, 0) = 1
    // Viewport cell at col 0 should exist
    expect(cellAt(compositor, 0, 2)).toBeDefined();
  });

  test('selection overlay constrained to clamped leftWidth', () => {
    const { compositor } = makeCompositor();
    const panel: PanelCompositeData = {
      tabBar: makeLine(WIDTH, 'T'),
      content: Array.from({ length: 6 }, () => makeLine(WIDTH, 'P')),
      separator: false,
    };
    const selection: SelectionInfo = {
      isCellSelected: (col, _row) => col === 0,
      scrollTop: 0,
      lineCount: 6,
    };
    // panelWidth = width - 2 → leftWidth = max(1, 40 - 38 - 1) = max(1, 1) = 1
    expect(() => {
      compositor.composite(makeBaseRequest({ panel, panelWidth: WIDTH - 2, selection }));
    }).not.toThrow();
    // Selection at col 0 should be applied (bg = '4')
    const cell = cellAt(compositor, 0, 2);
    expect(cell?.bg).toBe('4');
  });
});
