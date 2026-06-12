// ---------------------------------------------------------------------------
// golden-frames.test.ts — Deterministic renderer regression snapshots
//
// Strategy:
//   Each test renders a fixed surface with frozen inputs (no timestamps,
//   no dynamic counters, fixed terminal dimensions, frozen DARK theme),
//   then compares the result against a committed snapshot text file.
//
// Snapshot format (see snapshotEncode / snapshotDiff below):
//   A human-readable text block:
//     Line 1:  # GV_GOLDEN surface=<name> width=<W> height=<H>
//     Lines 2..H+1:  |<chars padded to W>|
//     Then:    @STYLES
//     Style records:  <row> <col> <attr>=<value> ...
//     (only non-default attributes are emitted)
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames.test.ts
//   CI: env var is absent → mismatch = fail.
//
// Surfaces covered:
//   1. shell-footer       — buildShellFooter (fixed inputs, no timestamps)
//   2. context-meter      — UIFactory.createFooter with context window + threshold
//   3. markdown-transcript — renderMarkdown with code fence, headings, inline code
//   4. panel-workspace    — A static mock panel render (Panel.render contract)
//
// Determinism exclusions:
//   - UIFactory.createHeader: gradient phase depends on frame counter; excluded.
//     (frame=0 is stable, but header embeds model/provider — add if model list stabilises)
//   - createThinkingFragment: dynamic THINKING_PHRASES rotate on frame; excluded.
//   - renderContextInspector: requires live ConversationManager (stateful); excluded.
//   - renderSettingsModal: requires live ConfigManager + SettingsModal (reads fs env);
//     excluded from goldens (its own test suite covers output assertions).
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { renderMarkdown } from '../../renderer/markdown.ts';
import type { Cell, Line } from '../../types/grid.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOLDENS_DIR = new URL('./golden-frames/', import.meta.url).pathname;
const UPDATE = process.env['GOODVIBES_UPDATE_GOLDENS'] === '1';

// Fixed terminal dimensions for all golden surfaces.
const W = 100;
const H = 24;

// ---------------------------------------------------------------------------
// Snapshot encoding
// ---------------------------------------------------------------------------

/**
 * Encode a Line[] into the golden snapshot text format.
 *
 * Format:
 *   # GV_GOLDEN surface=<name> width=<W> height=<H>
 *   |<W chars per line>|
 *   ...repeated H lines (or fewer if surface is shorter)...
 *   @STYLES
 *   <row> <col> fg=<v>         (only if non-empty)
 *   <row> <col> bg=<v>         (only if non-empty)
 *   <row> <col> bold=1         (only if true)
 *   <row> <col> dim=1          (only if true)
 *   <row> <col> underline=1    (only if true)
 *   <row> <col> italic=1       (only if true)
 *   <row> <col> strikethrough=1 (only if true)
 *
 * Multiple attributes on the same cell are emitted as separate records
 * (one per attribute) to keep diffing line-oriented.
 */
function snapshotEncode(surface: string, lines: Line[]): string {
  const height = lines.length;
  const width = lines[0]?.length ?? 0;

  const textBlock: string[] = [];
  const styleBlock: string[] = [];

  for (let row = 0; row < height; row++) {
    const line = lines[row]!;
    // Text layer — join chars and pad to width
    const chars = line.map((c) => (c.char === '' ? ' ' : c.char)).join('');
    textBlock.push(`|${chars}|`);

    // Style layer — emit only non-default values
    for (let col = 0; col < line.length; col++) {
      const c = line[col] as Cell;
      if (c.fg)            styleBlock.push(`${row} ${col} fg=${c.fg}`);
      if (c.bg)            styleBlock.push(`${row} ${col} bg=${c.bg}`);
      if (c.bold)          styleBlock.push(`${row} ${col} bold=1`);
      if (c.dim)           styleBlock.push(`${row} ${col} dim=1`);
      if (c.underline)     styleBlock.push(`${row} ${col} underline=1`);
      if (c.italic)        styleBlock.push(`${row} ${col} italic=1`);
      if (c.strikethrough) styleBlock.push(`${row} ${col} strikethrough=1`);
    }
  }

  const header = `# GV_GOLDEN surface=${surface} width=${width} height=${height}`;
  return [
    header,
    ...textBlock,
    '@STYLES',
    ...styleBlock,
    '',
  ].join('\n');
}

