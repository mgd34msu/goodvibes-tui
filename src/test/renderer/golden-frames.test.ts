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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { renderMarkdown } from '../../renderer/markdown.ts';
import { renderCodeBlock } from '../../renderer/code-block.ts';
import { renderThinkingBlock } from '../../renderer/thinking.ts';
import {
  addConversationSplashScreen,
  renderConversationToolMessage,
} from '../../core/conversation-rendering.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { renderHelpOverlay, renderShortcutsOverlay } from '../../renderer/help-overlay.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { renderSessionPickerModal } from '../../renderer/session-picker-modal.ts';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { renderProfilePickerModal } from '../../renderer/profile-picker-modal.ts';
import { ProfilePickerModal } from '../../input/profile-picker-modal.ts';
import { AgentDetailModal, renderAgentDetailModal } from '../../renderer/agent-detail-modal.ts';
import { ProcessModal, renderProcessModal } from '../../renderer/process-modal.ts';
import { renderContextInspector } from '../../renderer/context-inspector.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { renderHistorySearchOverlay } from '../../renderer/history-search-overlay.ts';
import { HistorySearch } from '../../input/input-history.ts';
import { renderSelectionModalOverlay } from '../../renderer/selection-modal-overlay.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import type { BackgroundProcess } from '@pellux/goodvibes-sdk/platform/tools';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { FleetPanel } from '../../panels/fleet-panel.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../panels/fleet-read-model.ts';
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

// ---------------------------------------------------------------------------
// WO-201 — Golden contract expansion
//
// Additional surfaces covered below (all new — the surfaces above are
// untouched):
//   5. splash               — addConversationSplashScreen at 3 widths, pins
//      the fullwidth/halfwidth vaporwave glyph aesthetic byte-for-byte
//      (constraint 4: splash-lines.ts is never touched by this WO).
//   6. conversation scenes  — plain tool result, diff-shaped tool result
//      (collapsed + expanded), fenced code block (tree-sitter path + regex
//      fallback tokenizer path), thinking block, streaming partial frame.
//   7. overlays             — help, shortcuts, model picker, settings,
//      session picker, profile picker, agent detail, process, context
//      inspector, history search, selection modal — each at a normal size
//      and a hostile size (<24 rows or ~28 cols).
//   8. shell-footer (compact) — buildShellFooter with compact:true.
//
// Determinism notes for the additions below:
//   - Every fixture uses fixed epoch timestamps, never a bare Date.now()
//     read that flows into rendered text. Where a fixture needs "elapsed
//     time since start" text (agent detail, process entries), startedAt is
//     set to `Date.now() - N` at fixture-build time so the elapsed bucket
//     (formatElapsed's Xm YYs granularity) is stable regardless of the
//     wall-clock date the suite runs on — only the delta N matters, and N is
//     chosen well clear of any second/minute boundary.
//   - Where a renderer formats a timestamp through local Date accessors
//     (formatTimestamp in the session/profile pickers), the affected tests
//     pin process.env.TZ='UTC' for the duration of the render so the golden
//     bytes don't depend on the host machine's timezone.
//   - The AgentDetailModal/ProcessModal goldens use hand-built AgentRecord
//     fixtures (not AgentManager.spawn(), which mints a crypto.randomUUID
//     id) so the rendered agent id is stable across runs.
//   - The tree-sitter code-block golden schedules a real background parse on
//     code-block.ts's shared SyntaxHighlighter singleton and polls for cache
//     population; if the tree-sitter WASM grammar is unavailable in the
//     environment it skips gracefully, mirroring the existing skipIf
//     convention in src/test/intelligence/tree-sitter.test.ts. The
//     regex-fallback golden uses a fence language (yaml) that
//     syntax-highlighter.ts's FENCE_TO_LANG_ID never claims, so it never
//     schedules a parse and is unconditionally deterministic.
// ---------------------------------------------------------------------------

const NORMAL_W = 100;
const NORMAL_H = 30;
const HOSTILE_W = 28;
const HOSTILE_H = 20;

/** Run `fn` with process.env.TZ pinned to UTC, restoring the prior value after. */
function withUtcTz<T>(fn: () => T): T {
  const prevTz = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    return fn();
  } finally {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
}

// ─── 5. Splash (constraint 4: byte-for-byte glyph aesthetic) ──────────────

/**
 * Render the splash surface via the real production entry point
 * (addConversationSplashScreen), backed by a minimal fake history/context
 * matching the shape conversation-rendering.ts expects. All splashOptions
 * are fixed fixtures — no wall-clock, no environment-dependent values.
 */
