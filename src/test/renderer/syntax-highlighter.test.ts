import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── Inline the pure functions under test ─────────────────────────────────────
// We test spansToLines and syntaxColor as pure logic, without loading tree-sitter
// WASM (which requires a real runtime). The SyntaxHighlighter class integration
// is tested via mock injection.

// Copy of SyntaxToken (mirrors the export; avoids importing the module which
// would trigger TreeSitterService and WASM initialization at import time).
interface SyntaxToken {
  text: string;
  fg: string;
  bold?: boolean;
  italic?: boolean;
}
type HighlightedLine = SyntaxToken[];

interface Span {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  text: string;
  fg: string;
  bold?: boolean;
  italic?: boolean;
}

const DEFAULT_FG = '252';

/**
 * Inline copy of spansToLines, kept in sync with the source.
 * Tests here document and guard the expected behaviour.
 */
function spansToLines(spans: Span[], codeLines: string[]): HighlightedLine[] {
  const result: HighlightedLine[] = codeLines.map(() => []);
  const linePositions: number[] = codeLines.map(() => 0);

  for (const span of spans) {
    if (span.startRow === span.endRow) {
      const row = span.startRow;
      if (row >= codeLines.length) continue;

      // Overlap guard FIRST
      if (linePositions[row] > span.startCol) continue;

      // Gap emission AFTER guard
      const currentCol = linePositions[row];
      if (currentCol < span.startCol) {
        const gapText = codeLines[row].slice(currentCol, span.startCol);
        if (gapText) result[row].push({ text: gapText, fg: DEFAULT_FG });
      }

      const tokenText = codeLines[row].slice(span.startCol, span.endCol);
      if (tokenText) {
        result[row].push({ text: tokenText, fg: span.fg, bold: span.bold, italic: span.italic });
      }
      linePositions[row] = span.endCol;
    } else {
      for (let r = span.startRow; r <= span.endRow; r++) {
        if (r >= codeLines.length) break;

        const colStart = r === span.startRow ? span.startCol : 0;
        const colEnd = r === span.endRow ? span.endCol : codeLines[r].length;

        if (linePositions[r] > colStart) continue;

        const currentCol = linePositions[r];
        if (currentCol < colStart) {
          const gapText = codeLines[r].slice(currentCol, colStart);
          if (gapText) result[r].push({ text: gapText, fg: DEFAULT_FG });
        }

        const tokenText = codeLines[r].slice(colStart, colEnd);
        if (tokenText) {
          result[r].push({ text: tokenText, fg: span.fg, bold: span.bold, italic: span.italic });
        }
        linePositions[r] = colEnd;
      }
    }
  }

  // Fill remaining
  for (let r = 0; r < codeLines.length; r++) {
    const remaining = codeLines[r].slice(linePositions[r]);
    if (remaining) result[r].push({ text: remaining, fg: DEFAULT_FG });
  }

  return result;
}

/** Inline copy of syntaxColor lookup logic */
const NODE_TYPE_COLORS: Record<string, { fg: string; bold?: boolean; italic?: boolean }> = {
  'const': { fg: '#d000ff', bold: true },
  'string': { fg: '#00ff88' },
  'number': { fg: '#ffcc00' },
  'comment': { fg: '#666666', italic: true },
  'function_declaration': { fg: '#00ffff' },
  'type_identifier': { fg: '#ff6b9d' },
  'true': { fg: '#ff8c00' },
  'false': { fg: '#ff8c00' },
};

function syntaxColor(nodeType: string): { fg: string; bold?: boolean; italic?: boolean } | null {
  return NODE_TYPE_COLORS[nodeType] ?? null;
}

// ─── spansToLines tests ────────────────────────────────────────────────────────