/**
 * Parse snapshot back to { header, textLines, styleLines }.
 * Returns null if the file is missing or malformed.
 */
function snapshotParse(raw: string): {
  surface: string;
  width: number;
  height: number;
  textLines: string[];
  styleLines: string[];
} | null {
  const lines = raw.split('\n');
  if (!lines[0]?.startsWith('# GV_GOLDEN')) return null;

  const headerMatch = lines[0].match(/surface=(\S+) width=(\d+) height=(\d+)/);
  if (!headerMatch) return null;

  const surface = headerMatch[1]!;
  const width = parseInt(headerMatch[2]!, 10);
  const height = parseInt(headerMatch[3]!, 10);

  const textLines: string[] = [];
  const styleLines: string[] = [];
  let inStyles = false;

  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l === '@STYLES') { inStyles = true; continue; }
    if (!inStyles) {
      if (l.startsWith('|')) textLines.push(l);
    } else {
      if (l.trim()) styleLines.push(l.trim());
    }
  }

  return { surface, width, height, textLines, styleLines };
}

/**
 * Produce a readable diff between two snapshots.
 * Returns null if they match.
 */
function snapshotDiff(
  name: string,
  expectedRaw: string,
  actualRaw: string,
): string | null {
  if (expectedRaw === actualRaw) return null;

  const exp = snapshotParse(expectedRaw);
  const act = snapshotParse(actualRaw);

  if (!exp || !act) {
    return `[${name}] snapshot parse failed\n--- expected ---\n${expectedRaw}\n--- actual ---\n${actualRaw}`;
  }

  const diffLines: string[] = [`[${name}] golden-frame mismatch:`];

  // Text diff
  const maxTextRows = Math.max(exp.textLines.length, act.textLines.length);
  for (let i = 0; i < maxTextRows; i++) {
    const e = exp.textLines[i] ?? '<missing>';
    const a = act.textLines[i] ?? '<missing>';
    if (e !== a) {
      diffLines.push(`  TEXT row ${i}:`);
      diffLines.push(`    expected: ${e}`);
      diffLines.push(`    actual:   ${a}`);
    }
  }

  // Style diff — find lines present in one but not the other
  const expStyleSet = new Set(exp.styleLines);
  const actStyleSet = new Set(act.styleLines);
  for (const s of expStyleSet) {
    if (!actStyleSet.has(s)) diffLines.push(`  STYLE removed: ${s}`);
  }
  for (const s of actStyleSet) {
    if (!expStyleSet.has(s)) diffLines.push(`  STYLE added:   ${s}`);
  }

  return diffLines.join('\n');
}

/**
 * Read the golden file for a surface, or return null if missing.
 */