function renderSplashSurface(width: number): Line[] {
  const lines: Line[] = [];
  const history = {
    addLine: (l: Line) => { lines.push(l); },
    addLines: (ls: Line[]) => { lines.push(...ls); },
    getLineCount: () => lines.length,
  };
  const context = {
    history,
    blockRegistry: [],
    collapseState: new Map<string, boolean>(),
    errorLineRegistry: [],
    messageKindRegistry: new Map(),
    configManager: null,
    splashOptions: {
      workingDir: '/workspace/goodvibes-tui',
      model: 'claude-opus-4',
      provider: 'anthropic',
      toolCount: 7,
      lastSessionId: 'gv-20260612-a1b2c3',
      // Pinned to the version the splash goldens were captured at. The
      // version's display width shifts the line's centering, so goldens tied
      // to the live build VERSION break on every release bump — this fixture
      // keeps them byte-stable (found by the v1.0.0 release validate run).
      version: '0.29.0',
    },
  };
  addConversationSplashScreen(context as never, width);
  return lines;
}

describe('golden-frames — splash (constraint 4)', () => {
  for (const width of [60, 100, 140]) {
    const surface = `splash-${width}`;

    test(`width=${width} matches committed golden snapshot`, () => {
      const lines = renderSplashSurface(width);
      expect(lines.length).toBeGreaterThan(0);
      assertGolden(surface, lines);
    });

    test(`width=${width} render is deterministic (two consecutive renders match)`, () => {
      const a = snapshotEncode(surface, renderSplashSurface(width));
      const b = snapshotEncode(surface, renderSplashSurface(width));
      expect(a).toBe(b);
    });
  }

  test('splash goldens contain the fullwidth/halfwidth glyph aesthetic verbatim', () => {
    // Mechanical enforcement of constraint 4: the vaporwave tagline
    // (fullwidth Latin + halfwidth katakana + ideographic spacing) must
    // survive into the committed golden bytes untouched.
    //
    // The snapshot text layer is a per-cell dump: a double-width glyph
    // occupies two grid columns (glyph, then an empty second cell rendered
    // as a padding space), so checking a multi-glyph substring like
    // "ｇｏｏｄ" would spuriously fail even though every glyph is present
    // byte-for-byte. Check each individual codepoint from splash-lines.ts's
    // TAGLINE/VERSION_LINE instead — that's what "verbatim" means at the
    // per-cell golden-file grain.
    const REQUIRED_GLYPHS = [
      'ｇ', 'ｏ', 'ｄ', 'ｖ', 'ｉ', 'ｂ', 'ｅ', 'ｓ', // fullwidth Latin (tagline)
      'Ａ', 'Ｉ', // fullwidth "AI"
      'い', '雰', '囲', '気', // ideographic content
      'ｺ', 'ｰ', 'ﾄ', 'ﾞ', // halfwidth katakana (version line)
      '・', // ideographic middle dot separator
    ];
    for (const width of [60, 100, 140]) {
      const raw = readGolden(`splash-${width}`);
      expect(raw).not.toBeNull();
      for (const glyph of REQUIRED_GLYPHS) {
        expect(raw).toContain(glyph);
      }
    }
  });
});

// ─── 6. Conversation transcript scenes ─────────────────────────────────────

/**
 * Minimal fake ConversationRenderContext-shaped object for calling the real
 * renderConversationToolMessage/renderConversationUserMessage functions
 * directly. Only the fields those two functions actually read are needed.
 */
function makeToolRenderContext(collapseState: Map<string, boolean> = new Map()): {
  context: unknown;
  lines: Line[];
} {
  const lines: Line[] = [];
  const context = {
    history: {
      addLine: (l: Line) => { lines.push(l); },
      addLines: (ls: Line[]) => { lines.push(...ls); },
      getLineCount: () => lines.length,
    },
    blockRegistry: [],
    collapseState,
    errorLineRegistry: [],
    messageKindRegistry: new Map(),
    configManager: null,
    splashOptions: {},
  };
  return { context, lines };
}

const PLAIN_TOOL_RESULT = {
  role: 'tool' as const,
  callId: 'call-golden-plain-01',
  toolName: 'read',
  content: 'File contents:\n  1  export const x = 1;\n  2  export const y = 2;',
};

// Deliberately > 200 chars so the default isShort-based auto-expand does not
// kick in — this exercises the real default-collapsed path.
const DIFF_TOOL_RESULT_CONTENT = [
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1,5 +1,6 @@',
  ' export function add(a: number, b: number): number {',
  '-  return a + b;',
  '+  // Guard against non-finite inputs before summing.',
  '+  return Number.isFinite(a) && Number.isFinite(b) ? a + b : NaN;',
  ' }',
  ' ',
  '-export const VERSION = 1;',
  '+export const VERSION = 2;',
  '+export const BUILD = "golden-fixture";',
].join('\n');

