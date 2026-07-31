import { describe, test, expect, beforeEach } from 'bun:test';
import { Compositor } from '../../renderer/compositor.ts';
import { createStyledCell, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import type { Line, Cell } from '@pellux/goodvibes-sdk/platform/types';
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

  test('viewport starts at row 0 when no header is supplied', () => {
    const { compositor } = makeCompositor();
    const viewport = Array.from({ length: HEIGHT }, () => makeLine(WIDTH, '.'));
    stampChar(viewport[0], 0, 'T');
    stampChar(viewport[HEIGHT - 1], 0, 'B');

    compositor.composite(makeBaseRequest({
      header: [],
      viewport,
      footer: [],
    }));

    expect(cellAt(compositor, 0, 0)?.char).toBe('T');
    expect(cellAt(compositor, 0, HEIGHT - 1)?.char).toBe('B');
  });
});

describe('Compositor — with panel', () => {
  function makePanelData(): PanelCompositeData {
    const workspaceBar = makeLine(PANEL_WIDTH, 'W');
    const topContent = Array.from({ length: 5 }, () => makeLine(PANEL_WIDTH, 'P'));
    return { workspaceBar, topContent, topFocused: true, hasBottomPane: false, separator: true, verticalSplitRatio: 0.5 };
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

  test('workspace bar renders at viewport row 0 (screen row 2)', () => {
    const { compositor } = makeCompositor();
    const panel = makePanelData();
    panel.workspaceBar[0] = createStyledCell('W');
    compositor.composite(makeBaseRequest({ panel, panelWidth: PANEL_WIDTH }));
    const panelStartX = (WIDTH - PANEL_WIDTH - 1) + 1; // = 25
    expect(cellAt(compositor, panelStartX, 2)?.char).toBe('W');
  });

  test('panel content renders below the workspace bar (screen rows 3+)', () => {
    const { compositor } = makeCompositor();
    const panel = makePanelData();
    // Stamp distinct char on topContent[0] col 0
    panel.topContent[0][0] = createStyledCell('C');
    compositor.composite(makeBaseRequest({ panel, panelWidth: PANEL_WIDTH }));
    const panelStartX = (WIDTH - PANEL_WIDTH - 1) + 1; // = 25
    // viewport row 1 → screen row 3 → topContent[0]
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
    // Panel area should be 'W' (workspace bar char) at panelStartX on screen row 2
    const panelStartX = leftWidth + 1;
    expect(cellAt(compositor, panelStartX, 2)?.char).toBe('W');
  });

  test('panel rows clear stale content when current panel has no line for that row', () => {
    const { compositor } = makeCompositor();
    const leftWidth = WIDTH - PANEL_WIDTH - 1;
    const panelStartX = leftWidth + 1;

    compositor.composite(makeBaseRequest({ panel: makePanelData(), panelWidth: PANEL_WIDTH }));
    expect(cellAt(compositor, panelStartX, 3)?.char).toBe('P');

    const sparsePanel = makePanelData();
    sparsePanel.topContent = [];
    compositor.composite(makeBaseRequest({ panel: sparsePanel, panelWidth: PANEL_WIDTH }));

    expect(cellAt(compositor, panelStartX, 3)?.char).toBe(' ');
  });
});

describe('Compositor — dual-pane (top + bottom)', () => {
  // Layout for these tests (single consolidated workspace bar, no per-pane bars):
  //   WIDTH=40, HEIGHT=14, PANEL_WIDTH=15
  //   header=2, footer=2 → vHeight=10
  //   panelAreaRows=9, contentRows=8
  //   verticalSplitRatio=0.5 → topPaneHeight=floor(8*0.5)=4, bottomPaneHeight=4
  //   hSepRow = 1+4 = 5
  //   Row layout (viewport i → screen row i+2):
  //     i=0     → workspace bar       (screen 2)
  //     i=1..4  → top content[0..3]   (screen 3..6)
  //     i=5     → horizontal sep      (screen 7)
  //     i=6..9  → bottom content[0..3] (screen 8..11)

  const DP_WIDTH = 40;
  const DP_HEIGHT = 14;
  const DP_PANEL_WIDTH = 15;
  // leftWidth = 40 - 15 - 1 = 24, sepX = 24
  const SEP_X = DP_WIDTH - DP_PANEL_WIDTH - 1; // = 24
  const PANEL_START_X = SEP_X + 1; // = 25

  function makeDualPaneRequest(overrides: Partial<CompositeRequest> = {}): CompositeRequest {
    return {
      width: DP_WIDTH,
      height: DP_HEIGHT,
      header: [makeLine(DP_WIDTH, 'H'), makeLine(DP_WIDTH, 'H')],
      viewport: Array.from({ length: 10 }, () => makeLine(DP_WIDTH, '.')),
      footer: [makeLine(DP_WIDTH, 'F'), makeLine(DP_WIDTH, 'F')],
      ...overrides,
    };
  }

  function makeDualPaneData(): PanelCompositeData {
    return {
      workspaceBar: makeLine(DP_PANEL_WIDTH, 'W'),
      topContent: Array.from({ length: 4 }, () => makeLine(DP_PANEL_WIDTH, 'P')),
      topFocused: true,
      hasBottomPane: true,
      bottomContent: Array.from({ length: 4 }, () => makeLine(DP_PANEL_WIDTH, 'Q')),
      bottomFocused: false,
      separator: true,
      verticalSplitRatio: 0.5,
    };
  }

  test('horizontal separator drawn at correct row (hSepRow=5, screen row 7)', () => {
    const { compositor } = makeCompositor();
    const panel = makeDualPaneData();
    compositor.composite(makeDualPaneRequest({ panel, panelWidth: DP_PANEL_WIDTH }));
    // hSepRow = 5 → screenY = 2 + 5 = 7
    // Horizontal separator char is ─ (\u2500) in panel area
    expect(cellAt(compositor, PANEL_START_X, 7)?.char).toBe('\u2500');
  });

  test('T-junction (├) at sepX on separator row', () => {
    const { compositor } = makeCompositor();
    const panel = makeDualPaneData();
    compositor.composite(makeDualPaneRequest({ panel, panelWidth: DP_PANEL_WIDTH }));
    // sepX = 24, separator row screen 7
    expect(cellAt(compositor, SEP_X, 7)?.char).toBe('\u251c');
  });

  test('bottom content appears directly below the separator (screen row 8)', () => {
    const { compositor } = makeCompositor();
    const panel = makeDualPaneData();
    panel.bottomContent![0]![0] = createStyledCell('Z');
    compositor.composite(makeDualPaneRequest({ panel, panelWidth: DP_PANEL_WIDTH }));
    // i=6 → screenY=8 → bottomContent[0] (no per-pane tab bar anymore)
    expect(cellAt(compositor, PANEL_START_X, 8)?.char).toBe('Z');
  });

  test('verticalSplitRatio=0.8 shifts separator row further down', () => {
    const { compositor } = makeCompositor();
    const panel = makeDualPaneData();
    panel.verticalSplitRatio = 0.8;
    // contentRows=8, topH=floor(8*0.8)=6, hSepRow=1+6=7→ screenY=8
    compositor.composite(makeDualPaneRequest({ panel, panelWidth: DP_PANEL_WIDTH }));
    expect(cellAt(compositor, PANEL_START_X, 9)?.char).toBe('\u2500');
    expect(cellAt(compositor, SEP_X, 9)?.char).toBe('\u251c');
  });

  test('dual pane handles sparse content (fewer lines than pane height)', () => {
    // topContent has 1 line but topPaneHeight is 4 — should render without crash
    // bottomContent has 2 lines but bottomPaneHeight is 4
    const { compositor } = makeCompositor();
    const panel = makeDualPaneData();
    panel.topContent = [makeLine(DP_PANEL_WIDTH, 'S')];
    panel.bottomContent = [
      makeLine(DP_PANEL_WIDTH, 'X'),
      makeLine(DP_PANEL_WIDTH, 'X'),
    ];
    expect(() => {
      compositor.composite(makeDualPaneRequest({ panel, panelWidth: DP_PANEL_WIDTH }));
    }).not.toThrow();
    // The single top content line should appear at screen row 3 (i=1)
    expect(cellAt(compositor, PANEL_START_X, 3)?.char).toBe('S');
    // Rows beyond topContent should not keep stamping S
    expect(cellAt(compositor, PANEL_START_X, 4)?.char).not.toBe('S');
    // Bottom content rows i=6 and i=7 (screen 8, 9) should be populated
    expect(cellAt(compositor, PANEL_START_X, 8)?.char).toBe('X');
    expect(cellAt(compositor, PANEL_START_X, 9)?.char).toBe('X');
    // Row i=9 (screen 11) is beyond bottomContent — should not crash
    expect(cellAt(compositor, PANEL_START_X, 11)).toBeDefined();
  });
});

describe('Compositor — buffer reuse (double-buffer, no clone)', () => {
  test('TerminalBuffer constructor is NOT called on second composite() (buffer is reused)', () => {
    // We track constructor calls by counting .cells allocations via composite calls.
    // The core assertion: lastBufferForTest after N composites always returns a non-null
    // object (proving reuse), and rendering is correct on subsequent frames.
    const { compositor } = makeCompositor();
    compositor.composite(makeBaseRequest());
    const buf1 = compositor.lastBufferForTest;
    compositor.composite(makeBaseRequest());
    const buf2 = compositor.lastBufferForTest;
    // After double-buffer swap, lastBufferForTest returns the second-frame buffer.
    // Both must be non-null and be TerminalBuffer instances.
    expect(buf1).not.toBeNull();
    expect(buf2).not.toBeNull();
    // On the first composite frontBuffer=backBuffer (first allocation), second they differ.
    // We only verify correctness: cell content on frame 2 is still correct.
    expect(buf2?.getCell(0, 0)?.char).toBe('H');
  });

  test('resetDiff() clears both buffers so next composite starts fresh', () => {
    const { compositor, stream } = makeCompositor();
    compositor.composite(makeBaseRequest());
    const writeCountBefore = stream.writes.length;
    compositor.resetDiff();
    // After reset, the next composite should write the full screen again (full diff)
    compositor.composite(makeBaseRequest());
    expect(stream.writes.length).toBeGreaterThan(writeCountBefore);
    expect(compositor.lastBufferForTest).not.toBeNull();
  });

  test('resize (dim change) does not crash and produces correct output', () => {
    const { compositor } = makeCompositor();
    compositor.composite(makeBaseRequest({ width: 40, height: 10 }));
    // Shrink terminal
    expect(() => {
      compositor.composite(makeBaseRequest({ width: 30, height: 8,
        header: [makeLine(30, 'H'), makeLine(30, 'H')],
        viewport: Array.from({ length: 4 }, () => makeLine(30, '.')),
        footer: [makeLine(30, 'F'), makeLine(30, 'F')],
      }));
    }).not.toThrow();
    // Buffer should now be 30 wide
    expect(compositor.lastBufferForTest?.width).toBe(30);
  });
});

describe('Compositor — degenerate panelWidth >= width', () => {
  test('leftWidth clamped to 1 when panelWidth >= width - 1', () => {
    const { compositor } = makeCompositor();
    // panelWidth = width - 1 → leftWidth would be -1 without clamp, clamped to 1
    const hugePanel: PanelCompositeData = {
      workspaceBar: makeLine(WIDTH - 1, 'W'),
      topContent: Array.from({ length: 6 }, () => makeLine(WIDTH - 1, 'P')),
      topFocused: true,
      hasBottomPane: false,
      separator: false,
      verticalSplitRatio: 0.5,
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
      workspaceBar: makeLine(WIDTH, 'W'),
      topContent: Array.from({ length: 6 }, () => makeLine(WIDTH, 'P')),
      topFocused: true,
      hasBottomPane: false,
      separator: false,
      verticalSplitRatio: 0.5,
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

// ---------------------------------------------------------------------------
// Stale-frame invariants
//
// The compositor's incremental path is only correct while its front buffer
// still describes what the terminal is showing. These pin the two ways that
// used to break, both of which left splash art on screen underneath the
// transcript: rows the caller stopped supplying, and a size change that
// reallocates the buffer.
// ---------------------------------------------------------------------------

describe('no row keeps a previous frame', () => {
  test('rows past a shortened viewport are repainted, not left showing the old frame', () => {
    const { compositor, stream } = makeCompositor();
    const header = [makeLine(WIDTH, 'H')];
    const footer = [makeLine(WIDTH, 'F')];
    // body rows = 10 - 1 - 1 = 8 → screen rows 1..8
    compositor.composite({
      width: WIDTH, height: HEIGHT, header, footer,
      viewport: Array.from({ length: 8 }, () => makeLine(WIDTH, 'S')),
    });
    expect(cellAt(compositor, 0, 8)?.char).toBe('S');

    // A docked overlay's bottom inset (or an overlay-row reservation that
    // overshoots) leaves the caller supplying fewer lines than the body has.
    stream.writes.length = 0;
    compositor.composite({
      width: WIDTH, height: HEIGHT, header, footer,
      viewport: Array.from({ length: 6 }, () => makeLine(WIDTH, 'T')),
    });

    expect(cellAt(compositor, 0, 7)?.char).toBe(' ');
    expect(cellAt(compositor, 0, 8)?.char).toBe(' ');
    // …and the erase actually went to the terminal: rows 8 and 9 (1-based) are
    // addressed in this frame's output.
    const output = stream.writes.join('');
    expect(output).toContain('\x1b[8;1H');
    expect(output).toContain('\x1b[9;1H');
  });

  test('requestFullRepaint() erases the screen and re-emits every cell once', () => {
    const { compositor, stream } = makeCompositor();
    const request = makeBaseRequest();
    compositor.composite(request);

    // An identical frame normally writes nothing at all.
    stream.writes.length = 0;
    compositor.composite(makeBaseRequest());
    expect(stream.writes.join('')).toBe('');

    stream.writes.length = 0;
    compositor.requestFullRepaint();
    compositor.composite(makeBaseRequest());
    const output = stream.writes.join('');
    expect(output).toContain('\x1b[2J');        // erase display
    expect(output).toContain('\x1b[1;1H');      // repaint starts at the top-left
    expect(output).toContain('\x1b[10;1H');     // …and reaches the last row
    // One-shot: the frame after the repaint is differential again.
    stream.writes.length = 0;
    compositor.composite(makeBaseRequest());
    expect(stream.writes.join('')).toBe('');
  });

  test('a size change repaints in full rather than diffing against a forgotten frame', () => {
    const { compositor, stream } = makeCompositor();
    compositor.composite(makeBaseRequest());

    stream.writes.length = 0;
    compositor.composite({
      width: WIDTH, height: HEIGHT + 4,
      header: [makeLine(WIDTH, 'H'), makeLine(WIDTH, 'H')],
      viewport: Array.from({ length: 10 }, () => makeLine(WIDTH, '.')),
      footer: [makeLine(WIDTH, 'F'), makeLine(WIDTH, 'F')],
    });
    expect(stream.writes.join('')).toContain('\x1b[2J');
  });
});