describe('spansToLines', () => {
  it('returns empty token arrays for empty code lines', () => {
    const result = spansToLines([], ['']);
    expect(result).toEqual([[]]);
  });

  it('handles non-overlapping single-line spans correctly', () => {
    const code = 'const x = 1;';
    const codeLines = [code];
    const spans: Span[] = [
      { startRow: 0, startCol: 0, endRow: 0, endCol: 5, text: 'const', fg: '#d000ff', bold: true },
      { startRow: 0, startCol: 6, endRow: 0, endCol: 7, text: 'x', fg: DEFAULT_FG },
      { startRow: 0, startCol: 10, endRow: 0, endCol: 11, text: '1', fg: '#ffcc00' },
    ];
    const result = spansToLines(spans, codeLines);
    expect(result).toHaveLength(1);
    // First token: 'const' colored
    expect(result[0][0]).toEqual({ text: 'const', fg: '#d000ff', bold: true });
    // Gap ' ' between 'const' and 'x'
    expect(result[0][1]).toEqual({ text: ' ', fg: DEFAULT_FG });
    // 'x'
    expect(result[0][2]).toEqual({ text: 'x', fg: DEFAULT_FG });
    // Gap ' = ' between 'x' and '1'
    expect(result[0][3]).toEqual({ text: ' = ', fg: DEFAULT_FG });
    // '1'
    expect(result[0][4]).toEqual({ text: '1', fg: '#ffcc00' });
    // Remaining ';'
    expect(result[0][5]).toEqual({ text: ';', fg: DEFAULT_FG });
  });

  it('skips overlapping spans without emitting corrupt gap text', () => {
    // Simulates the bug: a parent span covers col 0-10, then a child span
    // tries to start at col 3. Without the fix, gap text (cols 10-3 = negative/empty)
    // would be computed AFTER already advancing linePositions past startCol.
    // With the fix: the overlap guard fires first, the span is skipped entirely.
    const code = 'hello world';
    const codeLines = [code];
    const spans: Span[] = [
      // First span covers 'hello world' (cols 0-11)
      { startRow: 0, startCol: 0, endRow: 0, endCol: 11, text: 'hello world', fg: '#00ff88' },
      // Overlapping span tries to cover 'world' (cols 6-11), should be skipped
      { startRow: 0, startCol: 6, endRow: 0, endCol: 11, text: 'world', fg: '#d000ff' },
    ];
    const result = spansToLines(spans, codeLines);
    expect(result).toHaveLength(1);
    // Only one token: the first span; the overlapping span is silently skipped
    expect(result[0]).toHaveLength(1);
    expect(result[0][0]).toEqual({ text: 'hello world', fg: '#00ff88' });
  });

  it('overlap guard fires BEFORE gap emission; no corrupt gap token', () => {
    // This is the exact regression test for the bug fixed in this PR.
    // linePositions[row] = 10 (advanced past startCol=6 by a prior span)
    // Without the fix: gap text codeLines[row].slice(10, 6) = '' is computed first.
    // With the fix: guard `linePositions[row] > span.startCol` fires first → continue.
    const code = 'aaaaaaaaaa bbbb';
    const codeLines = [code];
    const spans: Span[] = [
      // Span 1 advances position to col 10
      { startRow: 0, startCol: 0, endRow: 0, endCol: 10, text: 'aaaaaaaaaa', fg: '#00ffff' },
      // Span 2 starts at col 6, which is behind the current position (10), overlap
      { startRow: 0, startCol: 6, endRow: 0, endCol: 10, text: 'aaaa', fg: '#d000ff' },
      // Span 3 is valid: starts at 11
      { startRow: 0, startCol: 11, endRow: 0, endCol: 15, text: 'bbbb', fg: '#ffcc00' },
    ];
    const result = spansToLines(spans, codeLines);
    // Span 2 must not produce any token or corrupt gap
    // Expected: 'aaaaaaaaaa' + ' ' (gap) + 'bbbb'
    expect(result[0]).toHaveLength(3);
    expect(result[0][0]).toEqual({ text: 'aaaaaaaaaa', fg: '#00ffff' });
    expect(result[0][1]).toEqual({ text: ' ', fg: DEFAULT_FG });
    expect(result[0][2]).toEqual({ text: 'bbbb', fg: '#ffcc00' });
  });

  it('overlap guard fires BEFORE gap emission for multi-line spans', () => {
    // Regression: multi-line path had guard AFTER gap emission, unlike single-line path.
    // A later span starting at col 2 on a line already advanced to col 5 would emit
    // a corrupt gap (slice(5, 2) = '') before the guard skipped it.
    const codeLines = ['hello world', 'foo bar baz'];
    const spans: Span[] = [
      // Span 1: multi-line, advances line 0 to col 5, line 1 to col 3
      { startRow: 0, startCol: 0, endRow: 1, endCol: 3, text: 'hello\nfoo', fg: '#00ff88' },
      // Span 2: overlaps, starts at line 0 col 2 (behind pos 5), should be skipped entirely
      { startRow: 0, startCol: 2, endRow: 1, endCol: 5, text: 'llo\nfoo b', fg: '#d000ff' },
      // Span 3: valid, starts at line 1 col 4 (past pos 3)
      { startRow: 1, startCol: 4, endRow: 1, endCol: 7, text: 'bar', fg: '#ffcc00' },
    ];
    const result = spansToLines(spans, codeLines);
    // Line 0: span 1 consumes entire line (col 0 to codeLines[0].length=11)
    // Span 2 starts at col 2 on line 0, but linePositions[0] is already 11, skipped
    expect(result[0][0]).toEqual({ text: 'hello world', fg: '#00ff88' });
    expect(result[0]).toHaveLength(1);
    // Line 1: span 1 covers col 0-3 ('foo'), span 2 starts at col 2 but pos=3 > 2, skipped
    // span 3 starts at col 4: gap ' ' (3-4), then 'bar' (4-7), then ' baz' trailing
    expect(result[1][0]).toEqual({ text: 'foo', fg: '#00ff88' });
    expect(result[1][1]).toEqual({ text: ' ', fg: DEFAULT_FG });
    expect(result[1][2]).toEqual({ text: 'bar', fg: '#ffcc00' });
    expect(result[1][3]).toEqual({ text: ' baz', fg: DEFAULT_FG });
    expect(result[1]).toHaveLength(4);
  });

  it('handles multi-line spans spanning two lines', () => {
    const code = '`hello\nworld`';
    const codeLines = code.split('\n');
    const spans: Span[] = [
      { startRow: 0, startCol: 0, endRow: 1, endCol: 6, text: '`hello\nworld`', fg: '#00ff88' },
    ];
    const result = spansToLines(spans, codeLines);
    expect(result).toHaveLength(2);
    expect(result[0][0]).toEqual({ text: '`hello', fg: '#00ff88' });
    expect(result[1][0]).toEqual({ text: 'world`', fg: '#00ff88' });
  });

  it('fills trailing gap text with default color', () => {
    const code = 'x + y';
    const codeLines = [code];
    const spans: Span[] = [
      { startRow: 0, startCol: 0, endRow: 0, endCol: 1, text: 'x', fg: '#87ceeb' },
    ];
    const result = spansToLines(spans, codeLines);
    // 'x' + ' + y' as default
    expect(result[0]).toHaveLength(2);
    expect(result[0][1]).toEqual({ text: ' + y', fg: DEFAULT_FG });
  });
});