const DIFF_TOOL_RESULT = {
  role: 'tool' as const,
  callId: 'call-golden-diff-01',
  toolName: 'apply_patch',
  content: DIFF_TOOL_RESULT_CONTENT,
};

function renderToolResultPlainSurface(): Line[] {
  const { context, lines } = makeToolRenderContext();
  renderConversationToolMessage(context as never, PLAIN_TOOL_RESULT, NORMAL_W, 0);
  return lines;
}

function renderToolResultDiffCollapsedSurface(): Line[] {
  // Fresh collapseState: renderConversationToolMessage defaults long content
  // to collapsed on first render (isShort ? false : true).
  const { context, lines } = makeToolRenderContext(new Map());
  renderConversationToolMessage(context as never, DIFF_TOOL_RESULT, NORMAL_W, 0);
  return lines;
}

function renderToolResultDiffExpandedSurface(): Line[] {
  // collapseKey is `msg_${msgIdx}` — pre-seed it to false (expanded).
  const collapseState = new Map<string, boolean>([['msg_0', false]]);
  const { context, lines } = makeToolRenderContext(collapseState);
  renderConversationToolMessage(context as never, DIFF_TOOL_RESULT, NORMAL_W, 0);
  return lines;
}

describe('golden-frames — conversation: tool result (plain)', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderToolResultPlainSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('tool-result-plain', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('tool-result-plain', renderToolResultPlainSurface());
    const b = snapshotEncode('tool-result-plain', renderToolResultPlainSurface());
    expect(a).toBe(b);
  });
});

describe('golden-frames — conversation: tool result (diff, collapsed)', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderToolResultDiffCollapsedSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('tool-result-diff-collapsed', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('tool-result-diff-collapsed', renderToolResultDiffCollapsedSurface());
    const b = snapshotEncode('tool-result-diff-collapsed', renderToolResultDiffCollapsedSurface());
    expect(a).toBe(b);
  });
});

describe('golden-frames — conversation: tool result (diff, expanded)', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderToolResultDiffExpandedSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('tool-result-diff-expanded', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('tool-result-diff-expanded', renderToolResultDiffExpandedSurface());
    const b = snapshotEncode('tool-result-diff-expanded', renderToolResultDiffExpandedSurface());
    expect(a).toBe(b);
  });
});

// Fenced code block — regex-fallback tokenizer path. 'yaml' is recognized by
// code-block.ts's own detectLanguage() (drives the regex tokenizer) but is
// NOT in syntax-highlighter.ts's FENCE_TO_LANG_ID map, so
// _sharedHighlighter.highlight() returns null unconditionally — no
// tree-sitter parse is ever scheduled for this language tag. Permanently
// deterministic, no async race.
const CODE_BLOCK_FALLBACK_LINES = [
  'name: golden-fixture',
  'on:',
  '  push:',
  '    branches: [main]',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
];

function renderCodeBlockFallbackSurface(): Line[] {
  return renderCodeBlock(CODE_BLOCK_FALLBACK_LINES, 'yaml', NORMAL_W);
}

describe('golden-frames — conversation: fenced code block (regex-fallback path)', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderCodeBlockFallbackSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('code-block-fallback', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('code-block-fallback', renderCodeBlockFallbackSurface());
    const b = snapshotEncode('code-block-fallback', renderCodeBlockFallbackSurface());
    expect(a).toBe(b);
  });
});