function readGolden(name: string): string | null {
  const p = join(GOLDENS_DIR, `${name}.txt`);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

/**
 * Write the golden file for a surface.
 */
function writeGolden(name: string, content: string): void {
  mkdirSync(GOLDENS_DIR, { recursive: true });
  writeFileSync(join(GOLDENS_DIR, `${name}.txt`), content, 'utf-8');
}

/**
 * Core comparison: render → encode → compare/update.
 * Returns the encoded snapshot (for determinism double-check).
 */
function assertGolden(surface: string, lines: Line[]): string {
  const actual = snapshotEncode(surface, lines);

  if (UPDATE) {
    writeGolden(surface, actual);
    return actual;
  }

  const expected = readGolden(surface);
  if (expected === null) {
    throw new Error(
      `[${surface}] golden file missing. Run with GOODVIBES_UPDATE_GOLDENS=1 to generate.`,
    );
  }

  const diff = snapshotDiff(surface, expected, actual);
  if (diff !== null) {
    throw new Error(
      `${diff}\n\nRun with GOODVIBES_UPDATE_GOLDENS=1 to regenerate.`,
    );
  }

  return actual;
}

// ---------------------------------------------------------------------------
// Surface renders
// ---------------------------------------------------------------------------

/**
 * Render the shell footer surface.
 * Inputs are fully fixed — no timestamps, no dynamic values.
 * lastCopyTime=0 suppresses any copy-flash state.
 */
function renderShellFooterSurface(): Line[] {
  const result = buildShellFooter({
    width: W,
    promptText: '> Ask me anything',
    promptLineCount: 1,
    usage: { up: 1024, down: 512 },
    showExitNotice: false,
    lastCopyTime: 0,          // frozen: no copy-flash
    model: 'claude-opus-4',
    toolCount: 7,
    workingDir: '/workspace/my-project',
    provider: 'anthropic',
    contextWindow: 0,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
  });
  return result.lines;
}

/**
 * Render the context-meter (shell footer with context window active).
 * Fixed token values ensure stable bar fill and color.
 */
function renderContextMeterSurface(): Line[] {
  // 60_000 used / 100_000 window = 60% fill; threshold 0.80 → marker in empty zone
  return UIFactory.createFooter(
    W,
    '> Ask me anything',
    { up: 1024, down: 512 },
    false,          // showExitNotice
    0,              // lastCopyTime — frozen
    'claude-opus-4',
    7,              // toolCount
    undefined,      // cursorPos
    '/workspace/my-project',
    'anthropic',
    100_000,        // contextWindow
    0.80,           // compactThreshold
    false,          // dangerMode
    60_000,         // lastInputTokens → 60% fill
  );
}

/**
 * Render a markdown transcript sample.
 * Covers: H1 heading, H2 + rule, inline code, blockquote, unordered list,
 * fenced code block (TypeScript). All pure-function, no external state.
 */
function renderMarkdownTranscriptSurface(): Line[] {
  const md = [
    '# Response Summary',
    '',
    '## What the code does',
    '',
    'The function `processItems` iterates over the list and applies a transformation.',
    '',
    '> **Note:** This is a pure function with no side-effects.',
    '',
    '- Input: an array of strings',
    '- Output: filtered and mapped results',
    '- Complexity: O(n)',
    '',
    '```typescript',
    'function processItems(items: string[]): string[] {',
    '  return items',
    '    .filter((s) => s.length > 0)',
    '    .map((s) => s.trim());',
    '}',
    '```',
    '',
    'Use `processItems([" hello ", "", "world"])` to verify.',
  ].join('\n');

  return renderMarkdown(md, W);
}

/**
 * Render a static panel workspace surface.
 * The panel content is entirely deterministic (static text rows).
 * This exercises the Panel.render contract and grid encoding.
 */
function renderPanelWorkspaceSurface(): Line[] {
  // Build a static panel surface matching a typical panel layout:
  // a tab bar line, a content area, and a status line.
  // We construct the grid directly using createEmptyLine + overrides
  // rather than importing a live panel (live panels may pull in state).
  //
  // Pattern: simulate what a minimal panel would return from render().
  const { createStyledCell, createEmptyLine } = {
    createStyledCell: (char: string, overrides: Partial<Omit<Cell, 'char'>> = {}): Cell => ({
      char,
      fg: overrides.fg ?? '',
      bg: overrides.bg ?? '',
      bold: overrides.bold ?? false,
      dim: overrides.dim ?? false,
      underline: overrides.underline ?? false,
      italic: overrides.italic ?? false,
      strikethrough: overrides.strikethrough ?? false,
    }),
    createEmptyLine: (width: number): Line =>
      Array.from({ length: width }, () => ({
        char: ' ', fg: '', bg: '', bold: false,
        dim: false, underline: false, italic: false, strikethrough: false,
      })),
  };

  const lines: Line[] = [];

  // Row 0: tab bar (panel name in accent colour)
  const tabBar = createEmptyLine(W);
  const tabLabel = '  ⊞ OPERATIONS  ';
  for (let i = 0; i < tabLabel.length && i < W; i++) {
    tabBar[i] = createStyledCell(tabLabel[i]!, { fg: '#38bdf8', bold: true });
  }
  lines.push(tabBar);

  // Row 1: separator
  const sep = createEmptyLine(W);
  for (let i = 0; i < W; i++) sep[i] = createStyledCell('─', { fg: '#334155' });
  lines.push(sep);

  // Rows 2-5: static content rows
  const contentRows = [
    '  Session: gv-20260612-a1b2c3                    status: idle         ',
    '  Model:   claude-opus-4   Provider: anthropic   Tools: 7             ',
    '  Context: 0 / 0 tokens   Usage: ↑1024 ↓512                          ',
    '  Agents:  0 running   Processes: 0 running                           ',
  ];
  for (const rowText of contentRows) {
    const row = createEmptyLine(W);
    for (let i = 0; i < rowText.length && i < W; i++) {
      row[i] = createStyledCell(rowText[i]!, {});
    }
    lines.push(row);
  }

  // Row 6: bottom separator
  const sep2 = createEmptyLine(W);
  for (let i = 0; i < W; i++) sep2[i] = createStyledCell('─', { fg: '#334155' });
  lines.push(sep2);

  return lines;
}

// ---------------------------------------------------------------------------
// Golden-frame test suite
// ---------------------------------------------------------------------------

describe('golden-frames', () => {
  describe('shell-footer', () => {
    test('matches committed golden snapshot', () => {
      const lines = renderShellFooterSurface();
      expect(lines.length).toBeGreaterThan(0);
      assertGolden('shell-footer', lines);
    });

    test('render is deterministic (two consecutive renders match)', () => {
      const a = snapshotEncode('shell-footer', renderShellFooterSurface());
      const b = snapshotEncode('shell-footer', renderShellFooterSurface());
      expect(a).toBe(b);
    });
  });

  describe('context-meter', () => {
    test('matches committed golden snapshot', () => {
      const lines = renderContextMeterSurface();
      expect(lines.length).toBeGreaterThan(0);
      assertGolden('context-meter', lines);
    });

    test('render is deterministic (two consecutive renders match)', () => {
      const a = snapshotEncode('context-meter', renderContextMeterSurface());
      const b = snapshotEncode('context-meter', renderContextMeterSurface());
      expect(a).toBe(b);
    });
  });

  describe('markdown-transcript', () => {
    test('matches committed golden snapshot', () => {
      const lines = renderMarkdownTranscriptSurface();
      expect(lines.length).toBeGreaterThan(0);
      assertGolden('markdown-transcript', lines);
    });

    test('render is deterministic (two consecutive renders match)', () => {
      const a = snapshotEncode('markdown-transcript', renderMarkdownTranscriptSurface());
      const b = snapshotEncode('markdown-transcript', renderMarkdownTranscriptSurface());
      expect(a).toBe(b);
    });
  });

  describe('panel-workspace', () => {
    test('matches committed golden snapshot', () => {
      const lines = renderPanelWorkspaceSurface();
      expect(lines.length).toBeGreaterThan(0);
      assertGolden('panel-workspace', lines);
    });

    test('render is deterministic (two consecutive renders match)', () => {
      const a = snapshotEncode('panel-workspace', renderPanelWorkspaceSurface());
      const b = snapshotEncode('panel-workspace', renderPanelWorkspaceSurface());
      expect(a).toBe(b);
    });
  });

  describe('mismatch detection', () => {
    test('snapshotDiff detects text change', () => {
      const lines = renderShellFooterSurface();
      const original = snapshotEncode('shell-footer', lines);

      // Mutate the first char of the first text row in a copy
      const mutated = original.replace(
        /^\|(.)/m,
        (_, second: string) => `|${second === ' ' ? 'X' : ' '}`,
      );

      const diff = snapshotDiff('shell-footer', original, mutated);
      expect(diff).not.toBeNull();
      expect(diff).toContain('TEXT row');
    });

    test('snapshotDiff detects style change', () => {
      const lines = renderShellFooterSurface();
      const original = snapshotEncode('shell-footer', lines);

      // Append a spurious style record
      const mutated = original.replace(
        '@STYLES',
        '@STYLES\n0 0 fg=#deadff',
      );

      const diff = snapshotDiff('shell-footer', original, mutated);
      expect(diff).not.toBeNull();
      expect(diff).toContain('STYLE added');
    });

    test('snapshotDiff returns null for identical snapshots', () => {
      const lines = renderShellFooterSurface();
      const snap = snapshotEncode('shell-footer', lines);
      expect(snapshotDiff('shell-footer', snap, snap)).toBeNull();
    });
  });
});