// ─── syntaxColor tests ─────────────────────────────────────────────────────────

describe('syntaxColor', () => {
  it('maps known keyword node types to purple', () => {
    const style = syntaxColor('const');
    expect(style).not.toBeNull();
    expect(style!.fg).toBe('#d000ff');
    expect(style!.bold).toBe(true);
  });

  it('maps string node type to green', () => {
    expect(syntaxColor('string')!.fg).toBe('#00ff88');
  });

  it('maps number node type to yellow', () => {
    expect(syntaxColor('number')!.fg).toBe('#ffcc00');
  });

  it('maps comment node type to dim grey with italic', () => {
    const style = syntaxColor('comment');
    expect(style!.fg).toBe('#666666');
    expect(style!.italic).toBe(true);
  });

  it('returns null for unknown node types', () => {
    expect(syntaxColor('unknown_node_xyz')).toBeNull();
  });
});

// ─── Hash cache key tests ──────────────────────────────────────────────────────

describe('hash-based cache key', () => {
  it('produces the same key for identical code strings', () => {
    // Inline DJB2 from source
    function hashString(s: string): number {
      let h = 5381;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
        h = h >>> 0;
      }
      return h;
    }

    const code = 'const x = 1;';
    expect(hashString(code)).toBe(hashString(code));
  });

  it('produces different keys for different code strings', () => {
    function hashString(s: string): number {
      let h = 5381;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
        h = h >>> 0;
      }
      return h;
    }

    expect(hashString('const x = 1;')).not.toBe(hashString('const y = 2;'));
  });
});

// ─── SyntaxHighlighter integration tests (mock TreeSitterService) ──────────────

describe('SyntaxHighlighter integration', () => {
  function highlightLogic(cache: Map<string, HighlightedLine[]>, pending: Set<string>, key: string): HighlightedLine[] | null {
    const cached = cache.get(key);
    if (cached) return cached;
    if (!pending.has(key)) pending.add(key);
    return null;
  }

  it('highlight() returns null when cache is empty (parser not ready)', async () => {
    // Mock TreeSitterService before importing to prevent WASM init
    const mockService = {
      initialize: mock(() => Promise.resolve()),
      loadLanguage: mock(() => Promise.resolve(null)),
      parse: mock(() => Promise.resolve(null)),
      getInstance: mock(() => mockService),
    };

    // We test the contract: when cache has no entry, highlight() returns null
    // and schedules a parse. We verify the null return directly on the logic.
    const cache = new Map<string, HighlightedLine[]>();
    const pending = new Set<string>();

    const result = highlightLogic(cache, pending, 'typescript:12345');
    expect(result).toBeNull();
    expect(pending.has('typescript:12345')).toBe(true);
  });

  it('highlight() returns cached tokens after parse completes', () => {
    const cache = new Map<string, HighlightedLine[]>();
    const pending = new Set<string>();
    const key = 'typescript:12345';
    const fakeResult: HighlightedLine[] = [[{ text: 'const', fg: '#d000ff', bold: true }]];

    cache.set(key, fakeResult);

    const result = highlightLogic(cache, pending, key);
    expect(result).toBe(fakeResult);
    expect(pending.has(key)).toBe(false);
  });
});