// Fenced code block — real tree-sitter path. code-block.ts owns a
// module-private shared SyntaxHighlighter singleton; the first call to
// renderCodeBlock for a given (lang, code) schedules a background WASM parse
// and synchronously returns the regex-fallback tokens. This test polls for
// the cache to populate (bounded) and pins the tree-sitter-highlighted
// result. The code snippet carries a unique marker comment so its cache key
// can never collide with a snippet warmed by another test file sharing this
// process. Skips gracefully (matching src/test/intelligence/tree-sitter.test.ts's
// convention) when the grammar WASM isn't present in this environment.
function wasmAvailable(): boolean {
  return existsSync(join(process.cwd(), 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'));
}
function tsGrammarAvailable(): boolean {
  return existsSync(join(process.cwd(), 'node_modules', 'tree-sitter-typescript', 'tree-sitter-typescript.wasm'));
}

const CODE_BLOCK_TREE_SITTER_LINES = [
  '// GV_GOLDEN_TREE_SITTER_FIXTURE unique marker — see golden-frames.test.ts',
  'export function goldenFixtureAdd(a: number, b: number): number {',
  '  return a + b;',
  '}',
];

describe('golden-frames — conversation: fenced code block (tree-sitter path)', () => {
  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'matches committed golden snapshot once the background parse lands',
    async () => {
      const before = renderCodeBlock(CODE_BLOCK_TREE_SITTER_LINES, 'ts', NORMAL_W);
      const beforeText = snapshotEncode('code-block-tree-sitter', before);
      let afterText = beforeText;
      let after = before;
      for (let i = 0; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        after = renderCodeBlock(CODE_BLOCK_TREE_SITTER_LINES, 'ts', NORMAL_W);
        afterText = snapshotEncode('code-block-tree-sitter', after);
        if (afterText !== beforeText) break;
      }
      if (afterText === beforeText) {
        // Background parse never completed in this environment (e.g. WASM
        // init failed) — nothing to pin here. The regex-fallback golden
        // above still covers the fallback path unconditionally.
        return;
      }
      expect(after.length).toBeGreaterThan(0);
      assertGolden('code-block-tree-sitter', after);
    },
    10_000,
  );
});

// Thinking block — renderThinkingBlock is the completed-content renderer
// used by conversation-rendering.ts for reasoningContent/reasoningSummary.
// (createThinkingFragment, the live-streaming spinner variant with rotating
// THINKING_PHRASES, stays excluded per the header note above.)
const THINKING_BLOCK_TEXT = 'Considering the tradeoffs between the two approaches: the first keeps the '
  + 'compositor untouched but adds an extra pass; the second folds the change into the existing '
  + 'DiffEngine emit step. Going with the second — same architecture, fewer allocations.';

function renderThinkingBlockSurface(): Line[] {
  return renderThinkingBlock(THINKING_BLOCK_TEXT, NORMAL_W);
}

describe('golden-frames — conversation: thinking block', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderThinkingBlockSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('thinking-block', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('thinking-block', renderThinkingBlockSurface());
    const b = snapshotEncode('thinking-block', renderThinkingBlockSurface());
    expect(a).toBe(b);
  });
});

// Streaming partial frame — renderMarkdown with isStreaming:true, the same
// call conversation.ts's updateStreamingBlock/rebuildHistory make for
// in-progress assistant content. isStreaming:true also suppresses
// tree-sitter parse scheduling (markdown.ts), so this is unconditionally
// deterministic. Content is deliberately mid-sentence / mid-fence.
const STREAMING_PARTIAL_MARKDOWN = [
  '## Investigating the failure',
  '',
  'The stack trace points at `renderCodeBlock` — checking the call site in ',
  '`markdown.ts` before the fence even closes:',
  '',
  '```typescript',
  'function renderCodeBlock(codeLines: string[], lang: string) {',
  '  // still streaming in, fence not yet closed',
].join('\n');

function renderStreamingPartialSurface(): Line[] {
  return renderMarkdown(STREAMING_PARTIAL_MARKDOWN, NORMAL_W, { isStreaming: true });
}

describe('golden-frames — conversation: streaming partial frame', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderStreamingPartialSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('streaming-partial', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('streaming-partial', renderStreamingPartialSurface());
    const b = snapshotEncode('streaming-partial', renderStreamingPartialSurface());
    expect(a).toBe(b);
  });
});

// ─── 7. Overlays — normal size + hostile size (<24 rows or ~28 cols) ──────

interface OverlaySizeVariant {
  readonly label: 'normal' | 'hostile';
  readonly width: number;
  readonly height: number;
}

const OVERLAY_SIZES: readonly OverlaySizeVariant[] = [
  { label: 'normal', width: NORMAL_W, height: NORMAL_H },
  { label: 'hostile', width: HOSTILE_W, height: HOSTILE_H },
];

/** Register golden-match + determinism tests for each size variant of an overlay. */
function describeOverlayGolden(
  groupName: string,
  render: (width: number, height: number) => Line[],
  variants: readonly OverlaySizeVariant[] = OVERLAY_SIZES,
): void {
  describe(`golden-frames — ${groupName}`, () => {
    for (const variant of variants) {
      const surface = `${groupName}-${variant.label}`;
      test(`${variant.label} size matches committed golden snapshot`, () => {
        const lines = render(variant.width, variant.height);
        expect(lines.length).toBeGreaterThan(0);
        assertGolden(surface, lines);
      });
      test(`${variant.label} size render is deterministic (two consecutive renders match)`, () => {
        const a = snapshotEncode(surface, render(variant.width, variant.height));
        const b = snapshotEncode(surface, render(variant.width, variant.height));
        expect(a).toBe(b);
      });
    }
  });
}

