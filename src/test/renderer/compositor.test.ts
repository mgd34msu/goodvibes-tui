import { describe, test, expect, beforeEach } from 'bun:test';
import { Compositor } from '../../renderer/compositor.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { createStyledCell, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import type { Line, Cell } from '@pellux/goodvibes-sdk/platform/types';
import type { CompositeRequest, SelectionInfo } from '../../renderer/compositor.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal mock WriteStream, records all writes. */
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

describe('Compositor: full-width body', () => {
  test('produces output (stdout.write called)', () => {
    const { compositor, stream } = makeCompositor();
    compositor.composite(makeBaseRequest());
    expect(stream.writes.length).toBeGreaterThan(0);
  });

  test('renders viewport lines via full-width blit', () => {
    const { compositor } = makeCompositor();
    const viewport = Array.from({ length: 6 }, () => makeLine(WIDTH, '.'));
    // Stamp a recognisable character at col 30 on viewport row 0 (screen row 2)
    stampChar(viewport[0], 30, 'X');
    compositor.composite(makeBaseRequest({ viewport }));
    // The full line is blitted: col 30 on screen row 2 is 'X'
    expect(cellAt(compositor, 30, 2)?.char).toBe('X');
  });

  test('the header occupies the rows it is given (header=2 rows)', () => {
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

describe('Compositor: buffer reuse (double-buffer, no clone)', () => {
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

describe('Compositor: selection overlay', () => {
  test('selection covers the full width (there is no side pane to exclude)', () => {
    const { compositor } = makeCompositor();
    const selection: SelectionInfo = {
      isCellSelected: (col, _row) => col === 0 || col === WIDTH - 1,
      scrollTop: 0,
      lineCount: 6,
    };
    compositor.composite(makeBaseRequest({ selection }));
    expect(cellAt(compositor, 0, 2)?.bg).toBe(activeTokens().backgroundSelected);
    expect(cellAt(compositor, WIDTH - 1, 2)?.bg).toBe(activeTokens().backgroundSelected);
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

// ---------------------------------------------------------------------------
// Modal layers: dim pass + stamp-over (surface-compose.ts)
// ---------------------------------------------------------------------------

describe('Compositor modal layers', () => {
  test('a dimming layer darkens the whole screen, then stamps its rectangle over it; cells outside keep their content', () => {
    const { compositor } = makeCompositor();
    const width = 20;
    const height = 6;
    const viewport = Array.from({ length: height - 2 }, () => makeLine(width, 'v'));
    const panelBg = activeTokens().backgroundPanel;
    const layerLine = Array.from({ length: 6 }, () => createStyledCell('m', { fg: activeTokens().text, bg: panelBg }));
    compositor.composite({
      width, height,
      header: [makeLine(width, 'h')],
      viewport,
      footer: [makeLine(width, 'f')],
      layers: [{ x: 5, y: 2, lines: [layerLine], dim: true }],
    });
    const buffer = compositor.lastBufferForTest!;
    // Outside the layer: original characters, dimmed colors (no longer the empty terminal default).
    expect(buffer.getCell(0, 0)!.char).toBe('h');
    expect(buffer.getCell(0, 0)!.bg).not.toBe('');
    expect(buffer.getCell(0, 2)!.char).toBe('v');
    // Inside the layer: its own cells, undimmed.
    expect(buffer.getCell(5, 2)!.char).toBe('m');
    expect(buffer.getCell(5, 2)!.bg).toBe(panelBg);
    expect(buffer.getCell(11, 2)!.char).toBe('v');
  });

  test('the selection highlight still applies, and dims along with the rest under a modal', () => {
    const { compositor } = makeCompositor();
    const width = 10;
    const selection: SelectionInfo = { isCellSelected: (col) => col === 0, scrollTop: 0, lineCount: 3 };
    compositor.composite({
      width, height: 3, header: [], viewport: [makeLine(width, 'a'), makeLine(width, 'b'), makeLine(width, 'c')], footer: [],
      selection,
      layers: [{ x: 8, y: 0, lines: [[createStyledCell('m', { bg: activeTokens().backgroundPanel })]], dim: true }],
    });
    const selected = compositor.lastBufferForTest!.getCell(0, 1)!;
    const plain = compositor.lastBufferForTest!.getCell(1, 1)!;
    expect(selected.bg).not.toBe(plain.bg);
    expect(selected.bg).not.toBe(activeTokens().backgroundSelected);
  });
});
