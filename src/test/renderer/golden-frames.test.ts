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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import type { GitHeaderInfo } from '../../renderer/git-status.ts';
import { renderMarkdown } from '../../renderer/markdown.ts';
import { renderCodeBlock } from '../../renderer/code-block.ts';
import { renderThinkingBlock } from '../../renderer/thinking.ts';
import {
  addConversationSplashScreen,
  renderConversationAssistantMessage,
  renderConversationToolMessage,
} from '../../core/conversation-rendering.ts';
import type { AssistantTurnMembership } from '../../core/conversation-turn-structure.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { renderHelpOverlay, renderShortcutsOverlay } from '../../renderer/help-overlay.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { renderSessionPickerModal } from '../../renderer/session-picker-modal.ts';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { renderProfilePickerModal } from '../../renderer/profile-picker-modal.ts';
import { ProfilePickerModal } from '../../input/profile-picker-modal.ts';
import { renderContextInspector } from '../../renderer/context-inspector.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { renderHistorySearchOverlay } from '../../renderer/history-search-overlay.ts';
import { HistorySearch } from '../../input/input-history.ts';
import { renderSelectionModalOverlay } from '../../renderer/selection-modal-overlay.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { buildFirstOpenItems } from '../../cli/tui-startup.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { FleetPanel } from '../../panels/fleet-panel.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../panels/fleet-read-model.ts';
import { ConfigModal } from '../../input/config-modal.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import type { ConfigModalView } from '../../input/config-modal-types.ts';
import { statusGlyph, toneStyle, pad, postureLine, kv } from '../../panels/modals/modal-surface-helpers.ts';
import { setActiveThemeMode } from '../../renderer/theme.ts';
import { PermissionPromptUI } from '../../permissions/prompt.ts';
import type { PermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { resolveApprovalRequester } from '../../permissions/hunk-selection.ts';
import { ModalFactory } from '../../renderer/modal-factory.ts';
import type { Cell, Line } from '../../types/grid.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

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
// — Golden contract expansion
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
function makeToolRenderContext(
  collapseState: Map<string, boolean> = new Map(),
  assistantTurns?: ReadonlyMap<number, AssistantTurnMembership>,
): {
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
    assistantTurns,
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

// Folded tool-result group — a run of >=2 consecutive tool-result messages
// sharing one assistant turn, consolidated under one collapsible header (see
// conversation-turn-structure.ts). Both messages are rendered through the real
// renderConversationToolMessage, with a hand-built membership map standing in
// for what computeAssistantTurnMembership would have produced for this pair.
const GROUP_TOOL_RESULT_A = {
  role: 'tool' as const,
  callId: 'call-golden-group-01',
  toolName: 'read',
  content: 'File contents:\n  1  export const x = 1;',
};
const GROUP_TOOL_RESULT_B = {
  role: 'tool' as const,
  callId: 'call-golden-group-02',
  toolName: 'write',
  content: 'Wrote 3 lines to output.ts',
};
// Both results belong to one assistant turn. Unlike the retired folded-group
// model, turns default to EXPANDED — collapsing must never hide prose — so the
// collapsed surface below sets the turn key explicitly rather than relying on
// a default.
const TURN_MEMBER = {
  turnKey: 'turn_0',
  headIdx: 0,
  isHead: false,
  toolCallCount: 2,
  sharedToolLabel: undefined,
  hasReasoning: false,
  memberIndexes: [0],
  resultIndexes: [0, 1],
} as const;
const GROUP_MEMBERSHIP = new Map<number, AssistantTurnMembership>([
  [0, { ...TURN_MEMBER }],
  [1, { ...TURN_MEMBER }],
]);

/** The assistant message that owns the turn — it renders the header the
 *  collapsed surface is actually about. */
const TURN_HEAD_MESSAGE = {
  role: 'assistant' as const,
  content: '',
  model: 'test-model',
  provider: 'testprov',
  toolCalls: [
    { id: 'call-a', name: 'read', arguments: {} },
    { id: 'call-b', name: 'write', arguments: {} },
  ],
};
const TURN_HEAD_MEMBERSHIP = new Map<number, AssistantTurnMembership>([
  [0, { ...TURN_MEMBER, isHead: true }],
]);

function renderToolGroupCollapsedSurface(): Line[] {
  // A collapsed turn is header-only: the header states what is hidden, and no
  // result row renders. Rendering the head here (not just the results) is what
  // makes this golden capture the surface a user actually sees.
  const collapseState = new Map<string, boolean>([['turn_0', true]]);
  const { context, lines } = makeToolRenderContext(collapseState, TURN_HEAD_MEMBERSHIP);
  renderConversationAssistantMessage(context as never, TURN_HEAD_MESSAGE as never, NORMAL_W, 'off', 30, 0);
  const withResults = makeToolRenderContext(collapseState, GROUP_MEMBERSHIP);
  renderConversationToolMessage(withResults.context as never, GROUP_TOOL_RESULT_A, NORMAL_W, 0);
  renderConversationToolMessage(withResults.context as never, GROUP_TOOL_RESULT_B, NORMAL_W, 1);
  lines.push(...withResults.lines);
  return lines;
}

function renderToolGroupExpandedSurface(): Line[] {
  const collapseState = new Map<string, boolean>([['turn_0', false]]);
  const { context, lines } = makeToolRenderContext(collapseState, GROUP_MEMBERSHIP);
  renderConversationToolMessage(context as never, GROUP_TOOL_RESULT_A, NORMAL_W, 0);
  renderConversationToolMessage(context as never, GROUP_TOOL_RESULT_B, NORMAL_W, 1);
  return lines;
}

describe('golden-frames — conversation: assistant turn (collapsed)', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderToolGroupCollapsedSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('tool-group-collapsed', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('tool-group-collapsed', renderToolGroupCollapsedSurface());
    const b = snapshotEncode('tool-group-collapsed', renderToolGroupCollapsedSurface());
    expect(a).toBe(b);
  });
  test('a collapsed turn hides every result row it owns', () => {
    const { context, lines } = makeToolRenderContext(new Map([['turn_0', true]]), GROUP_MEMBERSHIP);
    renderConversationToolMessage(context as never, GROUP_TOOL_RESULT_A, NORMAL_W, 0);
    renderConversationToolMessage(context as never, GROUP_TOOL_RESULT_B, NORMAL_W, 1);
    // Neither result emits anything: the turn header (rendered by the
    // assistant message, not here) is the whole visible representation.
    expect(lines.length).toBe(0);
  });
});