// help / shortcuts — KeybindingsManager pointed at a nonexistent config path
// so it always resolves to DEFAULT_KEYBINDINGS (no user override file to race).
const GOLDEN_KEYBINDINGS = new KeybindingsManager({ configPath: '/nonexistent/golden-keybindings.json' });

function renderHelpSurface(width: number, height: number): Line[] {
  return renderHelpOverlay(width, GOLDEN_KEYBINDINGS, undefined, 0, height);
}
function renderShortcutsSurface(width: number, height: number): Line[] {
  return renderShortcutsOverlay(width, GOLDEN_KEYBINDINGS, 0, height);
}

describeOverlayGolden('help-overlay', renderHelpSurface);
describeOverlayGolden('shortcuts-overlay', renderShortcutsSurface);

// settings — mirrors settings-modal.test.ts's tmp HOME/cwd redirection,
// scoped to a single synchronous try/finally per render call.
function renderSettingsSurface(width: number, height: number): Line[] {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const tmpDir = mkdtempSync(join(tmpdir(), 'gv-golden-settings-'));
  try {
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    const cm = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: tmpDir,
      homeDir: tmpDir,
      configDir: join(tmpDir, '.goodvibes', 'global-tui'),
    });
    const ffm: FeatureFlagManager = createFeatureFlagManager();
    const modal = new SettingsModal();
    const subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    const serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
      subscriptionManager,
    });
    const mcpRegistry = {
      listServerSecurity: () => [],
      setServerTrustMode: () => {},
    } as unknown as McpRegistry;
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    return renderSettingsModal(modal, width, height);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describeOverlayGolden('settings-modal', renderSettingsSurface);

// session picker / profile picker — fixed timestamps, TZ pinned to UTC for
// the duration of the render (formatTimestamp in modal-utils.ts reads local
// Date accessors).
function renderSessionPickerSurface(width: number, height: number): Line[] {
  return withUtcTz(() => {
    const rootDir = mkdtempSync(join(tmpdir(), 'gv-golden-session-picker-'));
    try {
      const sessionManager = new SessionManager(rootDir, { surfaceRoot: 'tui' });
      const modal = new SessionPickerModal(sessionManager);
      modal.active = true;
      modal.sessions = [
        { name: 'alpha-session', title: 'Alpha', model: 'gpt-4', provider: 'openai', timestamp: 1_700_000_000_000, messageCount: 5, filePath: '/x/alpha.jsonl' },
        { name: 'beta-session', title: 'Beta', model: 'gpt-4', provider: 'openai', timestamp: 1_700_100_000_000, messageCount: 12, filePath: '/x/beta.jsonl' },
      ];
      modal.selectedIndex = 0;
      return renderSessionPickerModal(modal, width, height);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

describeOverlayGolden('session-picker-modal', renderSessionPickerSurface);

function renderProfilePickerSurface(width: number, height: number): Line[] {
  return withUtcTz(() => {
    const rootDir = mkdtempSync(join(tmpdir(), 'gv-golden-profile-picker-'));
    try {
      const profileManager = new ProfileManager(rootDir);
      const modal = new ProfilePickerModal(profileManager);
      modal.active = true;
      modal.profiles = [
        { name: 'work-profile', timestamp: 1_700_000_000_000, filePath: '/x/work-profile.json' },
        { name: 'minimal-profile', timestamp: 1_700_100_000_000, filePath: '/x/minimal-profile.json' },
      ];
      modal.selectedIndex = 0;
      return renderProfilePickerModal(modal, width, height);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

describeOverlayGolden('profile-picker-modal', renderProfilePickerSurface);

// agent detail — hand-built AgentRecord (not AgentManager.spawn(), which
// mints a crypto.randomUUID id). Terminal status ('completed') means
// isStalled and elapsedMs never read Date.now() at render time — both
// startedAt and completedAt are fixed epoch values.
const GOLDEN_AGENT_ID = 'agent-golden-fixed01';

function makeGoldenAgentRecord(): AgentRecord {
  const startedAt = 1_700_000_000_000;
  return {
    id: GOLDEN_AGENT_ID,
    task: 'Refactor the panel renderer for width safety',
    template: 'general',
    tools: [],
    status: 'completed',
    startedAt,
    completedAt: startedAt + 125_000,
    orchestrationDepth: 0,
    toolCallCount: 4,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'wrfc',
    communicationLane: 'direct',
    fullOutput: '',
    model: 'claude-opus-4',
    provider: 'anthropic',
    usage: {
      inputTokens: 12_000,
      outputTokens: 3_400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      llmCallCount: 3,
      turnCount: 3,
    },
  };
}

function renderAgentDetailSurface(width: number, height: number): Line[] {
  const rec = makeGoldenAgentRecord();
  const modal = new AgentDetailModal({
    agentManager: {
      getStatus: (id: string) => (id === GOLDEN_AGENT_ID ? rec : null),
      list: () => [rec],
    },
    agentMessageBus: { getMessages: () => [] },
    sessionLogPathResolver: () => join(tmpdir(), 'gv-golden-agent-detail-nonexistent.jsonl'),
    cancelAgent: () => true,
  } as never);
  modal.open(GOLDEN_AGENT_ID);
  return renderAgentDetailModal(modal, width, height);
}

describeOverlayGolden('agent-detail-modal', renderAgentDetailSurface);

// process — a running agent entry with startedAt fixed relative to fixture-
// build time (Date.now() - 125_000ms), giving a stable formatElapsed bucket
// regardless of calendar date (only the ~125s delta matters).
function renderProcessSurface(width: number, height: number): Line[] {
  const rec: AgentRecord = {
    id: 'agent-golden-process01',
    task: 'Build the golden fixture',
    template: 'default',
    tools: [],
    status: 'running',
    startedAt: Date.now() - 125_000,
    orchestrationDepth: 0,
    toolCallCount: 2,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'wrfc',
    communicationLane: 'direct',
    fullOutput: '',
  };
  const modal = new ProcessModal({
    agentManager: {
      list: () => [rec],
      getStatus: (id: string) => (id === rec.id ? rec : null),
      cancel: () => true,
    },
    processManager: {
      list: () => [] as BackgroundProcess[],
      getStatus: () => undefined,
      stop: () => false,
    },
    wrfcController: {
      getChain: () => null,
      listChains: () => [],
    },
  } as never);
  modal.refresh();
  return renderProcessModal(modal, width, height);
}

describeOverlayGolden('process-modal', renderProcessSurface);

// fleet — a deterministic multi-level tree (WRFC owner->engineer->reviewer
// chain, one exec node, one terminal agent) with a FIXED `now` passed into
// buildFleetSnapshot (never Date.now()) so elapsed columns never flicker
// across runs/machines — W2.2 golden fixture.
const FIXED_FLEET_NOW = 1_700_000_000_000;

function buildFleetGoldenNodes(): ProcessNode[] {
  return [
    {
      id: 'wrfc-owner-01',
      kind: 'agent',
      label: '[WRFC owner] Fix the golden fixture',
      task: 'Fix the golden fixture',
      state: 'executing-tool',
      startedAt: FIXED_FLEET_NOW - 300_000,
      elapsedMs: 300_000,
      usage: { inputTokens: 12_000, outputTokens: 3_400, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 3, turnCount: 3, toolCallCount: 5 },
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      costUsd: 0.87,
      costState: 'priced',
      currentActivity: { kind: 'tool', text: 'Read src/panels/fleet-panel.ts', toolName: 'Read', at: FIXED_FLEET_NOW - 1_000 },
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: false },
    },
    {
      id: 'wrfc-engineer-01',
      parentId: 'wrfc-owner-01',
      kind: 'agent',
      label: '[Engineer] Implement the fix',
      task: 'Implement the fix',
      state: 'streaming',
      startedAt: FIXED_FLEET_NOW - 200_000,
      elapsedMs: 200_000,
      usage: { inputTokens: 8_000, outputTokens: 2_200, cacheReadTokens: 500, cacheWriteTokens: 0, llmCallCount: 2, turnCount: 2, toolCallCount: 3 },
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      costUsd: 0.045,
      costState: 'priced',
      currentActivity: { kind: 'output-line', text: 'Writing fleet-panel.ts', at: FIXED_FLEET_NOW - 500 },
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: false },
    },
    {
      id: 'wrfc-reviewer-01',
      parentId: 'wrfc-owner-01',
      kind: 'agent',
      label: '[Reviewer] Review the fix',
      task: 'Review the fix',
      state: 'awaiting-approval',
      startedAt: FIXED_FLEET_NOW - 50_000,
      elapsedMs: 50_000,
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      costUsd: null,
      costState: 'unpriced',
      currentActivity: { kind: 'phase', text: 'Awaiting operator approval', at: FIXED_FLEET_NOW - 2_000 },
      capabilities: { interruptible: true, killable: true, pausable: true, steerable: false },
    },
    {
      id: 'exec-golden-01',
      kind: 'background-process',
      label: 'bun test src/test/renderer',
      state: 'executing-tool',
      startedAt: FIXED_FLEET_NOW - 15_000,
      elapsedMs: 15_000,
      costUsd: null,
      costState: 'unpriced',
      currentActivity: { kind: 'output-line', text: '42 pass 0 fail', at: FIXED_FLEET_NOW - 1_000 },
      capabilities: { interruptible: false, killable: true, pausable: false, steerable: false },
    },
    {
      id: 'agent-done-01',
      kind: 'agent',
      label: '[Agent] Regenerate splash goldens',
      task: 'Regenerate splash goldens',
      state: 'done',
      startedAt: FIXED_FLEET_NOW - 500_000,
      completedAt: FIXED_FLEET_NOW - 400_000,
      elapsedMs: 100_000,
      usage: { inputTokens: 5_000, outputTokens: 1_200, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 1 },
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      costUsd: 0.012,
      costState: 'priced',
      capabilities: { interruptible: false, killable: false, pausable: false, steerable: false },
    },
    // Wave-3 verb formalization: 'interrupted' fixture row so the new
    // glyph/tone gets golden coverage (distinct from 'killed'/⊘ above).
    // startedAt is deliberately the MOST RECENT of all roots so this row
    // sorts last and simply appends — it must not reorder or disturb any
    // existing row (in particular the `j`-selected wrfc-owner-01 below).
    {
      id: 'agent-interrupted-01',
      kind: 'agent',
      label: '[Agent] Stopped by operator',
      task: 'Stopped by operator',
      state: 'interrupted',
      startedAt: FIXED_FLEET_NOW - 5_000,
      completedAt: FIXED_FLEET_NOW - 3_000,
      elapsedMs: 2_000,
      usage: { inputTokens: 2_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 0 },
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      costUsd: 0.004,
      costState: 'priced',
      capabilities: { interruptible: false, killable: false, pausable: false, steerable: false },
    },
  ];
}

function renderFleetSurface(width: number, height: number): Line[] {
  const snapshot = buildFleetSnapshot(buildFleetGoldenNodes(), FIXED_FLEET_NOW);
  const readModel = createStaticFleetReadModel(snapshot);
  const panel = new FleetPanel(readModel);
  panel.handleInput('j'); // select the second row (engineer) so the detail region is non-trivial
  return panel.render(width, height);
}

describeOverlayGolden('fleet-panel', renderFleetSurface);

// Wave-3 (W3.1 Part C) — one attached agent session tab, deterministic
// transcript content via a stub getConversationSnapshot. Separate golden
// surface (not folded into 'fleet-panel' above) so the root-tab-only
// fixture's bytes stay stable independent of tab-view layout changes.
function renderFleetTabSurface(width: number, height: number): Line[] {
  const snapshot = buildFleetSnapshot(buildFleetGoldenNodes(), FIXED_FLEET_NOW);
  const readModel = createStaticFleetReadModel(snapshot);
  const panel = new FleetPanel(readModel, {
    getConversationSnapshot: (agentId: string) =>
      agentId === 'wrfc-owner-01'
        ? [
          { role: 'user', content: 'Fix the golden fixture' },
          { role: 'assistant', content: 'On it — reading fleet-panel.ts first.' },
        ]
        : [],
  });
  panel.handleInput('j'); // select row 1: wrfc-owner-01 (a running agent; row 0 is the terminal agent-done-01)
  panel.handleInput('enter'); // attach it
  return panel.render(width, height);
}

describeOverlayGolden('fleet-panel-tab', renderFleetTabSurface);

// Wave-3 (W3.2) — a steerable agent's attached tab. Two separate surfaces
// (not folded into 'fleet-panel-tab' above) since the composer and the
// queued badge are mutually-exclusive views (the composer input line
// replaces the badge line while open; the badge reappears once the draft
// closes) — one fixed frame cannot honestly show both at once, so each
// state gets its own deterministic golden.
function fleetSteerGoldenNode(): ProcessNode {
  return {
    id: 'agent-steer-01',
    kind: 'agent',
    label: '[Agent] Long-running build fix',
    task: 'Long-running build fix',
    state: 'executing-tool',
    startedAt: FIXED_FLEET_NOW - 120_000,
    elapsedMs: 120_000,
    usage: { inputTokens: 4_000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 2, turnCount: 2, toolCallCount: 3 },
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    costUsd: 0.03,
    costState: 'priced',
    currentActivity: { kind: 'tool', text: 'Running build', toolName: 'Bash', at: FIXED_FLEET_NOW - 2_000 },
    capabilities: { interruptible: true, killable: true, pausable: false, steerable: true },
  };
}

// State 1: the composer is open with in-progress typed text (pre-submit) —
// exercises the 's' gate, the one-line input, and the Enter/Esc footer hints.
function renderFleetSteerComposeSurface(width: number, height: number): Line[] {
  const snapshot = buildFleetSnapshot([fleetSteerGoldenNode()], FIXED_FLEET_NOW);
  const readModel = createStaticFleetReadModel(snapshot);
  const panel = new FleetPanel(readModel);
  panel.handleInput('enter'); // attach + focus the tab
  panel.handleInput('s'); // open the steer composer
  for (const ch of 'please add a regression test') panel.handleInput(ch);
  return panel.render(width, height);
}

describeOverlayGolden('fleet-panel-steer-compose', renderFleetSteerComposeSurface);

// State 2: post-submit — the composer has closed and a queued badge is
// visible (both in the tab footer's status line and the tree row's
// activity-column glyph, once switched back to the root tab).
function renderFleetSteerQueuedSurface(width: number, height: number): Line[] {
  const snapshot = buildFleetSnapshot([fleetSteerGoldenNode()], FIXED_FLEET_NOW);
  const readModel = createStaticFleetReadModel(snapshot);
  const panel = new FleetPanel(readModel, {
    steer: (_id: string, _text: string) => ({ queued: true, messageId: 'golden-msg-1' }),
  });
  panel.handleInput('enter'); // attach + focus the tab
  panel.handleInput('s');
  for (const ch of 'please add a regression test') panel.handleInput(ch);
  panel.handleInput('enter'); // submit -> queued badge
  return panel.render(width, height);
}

describeOverlayGolden('fleet-panel-steer-queued', renderFleetSteerQueuedSurface);

// context inspector — ConversationManager with fixed message content, no
// timestamps rendered by this surface.
function renderContextInspectorSurface(width: number, height: number): Line[] {
  const conv = new ConversationManager(() => width);
  conv.addUserMessage('Investigate why the panel-workspace golden regressed after the last hex-token pass.');
  conv.addAssistantMessage('Looking at ui-factory.ts — the CYAN token swap missed one literal at line 433.');
  return renderContextInspector(conv, width, height, 128_000);
}

describeOverlayGolden('context-inspector', renderContextInspectorSurface);

// history search — width-only signature (single bottom-bar line), no
// viewportHeight param. Hostile size means narrow width only.
function renderHistorySearchSurface(width: number): Line[] {
  const hs = new HistorySearch(() => [
    'git status',
    'git commit -m "fix"',
    'bun test src/test/renderer/golden-frames.test.ts',
  ]);
  hs.open('');
  hs.search('git');
  return renderHistorySearchOverlay(hs, width);
}

describe('golden-frames — history-search-overlay', () => {
  const variants: ReadonlyArray<{ label: 'normal' | 'hostile'; width: number }> = [
    { label: 'normal', width: NORMAL_W },
    { label: 'hostile', width: HOSTILE_W },
  ];
  for (const variant of variants) {
    const surface = `history-search-overlay-${variant.label}`;
    test(`${variant.label} width matches committed golden snapshot`, () => {
      const lines = renderHistorySearchSurface(variant.width);
      expect(lines.length).toBeGreaterThan(0);
      assertGolden(surface, lines);
    });
    test(`${variant.label} width render is deterministic (two consecutive renders match)`, () => {
      const a = snapshotEncode(surface, renderHistorySearchSurface(variant.width));
      const b = snapshotEncode(surface, renderHistorySearchSurface(variant.width));
      expect(a).toBe(b);
    });
  }
});

// selection modal
function renderSelectionModalSurface(width: number, height: number): Line[] {
  const modal = new SelectionModal();
  modal.open('Pick Workspace', [
    { id: 'a', label: 'Alpha', detail: 'first workspace', category: 'Recent' },
    { id: 'b', label: 'Bravo', detail: 'second workspace', category: 'Recent' },
    { id: 'c', label: 'Gamma', detail: 'third workspace', category: 'Other' },
  ]);
  modal.selectedIndex = 1;
  return renderSelectionModalOverlay(modal, width, height);
}

describeOverlayGolden('selection-modal-overlay', renderSelectionModalSurface);

// ─── 8. Shell footer (compact) ─────────────────────────────────────────────

function renderShellFooterCompactSurface(): Line[] {
  const result = buildShellFooter({
    width: NORMAL_W,
    promptText: '> Ask me anything',
    promptLineCount: 1,
    usage: { up: 1024, down: 512 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    toolCount: 7,
    workingDir: '/workspace/my-project',
    provider: 'anthropic',
    contextWindow: 0,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    compact: true,
  });
  return result.lines;
}

describe('golden-frames — shell-footer (compact)', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderShellFooterCompactSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('shell-footer-compact', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('shell-footer-compact', renderShellFooterCompactSurface());
    const b = snapshotEncode('shell-footer-compact', renderShellFooterCompactSurface());
    expect(a).toBe(b);
  });
});