describe('golden-frames — conversation: assistant turn (expanded)', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderToolGroupExpandedSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('tool-group-expanded', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('tool-group-expanded', renderToolGroupExpandedSurface());
    const b = snapshotEncode('tool-group-expanded', renderToolGroupExpandedSurface());
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
  const tmpDir = makeProjectTempDir('gv-golden-settings');
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
    const rootDir = makeProjectTempDir('gv-golden-session-picker');
    try {
      const sessionManager = new SessionManager(rootDir, { surface: makeTestSurface(rootDir) });
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
    const rootDir = makeProjectTempDir('gv-golden-profile-picker');
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

// retirement: the agent-detail-modal and process-modal golden surfaces
// (and their goldens) were removed — those modals were deleted once the F2
// repoint made them unreachable; the Fleet panel subsumes the live process
// tree (its own golden is defined below).

// fleet — a deterministic multi-level tree (WRFC owner->engineer->reviewer
// chain, one exec node, one terminal agent) with a FIXED `now` passed into
// buildFleetSnapshot (never Date.now()) so elapsed columns never flicker
// across runs/machines — golden fixture.
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
      capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
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
      capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
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
      capabilities: { interruptible: true, killable: true, pausable: true, resumable: false, steerable: false },
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
      capabilities: { interruptible: false, killable: true, pausable: false, resumable: false, steerable: false },
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
      capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    },
    // 'interrupted' fixture row so the new
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
      capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
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

// One attached agent session tab, deterministic
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

// A steerable agent's attached tab. Two separate surfaces
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
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true },
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

// — a terminal agent's tab whose full-fidelity snapshot is unavailable
// (evicted from the SDK's retention ring, or never registered), degraded to
// the on-disk ledger fallback. Attaches 'agent-done-01' (row 0 — the same
// terminal fixture node the base fleet-panel golden already uses) with
// getConversationSnapshot always empty, then populates the tab's
// ledgerEntries directly (bypassing the async fs read, same technique as
// fleet-panel.test.ts) so the golden is fully synchronous and deterministic.
function renderFleetLedgerTabSurface(width: number, height: number): Line[] {
  const snapshot = buildFleetSnapshot(buildFleetGoldenNodes(), FIXED_FLEET_NOW);
  const readModel = createStaticFleetReadModel(snapshot);
  const panel = new FleetPanel(readModel, {
    getConversationSnapshot: () => [], // evicted/never-registered — forces the ledger fallback
  });
  panel.handleInput('enter'); // row 0 is 'agent-done-01' (terminal) by default selection
  const tab = panel.getTabsState().tabs[0]!;
  tab.ledgerEntries = [
    { type: 'meta', agentId: 'agent-done-01', model: 'claude-haiku-4-5', provider: 'anthropic', title: '', timestamp: FIXED_FLEET_NOW - 500_000 },
    { type: 'session_config', task: 'Regenerate splash goldens', timestamp: FIXED_FLEET_NOW - 499_000 },
    { type: 'tool_execution', turn: 1, toolName: 'Bash', success: true, resultPreview: 'goldens regenerated: 12 files', timestamp: FIXED_FLEET_NOW - 450_000 },
    { type: 'session_end', status: 'completed', toolCallCount: 1, durationMs: 100_000, timestamp: FIXED_FLEET_NOW - 400_000 },
  ];
  tab.ledgerLoadStarted = true;
  return panel.render(width, height);
}

describeOverlayGolden('fleet-panel-ledger-tab', renderFleetLedgerTabSurface);

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

// Consequence-time trust modal — owner-hit defect: option descriptions were
// clipped to unreadability in this exact modal (back when it was also the
// combined first-open trust+register prompt; the registration half has
// since been dissolved — registration self-records instead, see
// tui-startup.ts). Rendered at a normal width and a narrow one, asserting
// every item's FULL detail text survives — never ellipsized, clipped, or
// overflow-hidden.
describe('golden-frames — consequence-time trust modal (full detail text never clipped)', () => {
  const widths: ReadonlyArray<{ readonly label: string; readonly width: number }> = [
    { label: 'normal', width: 80 },
    { label: 'narrow', width: 60 },
  ];

  const { title, items } = buildFirstOpenItems();
  for (const { label, width } of widths) {
    test(`trust prompt @ ${label} width (${width}x24): every item's full label and detail text render when reached`, () => {
      // Reaching an item is what matters — not whether every item is
      // simultaneously on screen without scrolling (a "(N below)" scroll
      // hint for the rest of the list is the intended, non-clipping
      // behavior when everything doesn't fit at once). Navigate the
      // selection to each item in turn and check that item's own full
      // label/detail is un-clipped at that point.
      for (let index = 0; index < items.length; index += 1) {
        const modal = new SelectionModal();
        modal.open(title, items, { allowSearch: false, primaryVerbLabel: 'Choose' });
        modal.selectedIndex = index;

        const text = renderSelectionModalOverlay(modal, width, 24)
          .map((line) => line.map((cell) => cell.char).join(''))
          .join(' ')
          .replace(/[│┌┐└┘├┤┬┴┼─]/g, ' ')
          .replace(/\s+/g, ' ');

        const item = items[index]!;
        expect(text).toContain(item.label);
        if (item.detail) expect(text).toContain(item.detail);
      }
    });
  }
});

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

// ─── 9. config-modal surfaces ──────────────────────────────────
//
// One normal+hostile golden pair per new MIGRATE-TO-MODAL surface. Each renders
// a fixed, representative ConfigModalView through the REAL config-modal host
// (ConfigModal + renderConfigModal + ModalFactory) — the same render path
// production uses — with row labels built from the same shared helpers the live
// surfaces use (statusGlyph/toneStyle/pad/postureLine/kv), so the pinned bytes
// are the surface's actual on-screen layout. Views are hand-built with frozen
// sample data (no wall-clock, no host/platform reads, no async) so the goldens
// are deterministic across machines; each surface's live buildView() derivation
// is covered by its own unit suite (config-modal-surfaces-*.test.ts). Justified
// per pair below as "new modal surface, migrated from panel <id>".

/** Open a fixed view on the real host (no onOpen → no live timers) and render. */
function renderConfigSurfaceGolden(view: ConfigModalView, width: number, height: number): Line[] {
  const modal = new ConfigModal();
  modal.open({ name: 'golden', title: view.title, buildView: () => view });
  return renderConfigModal(modal, width, height);
}

// services-modal — new modal surface, migrated from panel `services`.
const SERVICES_VIEW: ConfigModalView = {
  title: 'Services',
  tabs: [{
    id: 'services', label: 'Services',
    header: [postureLine([kv('services', 3), kv('healthy', 1), kv('errors', 1), kv('unconfigured', 1)])],
    rows: [
      { id: 'svc:github', label: `${statusGlyph('good')} ${pad('github', 16)} ${pad('HEALTHY', 13)} ${pad('bearer', 18)} https://api.github.com`, style: toneStyle('good') },
      { id: 'svc:linear', label: `${statusGlyph('dim')} ${pad('linear', 16)} ${pad('CONFIGURED', 13)} ${pad('api-key', 18)} https://api.linear.app`, style: toneStyle('warn') },
      { id: 'svc:stripe', label: `${statusGlyph('bad')} ${pad('stripe', 16)} ${pad('ERROR', 13)} ${pad('bearer', 18)} https://api.stripe.com`, style: toneStyle('bad') },
    ],
    emptyText: 'No services configured.',
  }],
};
describeOverlayGolden('services-modal', (w, h) => renderConfigSurfaceGolden(SERVICES_VIEW, w, h));

// subscription-modal — new modal surface, migrated from panel `subscription`.
const SUBSCRIPTION_VIEW: ConfigModalView = {
  title: 'Subscriptions',
  tabs: [{
    id: 'subscriptions', label: 'Subscriptions',
    header: [postureLine([kv('configured', 2), kv('active', 1), kv('pending', 0), kv('providers', 3)])],
    rows: [
      { id: 'sub:anthropic', label: `${statusGlyph('good')} ${pad('anthropic', 16)} ${pad('ACTIVE', 12)} oauth=yes  override=active`, style: toneStyle('good') },
      { id: 'sub:openai', label: `${statusGlyph('warn')} ${pad('openai', 16)} ${pad('AVAILABLE', 12)} oauth=yes  override=off`, style: toneStyle('info') },
      { id: 'sub:mistral', label: `${statusGlyph('dim')} ${pad('mistral', 16)} ${pad('UNCONFIGURED', 12)} oauth=no  override=off`, style: toneStyle('dim') },
    ],
    emptyText: 'No provider subscriptions yet.',
    hints: ['Enter sign in/out', 'r refresh'],
  }],
};
describeOverlayGolden('subscription-modal', (w, h) => renderConfigSurfaceGolden(SUBSCRIPTION_VIEW, w, h));

// remote-modal — new modal surface, migrated from panel `remote`.
const REMOTE_VIEW: ConfigModalView = {
  title: 'Remote',
  tabs: [
    {
      id: 'connections', label: 'Connections',
      header: [
        postureLine(['daemon CONNECTED', kv('running', 'yes'), kv('reconnects', 0), kv('jobs', 1)]),
        postureLine(['acp CONNECTED', kv('conns', 1), kv('contracts', 1), kv('artifacts', 0), kv('sessions', 0), kv('peers', '0/0')]),
      ],
      rows: [
        { id: 'conn:agent-1', label: `${statusGlyph('warn')} ${pad('agent-1', 20)} ${pad('DEGRADED', 14)} msgs=2 errs=1  worker`, style: toneStyle('warn') },
      ],
      emptyText: 'No active ACP or remote subagent connections.',
      hints: ['r recover'],
    },
    {
      id: 'contracts', label: 'Contracts',
      rows: [
        { id: 'contract:runner-1', label: `${statusGlyph('good')} ${pad('runner-1', 20)} ${pad('CONNECTED', 14)} default`, style: toneStyle('good') },
      ],
      emptyText: 'No registered remote runner contracts.',
      hints: ['r recover'],
    },
  ],
};
describeOverlayGolden('remote-modal', (w, h) => renderConfigSurfaceGolden(REMOTE_VIEW, w, h));

// providers-modal — new modal surface, migrated from panel `provider-health`
// (also the target of the providers/accounts redirects).
const PROVIDERS_VIEW: ConfigModalView = {
  title: 'Providers',
  tabs: [
    {
      id: 'health', label: 'Health',
      header: [postureLine([kv('providers', 2), kv('active', 1), kv('inspected', 2)])],
      rows: [
        { id: 'provider:anthropic', label: `${statusGlyph('good')} ${pad('anthropic', 18)} ${pad('ACTIVE', 8)} models=6`, style: toneStyle('good') },
        { id: 'provider:openai', label: `${statusGlyph('dim')} ${pad('openai', 18)} ${pad('idle', 8)} models=4`, style: toneStyle('dim') },
      ],
      hints: ['r refresh posture', '/health for latency & routes'],
    },
    {
      id: 'accounts', label: 'Accounts',
      rows: [
        { id: 'provider:anthropic', label: `${statusGlyph('good')} ${pad('anthropic', 18)} ${pad('ACTIVE', 8)} models=6`, style: toneStyle('good') },
        { id: 'provider:openai', label: `${statusGlyph('dim')} ${pad('openai', 18)} ${pad('idle', 8)} models=4`, style: toneStyle('dim') },
      ],
      hints: ['Enter repair', '/accounts routes <p> for detail'],
    },
  ],
};
describeOverlayGolden('providers-modal', (w, h) => renderConfigSurfaceGolden(PROVIDERS_VIEW, w, h));

// settings-sync-modal — new modal surface, migrated from panel `settings-sync`.
const SETTINGS_SYNC_VIEW: ConfigModalView = {
  title: 'Settings Sync',
  hints: ['←/→ tab'],
  tabs: [
    {
      id: 'keys', label: 'Keys',
      header: [
        postureLine([kv('resolved', 3), kv('conflicts', 1), kv('failures', 0), kv('locks', 1)]),
        postureLine([kv('local', 2), kv('synced', 1), kv('managed', 1), kv('last-sync', 'settings-sync/push'), kv('staged', 'none')]),
      ],
      rows: [
        { id: 'key:provider.model', label: `${pad('provider.model', 32)} ${pad('synced', 10)} claude-opus-4`, style: toneStyle('good') },
        { id: 'key:ui.theme', label: `${pad('ui.theme', 32)} ${pad('local', 10)} dark`, style: toneStyle('info') },
        { id: 'key:sandbox.vmBackend', label: `${pad('sandbox.vmBackend', 32)} ${pad('managed', 10)} qemu`, style: toneStyle('warn') },
      ],
      emptyText: 'No resolved settings entries.',
      hints: ['Enter resolve conflict', 'm managed review'],
    },
    { id: 'events', label: 'Events', rows: [], emptyText: 'No sync or managed-setting events recorded yet.' },
    { id: 'locks', label: 'Locks', rows: [], emptyText: 'No managed locks are currently active.' },
    { id: 'failures', label: 'Failures', rows: [], emptyText: 'No recent sync or managed-setting failures.' },
    { id: 'conflicts', label: 'Conflicts', rows: [], emptyText: 'No settings conflicts detected.' },
    { id: 'rollback', label: 'Rollback', rows: [], emptyText: 'No managed rollback records yet.' },
  ],
};
describeOverlayGolden('settings-sync-modal', (w, h) => renderConfigSurfaceGolden(SETTINGS_SYNC_VIEW, w, h));

// local-auth-modal — new modal surface, migrated from panel `local-auth`
// (browse view; the panel itself is kept as the masked password-entry host).
const LOCAL_AUTH_VIEW: ConfigModalView = {
  title: 'Local Auth',
  tabs: [{
    id: 'users', label: 'Users',
    header: [postureLine([kv('users', 2), kv('sessions', 1), kv('bootstrap', 'present')])],
    rows: [
      { id: 'user:admin', label: 'admin  admin' },
      { id: 'user:operator', label: 'operator  operator, viewer' },
    ],
    emptyText: 'No local auth users configured.',
    hints: ['a add user'],
  }],
};
describeOverlayGolden('local-auth-modal', (w, h) => renderConfigSurfaceGolden(LOCAL_AUTH_VIEW, w, h));

// sandbox-modal — new modal surface, migrated from panel `sandbox`.
const SANDBOX_VIEW: ConfigModalView = {
  title: 'Sandbox',
  tabs: [
    {
      id: 'profiles', label: 'Profiles',
      header: [postureLine([kv('platform', 'linux'), kv('backend', 'qemu'), kv('sessions', 1), kv('ready', 'yes')])],
      rows: [
        { id: 'profile:eval-py', label: `${pad('eval-py', 14)} ${pad('eval', 6)} ${pad('shared-vm', 10)} vm=yes` },
        { id: 'profile:mcp-node', label: `${pad('mcp-node', 14)} ${pad('mcp', 6)} ${pad('dedicated', 10)} vm=yes` },
      ],
      emptyText: 'No sandbox profiles available.',
      hints: ['s start'],
    },
    {
      id: 'sessions', label: 'Sessions',
      rows: [
        { id: 'session:sbx-01', label: `${statusGlyph('good')} ${pad('sbx-01', 20)} ${pad('RUNNING', 9)} backend=${pad('qemu', 6)} runs=3`, style: toneStyle('good') },
      ],
      emptyText: 'No active sandbox sessions.',
      hints: ['x stop', 'e execute probe'],
    },
  ],
};
describeOverlayGolden('sandbox-modal', (w, h) => renderConfigSurfaceGolden(SANDBOX_VIEW, w, h));

// ─── light-theme goldens (one transcript + one modal) ───────────────
//
// The existing goldens above are all dark (headless auto → dark). These two pin
// the LIGHT rendering of the two surfaces that actually swap tokens: the
// transcript (fully-designed light ThemeTokens — heading/code/link/etc.) and a
// ModalFactory modal (DEFAULT_STYLE.accentFg = state.info flips to the light
// chrome tone; the accent helper row exercises it). Both reuse render paths
// already proven deterministic in dark; underLight() flips the active mode for
// the render and ALWAYS restores dark so the surrounding dark goldens and sibling
// test files are untouched.
function renderModalFactoryLightSurface(): Line[] {
  return ModalFactory.createModal({
    title: 'Appearance',
    width: 60,
    sections: [{ type: 'text', content: 'Light theme rendered via ModalFactory.' }],
    helpers: [{ content: 'accent row (uses accentFg = state.info)', accent: true }],
    hints: ['Esc close'],
  }, NORMAL_W);
}
function underLight<T>(fn: () => T): T {
  setActiveThemeMode('light');
  try {
    return fn();
  } finally {
    setActiveThemeMode('dark');
  }
}

describe('golden-frames — light theme', () => {
  test('markdown transcript (light) matches committed golden snapshot', () => {
    const lines = underLight(() => renderMarkdownTranscriptSurface());
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('markdown-transcript-light', lines);
  });

  test('markdown transcript (light) is deterministic and differs from dark', () => {
    const a = snapshotEncode('markdown-transcript-light', underLight(() => renderMarkdownTranscriptSurface()));
    const b = snapshotEncode('markdown-transcript-light', underLight(() => renderMarkdownTranscriptSurface()));
    expect(a).toBe(b);
    const dark = snapshotEncode('markdown-transcript', renderMarkdownTranscriptSurface());
    expect(a).not.toBe(dark); // light tokens actually changed the styles
  });

  test('modal-factory modal (light) matches committed golden snapshot', () => {
    const lines = underLight(() => renderModalFactoryLightSurface());
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('modal-factory-light', lines);
  });

  test('modal-factory modal (light) is deterministic and differs from dark (accent flip)', () => {
    const a = snapshotEncode('modal-factory-light', underLight(() => renderModalFactoryLightSurface()));
    const b = snapshotEncode('modal-factory-light', underLight(() => renderModalFactoryLightSurface()));
    expect(a).toBe(b);
    const dark = snapshotEncode('modal-factory-light', renderModalFactoryLightSurface());
    expect(a).not.toBe(dark);
  });
});

// ─── ux/light-chrome — header/footer/thinking chrome flips with themeMode ──
//
// The persistent chrome (header + footer + live-thinking row) paints on the
// TRANSPARENT terminal background, so in light mode its foregrounds must invert
// toward dark to read on a light terminal. ui-factory.ts now reads the
// mode-resolved chrome tones (activeUiTones().chrome / .accent / .state) per
// render instead of the static dark UI_TONES. These fixtures pin the LIGHT
// rendering (chrome-light golden) and assert the flip is real while the DARK
// output is byte-identical to the pre-change dark path (proven both by the
// unchanged shell-footer/context-meter goldens above and by the dark-stability
// assertions here).
const CHROME_GIT: GitHeaderInfo = { branch: 'main', dirty: true, ahead: 0, behind: 0 };

// Version-decoupled goldens: the header embeds `v${VERSION}`, whose display width
// shifts the chrome layout, so a golden tied to the LIVE build VERSION breaks on
// every release bump (the documented version-fixture failure class — see the
// splash goldens' pinned `version` at the top of this file). Pin a fixture here
// so the chrome goldens are stable across bumps; the live header still renders
// the real VERSION in production (createHeader defaults to it).
const CHROME_FIXTURE_VERSION = '0.29.0';

function renderChromeHeaderFooterSurface(): Line[] {
  const header = UIFactory.createHeader(W, 'claude-opus-4', 'anthropic', 'Chrome golden', CHROME_GIT, CHROME_FIXTURE_VERSION);
  const footer = UIFactory.createFooter(
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
    true,           // dangerMode → chrome.bad banner
    60_000,         // lastInputTokens → 60% fill
    undefined,      // commandArgsHint
    undefined,      // hitlMode
    true,           // promptFocused
    'plan',         // composerMode → state.info
    'idle',         // composerStatus
    undefined,      // composerFlags
    'approval-wait',// composerPendingRisk → chrome.warn
    false,          // compact
  );
  return [...header, ...footer];
}

function renderChromeThinkingSurface(): Line[] {
  // frame=0 → phrase 'Thinking...' (no rotation); no elapsedMs/tokenSpeed so no
  // dynamic suffixes. inputTokens/outputTokens present → the 'out' segment
  // exercises accent.brand; the phrase gradient exercises accent.gradient*.
  return UIFactory.createThinkingFragment(W, '⠋', 0, undefined, undefined, 1000, 2000);
}

describe('golden-frames — chrome light/dark flip (ux/light-chrome)', () => {
  test('chrome (light) matches committed golden snapshot', () => {
    const lines = underLight(() => renderChromeHeaderFooterSurface());
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('chrome-light', lines);
  });

  test('chrome (light) is deterministic and differs from dark', () => {
    const a = snapshotEncode('chrome-light', underLight(() => renderChromeHeaderFooterSurface()));
    const b = snapshotEncode('chrome-light', underLight(() => renderChromeHeaderFooterSurface()));
    expect(a).toBe(b);
    const dark = snapshotEncode('chrome-light', renderChromeHeaderFooterSurface());
    expect(a).not.toBe(dark); // light chrome tones actually changed the styles
  });

  test('dark chrome is byte-identical across renders and unmoved by the wiring', () => {
    // The default active mode in the shared test process is dark; activeUiTones()
    // resolves to the UI_TONES constant the old static reads used, so the dark
    // output must be render-stable AND equal to the committed dark chrome golden.
    const a = snapshotEncode('chrome-dark', renderChromeHeaderFooterSurface());
    const b = snapshotEncode('chrome-dark', renderChromeHeaderFooterSurface());
    expect(a).toBe(b);
    assertGolden('chrome-dark', renderChromeHeaderFooterSurface());
  });

  test('each chrome surface (header/footer/thinking) flips its roles under light', () => {
    // Header: separator + version = chrome.faint (#475569 dark → #94a3b8 light);
    //         dirty git = chrome.warn (#f59e0b dark → #b45309 light).
    // Footer: DANGER banner = chrome.bad (#ef4444 dark → #dc2626 light);
    //         approval-wait risk = chrome.warn.
    // Thinking: 'out' token = accent.brand (#00ffff dark → #0077aa light).
    const headerDark = snapshotEncode('c-h', renderChromeHeaderFooterSurface());
    const thinkDark = snapshotEncode('c-t', renderChromeThinkingSurface());
    const headerLight = snapshotEncode('c-h', underLight(() => renderChromeHeaderFooterSurface()));
    const thinkLight = snapshotEncode('c-t', underLight(() => renderChromeThinkingSurface()));

    // Dark carries the pre-change dark tokens; light must differ everywhere.
    expect(headerLight).not.toBe(headerDark);
    expect(thinkLight).not.toBe(thinkDark);

    // Concrete role assertions — the exact hex must appear/disappear per mode.
    expect(headerDark).toContain('fg=#475569'); // chrome.faint (dark)
    expect(headerLight).toContain('fg=#94a3b8'); // chrome.faint (light)
    expect(headerDark).toContain('fg=#f59e0b'); // chrome.warn (dark, dirty git)
    expect(headerLight).toContain('fg=#b45309'); // chrome.warn (light)
    expect(headerDark).toContain('fg=#ef4444'); // chrome.bad (dark, DANGER)
    expect(headerLight).toContain('fg=#dc2626'); // chrome.bad (light)
    expect(thinkDark).toContain('fg=#00ffff'); // accent.brand (dark)
    expect(thinkLight).toContain('fg=#0077aa'); // accent.brand (light)

    // Restore is handled by underLight(); confirm the shared default is dark.
    const headerDarkAgain = snapshotEncode('c-h', renderChromeHeaderFooterSurface());
    expect(headerDarkAgain).toBe(headerDark);
  });
});

// ---------------------------------------------------------------------------
// Exec sandbox approval prompt — the named-escalation "Sandbox" row.
//
// When the sandbox-aware exec gate turns an auto-allow into an ask because the
// boundary-safe command still needs host access, the approval card renders a
// dedicated "Sandbox : wants network …" row. The escalation strings are the
// gate's annotation (verbatim from the SDK policy in production); hardcoded here
// so the golden tests the RENDERER, not the SDK policy wording.
// ---------------------------------------------------------------------------

function renderSandboxEscalationPromptSurface(): Line[] {
  setActiveThemeMode('dark');
  const request = {
    callId: 'call-golden-sandbox-01',
    tool: 'exec',
    args: { command: 'curl https://example.com/data' },
    category: 'execute',
    analysis: {
      classification: 'network',
      riskLevel: 'high',
      summary: 'Run a shell command that reaches the network',
      reasons: ['This command reaches outside the machine.'],
      host: 'example.com',
    },
    sandboxed: true,
    sandboxEscalations: ['wants network (not on egress allowlist — denied inside the boundary unless approved)'],
    resolve: () => {},
  } as unknown as PermissionRequest;
  return PermissionPromptUI.createPromptLines(NORMAL_W, request, undefined, true);
}

describe('golden-frames — permission prompt: exec sandbox escalation', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderSandboxEscalationPromptSurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('permission-prompt-sandbox-escalation', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('permission-prompt-sandbox-escalation', renderSandboxEscalationPromptSurface());
    const b = snapshotEncode('permission-prompt-sandbox-escalation', renderSandboxEscalationPromptSurface());
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Non-foreground approval attribution — the generic "Requested by: …" row for
// asks the SDK's approval broker attributes to an origin other than the
// foreground turn loop (see PermissionAttribution). Two new origins as of the
// 1.6.1 SDK: an MCP server's elicitation request, and a sandbox brokering a
// host-access escalation THROUGH the shared approval broker (distinct from
// the dedicated "Sandbox : wants …" row above, which is the TUI's own local
// exec-gate escalation UI, not a broker-routed ask).
// ---------------------------------------------------------------------------

function renderAttributedPromptSurface(attribution: Parameters<typeof resolveApprovalRequester>[2]): Line[] {
  setActiveThemeMode('dark');
  const request = {
    callId: 'call-golden-attribution-01',
    tool: 'read',
    args: { path: '/tmp/example.txt' },
    category: 'read',
    analysis: {
      classification: 'file-read',
      riskLevel: 'low',
      summary: 'Read a file',
      reasons: [],
    },
    attribution,
    resolve: () => {},
  } as unknown as PermissionRequest;
  const requestedBy = resolveApprovalRequester(undefined, request.callId, attribution) ?? undefined;
  return PermissionPromptUI.createPromptLines(NORMAL_W, request, undefined, false, requestedBy);
}

describe('golden-frames — permission prompt: mcp-server elicitation attribution', () => {
  function render(): Line[] {
    return renderAttributedPromptSurface({ kind: 'mcp-server', serverName: 'figma' });
  }
  test('matches committed golden snapshot', () => {
    const lines = render();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.map((c) => c.char).join('').includes('MCP server: figma'))).toBe(true);
    assertGolden('permission-prompt-mcp-server-attribution', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('permission-prompt-mcp-server-attribution', render());
    const b = snapshotEncode('permission-prompt-mcp-server-attribution', render());
    expect(a).toBe(b);
  });
});

describe('golden-frames — permission prompt: sandbox-escalation attribution (broker-routed)', () => {
  function render(): Line[] {
    return renderAttributedPromptSurface({ kind: 'sandbox-escalation', sandbox: 'exec-sandbox', escalations: ['wants-network'] });
  }
  test('matches committed golden snapshot', () => {
    const lines = render();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.map((c) => c.char).join('').includes('exec-sandbox wants: wants-network'))).toBe(true);
    assertGolden('permission-prompt-sandbox-escalation-attribution', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('permission-prompt-sandbox-escalation-attribution', render());
    const b = snapshotEncode('permission-prompt-sandbox-escalation-attribution', render());
    expect(a).toBe(b);
  });
});
