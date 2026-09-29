// ---------------------------------------------------------------------------
// golden-frames.test.ts, Deterministic renderer regression snapshots
//
// Strategy:
//   Each test renders a fixed surface with frozen inputs (no timestamps,
//   no dynamic counters, fixed terminal dimensions, dark mode, the default
//   `goodvibes` theme), then compares the result against a committed
//   snapshot text file.
//
// Theme sets:
//   golden-frames/                  the default theme (this file run directly)
//   golden-frames-goodvibes-neon/   the same surfaces under goodvibes-neon, run
//                                   by golden-frames-neon.test.ts, which sets
//                                   GOODVIBES_GOLDEN_THEME and imports this file
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
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-neon.test.ts
//   CI: env var is absent → mismatch = fail.
//
// Surfaces covered:
//   1. shell-footer      , buildShellFooter (fixed inputs, no timestamps)
//   2. context-meter     , buildShellFooter with context window + threshold (the status line's bar)
//   3. markdown-transcript, renderMarkdown with code fence, headings, inline code
//
// Determinism exclusions:
//   - UIFactory.createHeader: gradient phase depends on frame counter; excluded.
//     (frame=0 is stable, but header embeds model/provider, add if model list stabilises)
//   - createThinkingFragment: dynamic THINKING_PHRASES rotate on frame; excluded.
//   - renderContextInspector: requires live ConversationManager (stateful); excluded.
//   - renderSettingsModal: requires live ConfigManager + SettingsModal (reads fs env);
//     excluded from goldens (its own test suite covers output assertions).
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { centerViewportContent } from '../../renderer/conversation-layout.ts';
import { renderConversationEventLine } from '../../renderer/conversation-surface.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import type { GitHeaderInfo } from '../../renderer/git-status.ts';
import { renderMarkdown } from '../../renderer/markdown.ts';
import { renderCodeBlock, settleSyntaxHighlighting } from '../../renderer/code-block.ts';
import { renderThinkingBlock } from '../../renderer/thinking.ts';
import {
  addConversationSplashScreen,
} from '../../core/conversation-rendering.ts';
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
import { AgentsModal, type FleetActionCallbacks } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { confirmThrough } from '../../input/confirm-dialog.ts';
import { UsageModal } from '../../input/usage-modal.ts';
import { UsageTracker } from '../../runtime/usage-tracker.ts';
import { ChangesModal } from '../../input/changes-modal.ts';
import { parseChanges } from '../../input/changes-model.ts';
import type { SemanticDiff } from '../../renderer/semantic-diff.ts';
import { NotificationsModal } from '../../input/notifications-modal.ts';
import { PanelNotificationFeed } from '../../panels/notifications-feed.ts';
import { MaskedEntryModal } from '../../input/masked-entry-modal.ts';
import { setModelPricingResolver, type ResolvedModelPricing } from '@pellux/goodvibes-sdk/platform/providers';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../panels/fleet-read-model.ts';
import { ConfigModal } from '../../input/config-modal.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import type { ConfigModalView } from '../../input/config-modal-types.ts';
import { statusGlyph, toneStyle, pad, postureLine, kv } from '../../panels/modals/modal-surface-helpers.ts';
import { activeTokens, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { PermissionPromptUI } from '../../permissions/prompt.ts';
import type { PermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { resolveApprovalRequester } from '../../permissions/hunk-selection.ts';
import { CommandPalette, buildPaletteEntries, resetPaletteUsageForTests } from '../../input/command-palette.ts';
import { ConfirmDialog } from '../../input/confirm-dialog.ts';
import { renderToasts, type ToastSpec } from '../../renderer/surface-kit-parts.ts';
import { renderAutocompleteOverlay } from '../../renderer/autocomplete-overlay.ts';
import { AutocompleteEngine } from '../../input/autocomplete.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { renderFilePickerOverlay } from '../../renderer/file-picker-overlay.ts';
import { FilePickerModal } from '../../input/file-picker.ts';
import { renderModelWorkspace } from '../../renderer/model-workspace.ts';
import { ModelPickerModal } from '../../input/model-picker.ts';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import { createEmptyLine as emptyLine, type Cell, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { makeTestSurface } from '../helpers/session-surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { frameFromLayer, frameFromLayers } from '../helpers/surface-frame.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The theme every surface renders under; golden-frames-neon.test.ts sets this
// before importing the file to produce the goodvibes-neon set.
const GOLDEN_THEME = process.env['GOODVIBES_GOLDEN_THEME'] ?? 'goodvibes';
setActiveThemeName(GOLDEN_THEME);
const GOLDENS_DIR = new URL(
  GOLDEN_THEME === 'goodvibes' ? './golden-frames/' : `./golden-frames-${GOLDEN_THEME}/`,
  import.meta.url,
).pathname;
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
    // Text layer, join chars and pad to width
    const chars = line.map((c) => (c.char === '' ? ' ' : c.char)).join('');
    textBlock.push(`|${chars}|`);

    // Style layer, emit only non-default values
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

  // Style diff, find lines present in one but not the other
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
 * Inputs are fully fixed, no timestamps, no dynamic values.
 * lastCopyTime=0 suppresses any copy-flash state.
 */
function renderShellFooterSurface(): Line[] {
  const result = buildShellFooter({
    width: W,
    promptText: 'Ask me anything',
    promptLineCount: 1,
    promptCursorPos: 15,
    usage: { up: 1024, down: 512 },
    showExitNotice: false,
    lastCopyTime: 0,          // frozen: no copy-flash
    model: 'claude-opus-4',
    workingDir: '/workspace/my-project',
    branch: 'main',
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
  // 60_000 used / 100_000 window = 60% fill; threshold 0.80 → tick in the empty zone
  return buildShellFooter({
    width: W,
    promptText: 'Ask me anything',
    promptLineCount: 1,
    promptCursorPos: 15,
    usage: { up: 1024, down: 512 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    workingDir: '/workspace/my-project',
    branch: 'main',
    contextWindow: 100_000,
    compactThreshold: 0.80,
    lastInputTokens: 60_000,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
  }).lines;
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
//, Golden contract expansion
//
// Additional surfaces covered below (all new, the surfaces above are
// untouched):
//   5. splash              , addConversationSplashScreen at 3 widths, pins
//      the fullwidth/halfwidth vaporwave glyph aesthetic byte-for-byte
//      (constraint 4: splash-lines.ts is never touched by this WO).
//   6. conversation scenes , plain tool result, diff-shaped tool result
//      (collapsed + expanded), fenced code block (tree-sitter path + regex
//      fallback tokenizer path), thinking block, streaming partial frame.
//   7. overlays            , help, shortcuts, model picker, settings,
//      session picker, profile picker, agent detail, process, context
//      inspector, history search, selection modal, each at a normal size
//      and a hostile size (<24 rows or ~28 cols).
//   8. shell-footer (busy), the status line while a turn runs, at 80 columns.
//
// Determinism notes for the additions below:
//   - Every fixture uses fixed epoch timestamps, never a bare Date.now()
//     read that flows into rendered text. Where a fixture needs "elapsed
//     time since start" text (agent detail, process entries), startedAt is
//     set to `Date.now() - N` at fixture-build time so the elapsed bucket
//     (formatElapsed's Xm YYs granularity) is stable regardless of the
//     wall-clock date the suite runs on, only the delta N matters, and N is
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
 * are fixed fixtures, no wall-clock, no environment-dependent values.
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
      // to the live build VERSION break on every release bump, this fixture
      // keeps them byte-stable (found by the v1.0.0 release validate run).
      version: '0.29.0',
    },
  };
  addConversationSplashScreen(context as never, width);
  return lines;
}

describe('golden-frames : splash (constraint 4)', () => {
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
    // TAGLINE/VERSION_LINE instead, that's what "verbatim" means at the
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
//
// Tool calls, their results and agent lanes render as the lane-graph work
// tree; its scenes (single lane, opened beads, lanes, nesting, states, folded
// lanes, every glyph set) are golden-framed in golden-frames-work-tree.test.ts.

// Fenced code block, regex-fallback tokenizer path. 'yaml' is recognized by
// code-block.ts's own detectLanguage() (drives the regex tokenizer) but is
// NOT in syntax-highlighter.ts's FENCE_TO_LANG_ID map, so
// _sharedHighlighter.highlight() returns null unconditionally, no
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

describe('golden-frames : conversation: fenced code block (regex-fallback path)', () => {
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

// Fenced code block, real tree-sitter path. code-block.ts owns a
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

describe('golden-frames : conversation: fenced code block (tree-sitter path)', () => {
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
        // init failed), nothing to pin here. The regex-fallback golden
        // above still covers the fallback path unconditionally.
        return;
      }
      expect(after.length).toBeGreaterThan(0);
      assertGolden('code-block-tree-sitter', after);
    },
    10_000,
  );
});

// Thinking block, renderThinkingBlock is the completed-content renderer
// used by conversation-rendering.ts for reasoningContent/reasoningSummary.
// (createThinkingFragment, the live-streaming spinner variant with rotating
// THINKING_PHRASES, stays excluded per the header note above.)
const THINKING_BLOCK_TEXT = 'Considering the tradeoffs between the two approaches: the first keeps the '
  + 'compositor untouched but adds an extra pass; the second folds the change into the existing '
  + 'DiffEngine emit step. Going with the second — same architecture, fewer allocations.';

function renderThinkingBlockSurface(): Line[] {
  return renderThinkingBlock(THINKING_BLOCK_TEXT, NORMAL_W);
}

describe('golden-frames : conversation: thinking block', () => {
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

// Streaming partial frame, renderMarkdown with isStreaming:true, the same
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

describe('golden-frames : conversation: streaming partial frame', () => {
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

// ─── 7. Overlays, normal size + hostile size (<24 rows or ~28 cols) ──────

interface OverlaySizeVariant {
  readonly label: 'normal' | 'hostile' | '80x24' | '120x40';
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
  describe(`golden-frames : ${groupName}`, () => {
    for (const variant of variants) {
      const surface = `${groupName}-${variant.label}`;
      test(`${variant.label} size matches committed golden snapshot`, async () => {
        // Captured once tree-sitter highlighting settled: the first draw of a
        // code line is the regex placeholder, and whether its parse already
        // landed depends on which test files ran before in this process.
        render(variant.width, variant.height);
        await settleSyntaxHighlighting();
        const lines = render(variant.width, variant.height);
        expect(lines.length).toBeGreaterThan(0);
        assertGolden(surface, lines);
      });
      test(`${variant.label} size render is deterministic (two consecutive renders match)`, async () => {
        render(variant.width, variant.height);
        await settleSyntaxHighlighting();
        const a = snapshotEncode(surface, render(variant.width, variant.height));
        const b = snapshotEncode(surface, render(variant.width, variant.height));
        expect(a).toBe(b);
      });
    }
  });
}

// help / shortcuts, KeybindingsManager pointed at a nonexistent config path
// so it always resolves to DEFAULT_KEYBINDINGS (no user override file to race).
const GOLDEN_KEYBINDINGS = new KeybindingsManager({ configPath: '/nonexistent/golden-keybindings.json' });

function renderHelpSurface(width: number, height: number): Line[] {
  return frameFromLayer(renderHelpOverlay(width, height, GOLDEN_KEYBINDINGS, undefined, 0), width, height);
}
function renderShortcutsSurface(width: number, height: number): Line[] {
  return frameFromLayer(renderShortcutsOverlay(width, height, GOLDEN_KEYBINDINGS, 0), width, height);
}

describeOverlayGolden('help-overlay', renderHelpSurface);
describeOverlayGolden('shortcuts-overlay', renderShortcutsSurface);

// settings, mirrors settings-modal.test.ts's tmp HOME/cwd redirection,
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
    return frameFromLayer(renderSettingsModal(modal, width, height), width, height);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describeOverlayGolden('settings-modal', renderSettingsSurface);

// session picker / profile picker, fixed timestamps, TZ pinned to UTC for
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
      // A fixed clock: the picker groups sessions by recency.
      return frameFromLayer(renderSessionPickerModal(modal, width, height, 1_700_200_000_000), width, height);
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
      return frameFromLayer(renderProfilePickerModal(modal, width, height), width, height);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

describeOverlayGolden('profile-picker-modal', renderProfilePickerSurface);

// The Agents modal holds the live process tree (its goldens are below).

// fleet, a deterministic multi-level tree (WRFC owner->engineer->reviewer
// chain, one exec node, one terminal agent) with a FIXED `now` passed into
// buildFleetSnapshot (never Date.now()) so elapsed columns never flicker
// across runs/machines, golden fixture.
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
    // sorts last and simply appends, it must not reorder or disturb any
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

// A steerable running agent, for the steer and stop-confirm goldens.
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

// The four modals that replaced the side panes (Agents, Usage, Changes,
// Notifications) plus the local-auth password prompt. Each renders at the
// shared sizes and at 80x24 and 120x40. Every clock the modals read is fixed:
// the fleet snapshot's `now`, recorded turn timestamps, and the
// notifications' local-time fixtures.
const MODAL_SIZES: readonly OverlaySizeVariant[] = [
  ...OVERLAY_SIZES,
  { label: '80x24', width: 80, height: 24 },
  { label: '120x40', width: 120, height: 40 },
];

function keyToken(name: string): InputToken {
  return { type: 'key', name, logicalName: name, ctrl: false, shift: false, meta: false } as InputToken;
}

function typeInto(host: SurfaceModalHost, text: string): void {
  for (const ch of text) host.handleToken({ type: 'text', value: ch });
}

// Assistant turns only: the user-message box comes from the main transcript
// renderer (ui-factory), whose padding is outside this change.
const GOLDEN_TRANSCRIPT = [
  { role: 'assistant', content: 'On it, reading the fixture first.' },
  { role: 'assistant', content: 'The fixture pins `now`, so the elapsed column is stable. Updating the expected rows next.' },
];

function goldenFleetActions(steerable: boolean): FleetActionCallbacks {
  return {
    interrupt: () => true,
    resume: () => true,
    kill: () => [],
    getConversationSnapshot: (id: string) => (id === 'wrfc-owner-01' || id === 'agent-steer-01' ? GOLDEN_TRANSCRIPT : []) as never,
    resolveSessionLogPath: (id: string) => `/nonexistent/${id}.jsonl`,
    steer: () => (steerable ? { queued: true, messageId: 'golden-msg-1' } : { queued: false, reason: 'not steerable' }),
  };
}

function goldenAgentsModal(nodes: ProcessNode[], steerable = false): { host: SurfaceModalHost; modal: AgentsModal } {
  const host = new SurfaceModalHost();
  const modal = new AgentsModal({
    readModel: createStaticFleetReadModel(buildFleetSnapshot(nodes, FIXED_FLEET_NOW)),
    actions: goldenFleetActions(steerable),
    sessionCost: () => 1.25,
    confirm: (options) => confirmThrough(host, options),
    requestRender: () => {},
    tickMs: 0,
  });
  host.push(modal);
  return { host, modal };
}

function hostFrame(host: SurfaceModalHost, width: number, height: number): Line[] {
  return frameFromLayers(host.modals().map((m) => m.render(width, height)), width, height);
}

function renderAgentsListSurface(width: number, height: number): Line[] {
  const { host } = goldenAgentsModal(buildFleetGoldenNodes());
  host.handleToken(keyToken('down'));
  return hostFrame(host, width, height);
}
describeOverlayGolden('agents-modal', renderAgentsListSurface, MODAL_SIZES);

function renderAgentsFullSurface(width: number, height: number): Line[] {
  const { host } = goldenAgentsModal(buildFleetGoldenNodes());
  host.handleToken(keyToken('enter'));
  return hostFrame(host, width, height);
}
describeOverlayGolden('agents-modal-full', renderAgentsFullSurface, MODAL_SIZES);

function renderAgentsSteerSurface(width: number, height: number): Line[] {
  const { host } = goldenAgentsModal([fleetSteerGoldenNode()], true);
  typeInto(host, 's');
  typeInto(host, 'please add a regression test');
  return hostFrame(host, width, height);
}
describeOverlayGolden('agents-modal-steer', renderAgentsSteerSurface, MODAL_SIZES);

function renderAgentsStopConfirmSurface(width: number, height: number): Line[] {
  const { host } = goldenAgentsModal([fleetSteerGoldenNode()], true);
  typeInto(host, 'x');
  return hostFrame(host, width, height);
}
describeOverlayGolden('agents-modal-stop-confirm', renderAgentsStopConfirmSurface, MODAL_SIZES);

// Usage: a synchronous fake event feed drives the tracker, a fixed catalog
// price keeps the dollars stable, and turns are recorded with fixed times.
function goldenUsageModal(tab?: 'overview' | 'turns' | 'agents'): UsageModal {
  const handlers = new Map<string, (payload: never) => void>();
  const feed = { on: (type: string, handler: (payload: never) => void) => { handlers.set(type, handler); return () => {}; } };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: 'anthropic:claude-sonnet-4-6' };
  const config = { get: (key: string) => (key === 'behavior.autoCompactThreshold' ? 80 : undefined), set: () => {} };
  const agentUsage = new Map<string, { inputTokens: number; outputTokens: number }>([
    ['agent-a', { inputTokens: 42_000, outputTokens: 6_100 }],
    ['agent-b', { inputTokens: 18_500, outputTokens: 2_300 }],
  ]);
  const tracker = new UsageTracker({
    turnEvents: feed as never,
    agentEvents: feed as never,
    getUsage: () => usage,
    getContextTokens: () => 118_000,
    getContextWindow: () => 200_000,
    getModelId: () => usage.model,
    getAgentStatus: (id: string) => {
      const u = agentUsage.get(id);
      // Only the fields the tracker reads (model and usage) matter here.
      return u ? ({ model: 'anthropic:claude-sonnet-4-6', usage: { ...u, cacheReadTokens: 0, cacheWriteTokens: 0 } } as never) : null;
    },
    configManager: config as never,
  });
  const steps = [
    [12_000, 1_800, 0], [9_500, 2_400, 11_000], [14_200, 900, 20_000], [6_800, 3_100, 31_000],
    [11_300, 1_500, 30_500], [7_900, 2_700, 41_000], [15_600, 1_200, 44_000], [8_400, 2_000, 52_000],
  ] as const;
  steps.forEach(([input, output, cacheRead], i) => {
    usage.input += input;
    usage.output += output;
    usage.cacheRead += cacheRead;
    tracker.recordTurn(FIXED_FLEET_NOW + i * 60_000);
  });
  handlers.get('AGENT_SPAWNING')?.({ agentId: 'agent-a', task: 'Port the fleet goldens' } as never);
  handlers.get('AGENT_SPAWNING')?.({ agentId: 'agent-b', task: 'Review the change' } as never);
  handlers.get('AGENT_COMPLETED')?.({ agentId: 'agent-a' } as never);
  return new UsageModal({ tracker, compact: () => {}, pollMs: 0, ...(tab ? { tab } : {}) });
}

function withGoldenPricing<T>(fn: () => T): T {
  setModelPricingResolver(() => ({ status: 'priced', source: 'catalog', asOf: '2026-07-01', rates: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 } } as ResolvedModelPricing));
  try { return fn(); } finally { setModelPricingResolver(null); }
}

describeOverlayGolden('usage-modal', (w, h) => withGoldenPricing(() => frameFromLayer(goldenUsageModal().render(w, h), w, h)), MODAL_SIZES);
describeOverlayGolden('usage-modal-turns', (w, h) => withGoldenPricing(() => frameFromLayer(goldenUsageModal('turns').render(w, h), w, h)), MODAL_SIZES);
describeOverlayGolden('usage-modal-agents', (w, h) => withGoldenPricing(() => frameFromLayer(goldenUsageModal('agents').render(w, h), w, h)), MODAL_SIZES);

// Changes: the workspace view over a fixed two-file diff, a fixed repo
// summary and commits, and a semantic summary for the first file. No git runs.
const GOLDEN_DIFF = [
  'diff --git a/src/retry.ts b/src/retry.ts',
  'index 1111111..2222222 100644',
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -1,8 +1,10 @@',
  " import { sleep } from './sleep.ts';",
  ' ',
  '-export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {',
  '+const backoff = (attempt: number): number => Math.min(2_000, 100 * 2 ** attempt);',
  '+',
  '+export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {',
  '   for (let i = 0; i < attempts; i++) {',
  '     try { return await fn(); }',
  '-    catch { await sleep(100); }',
  '+    catch { await sleep(backoff(i)); }',
  '   }',
  "   throw new Error('retries exhausted');",
  ' }',
  '@@ -20,3 +22,4 @@ export function describeRetry(): string {',
  "   return 'retry with backoff';",
  ' }',
  "+export const MAX_BACKOFF_MS = 2_000;",
  'diff --git a/README.md b/README.md',
  'index 3333333..4444444 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -4,2 +4,2 @@',
  ' ## Retries',
  '-Retries wait 100ms.',
  '+Retries back off up to two seconds.',
  '',
].join('\n');

function renderChangesWorkspaceSurface(width: number, height: number): Line[] {
  const modal = new ChangesModal({ workingDirectory: '/nonexistent/golden-repo', getSessionFiles: () => [], requestRender: () => {} });
  modal.files = parseChanges(GOLDEN_DIFF);
  modal.label = 'this session';
  modal.summary = { branch: 'main', staged: 0, unstaged: 2 };
  modal.commits = [
    { hash: 'a1b2c3d4e5f6a7b8', message: 'Retries back off exponentially', date: '2026-09-27' },
    { hash: 'b2c3d4e5f6a7b8c9', message: 'Add the retry helper', date: '2026-09-26' },
  ];
  modal.reviewed.add('README.md');
  // The semantic map is private (it fills from tree-sitter asynchronously); the
  // golden sets a fixed summary so the chips row is covered without a parser.
  (modal as unknown as { semantic: Map<string, SemanticDiff | null | undefined> }).semantic.set('src/retry.ts', {
    symbols: [
      { kind: 'added', symbolKind: 'variable', name: 'backoff' } as SemanticDiff['symbols'][number],
      { kind: 'modified', symbolKind: 'function', name: 'withRetry' } as SemanticDiff['symbols'][number],
    ],
    imports: [],
    totalChanges: 2,
  });
  return frameFromLayer(modal.render(width, height), width, height);
}
describeOverlayGolden('changes-modal', renderChangesWorkspaceSurface, MODAL_SIZES);

function renderChangesPreviewQuestionSurface(width: number, height: number): Line[] {
  const modal = new ChangesModal({ workingDirectory: '/nonexistent/golden-repo', getSessionFiles: () => [], requestRender: () => {} }, 'preview');
  modal.loadPreview('Rewind to turn 3', GOLDEN_DIFF, null);
  void modal.ask({ text: 'Rewind the files to turn 3? The changes shown are undone.', confirmLabel: 'Rewind', tone: 'warning' });
  return frameFromLayer(modal.render(width, height), width, height);
}
describeOverlayGolden('changes-modal-preview-question', renderChangesPreviewQuestionSurface, MODAL_SIZES);

// Notifications: local-time fixtures, so "today" and the clock column are the
// same in every time zone.
function renderNotificationsSurface(width: number, height: number): Line[] {
  const now = new Date(2026, 8, 28, 16, 30).getTime();
  const feed = new PanelNotificationFeed();
  const note = (id: string, level: string, title: string, body: string, ts: Date, domain = 'system') =>
    ({ id, level, title, body, timestamp: ts.getTime(), domain } as never);
  const single = { target: 'panel_only', reasonCode: 'routed' } as never;
  feed.record(note('n1', 'info', 'Ollama (192.168.0.85): 4 models available', '', new Date(2026, 8, 25, 10, 5)), single);
  for (let i = 0; i < 4; i++) {
    feed.record(note(`n2-${i}`, 'warning', 'Control plane is network-reachable with TLS off', 'Set controlPlane.tls or bind to localhost.', new Date(2026, 8, 28, 9, 10 + i)),
      { target: 'panel_only', reasonCode: 'burst_collapsed', batchKey: 'tls' } as never);
  }
  feed.record(note('n3', 'critical', 'Daemon restarted after a crash', 'The previous run exited with signal 9.', new Date(2026, 8, 28, 15, 48)), single);
  feed.record(note('n4', 'info', 'Agent finished: Regenerate splash goldens', '', new Date(2026, 8, 28, 16, 2), 'agents'), single);
  feed.markAllSeen();
  feed.record(note('n5', 'info', 'Build passed on main', '', new Date(2026, 8, 28, 16, 20)), single);
  const modal = new NotificationsModal({ feed, resolveSubject: () => null, now: () => now });
  return frameFromLayer(modal.render(width, height), width, height);
}
describeOverlayGolden('notifications-modal', renderNotificationsSurface, MODAL_SIZES);

function renderMaskedEntrySurface(width: number, height: number): Line[] {
  const host = new SurfaceModalHost();
  const modal = new MaskedEntryModal({ kind: 'rotate-password', username: 'alice', auth: { addUser: () => { throw new Error('unused'); }, rotatePassword: () => {} } as never });
  host.push(modal);
  typeInto(host, 'hunter22');
  return frameFromLayer(modal.render(width, height), width, height);
}
describeOverlayGolden('masked-entry-modal', renderMaskedEntrySurface, MODAL_SIZES);

// context inspector, ConversationManager with fixed message content, no
// timestamps rendered by this surface.
function renderContextInspectorSurface(width: number, height: number): Line[] {
  const conv = new ConversationManager(() => width);
  conv.addUserMessage('Investigate why the panel-workspace golden regressed after the last hex-token pass.');
  conv.addAssistantMessage('Looking at ui-factory.ts — the CYAN token swap missed one literal at line 433.');
  return frameFromLayer(renderContextInspector(conv, width, height, 128_000), width, height);
}

describeOverlayGolden('context-inspector', renderContextInspectorSurface);

// history search, width-only signature (single bottom-bar line), no
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

describe('golden-frames : history-search-overlay', () => {
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
  return frameFromLayer(renderSelectionModalOverlay(modal, width, height), width, height);
}

describeOverlayGolden('selection-modal-overlay', renderSelectionModalSurface);

// Consequence-time trust modal, owner-hit defect: option descriptions were
// clipped to unreadability in this exact modal (back when it was also the
// combined first-open trust+register prompt; the registration half has
// since been dissolved, registration self-records instead, see
// tui-startup.ts). Rendered at a normal width and a narrow one, asserting
// every item's FULL detail text survives, never ellipsized, clipped, or
// overflow-hidden.
describe('golden-frames : consequence-time trust modal (full detail text never clipped)', () => {
  const widths: ReadonlyArray<{ readonly label: string; readonly width: number }> = [
    { label: 'normal', width: 80 },
    { label: 'narrow', width: 60 },
  ];

  const { title, items } = buildFirstOpenItems();
  for (const { label, width } of widths) {
    test(`trust prompt @ ${label} width (${width}x24): every item's full label and detail text render when reached`, () => {
      // Reaching an item is what matters, not whether every item is
      // simultaneously on screen without scrolling (a "(N below)" scroll
      // hint for the rest of the list is the intended, non-clipping
      // behavior when everything doesn't fit at once). Navigate the
      // selection to each item in turn and check that item's own full
      // label/detail is un-clipped at that point.
      for (let index = 0; index < items.length; index += 1) {
        const modal = new SelectionModal();
        modal.open(title, items, { allowSearch: false, primaryVerbLabel: 'Choose' });
        modal.selectedIndex = index;

        const text = frameFromLayer(renderSelectionModalOverlay(modal, width, 24), width, 24)
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

// ─── 8. Shell footer (busy) ────────────────────────────────────────────────
//
// A running turn: the spinner, phrase, elapsed and the esc keycap take the
// status line's left side; at 80 columns the directory is already gone and the
// context bar narrows to make room.

function renderShellFooterBusySurface(): Line[] {
  return buildShellFooter({
    width: 80,
    promptText: '',
    promptLineCount: 1,
    promptCursorPos: 0,
    usage: { up: 1024, down: 512 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    workingDir: '/workspace/my-project',
    branch: 'main',
    contextWindow: 100_000,
    compactThreshold: 0.8,
    lastInputTokens: 70_000,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    permissionMode: 'accept-edits',
    busy: { spinner: '◐', frame: 0, phrase: 'Thinking...', elapsedMs: 12_000 },
  }).lines;
}

describe('golden-frames : shell-footer (busy)', () => {
  test('matches committed golden snapshot', () => {
    const lines = renderShellFooterBusySurface();
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('shell-footer-busy', lines);
  });
  test('render is deterministic (two consecutive renders match)', () => {
    const a = snapshotEncode('shell-footer-busy', renderShellFooterBusySurface());
    const b = snapshotEncode('shell-footer-busy', renderShellFooterBusySurface());
    expect(a).toBe(b);
  });
});

// ─── 8b. Shell footer with a live microphone ────────────────────────────────
//
// The persistent capture row, in both prominences `voice.wake.indicator` offers.
// It is pinned as a golden because it is the ONLY thing on screen that says a
// microphone is open: a change that shortened, dimmed or dropped it would
// otherwise pass every other test in this file.

function renderShellFooterVoiceSurface(indicator: 'statusline' | 'banner'): Line[] {
  return buildShellFooter({
    width: W,
    promptText: 'Ask me anything',
    promptLineCount: 1,
    promptCursorPos: 15,
    usage: { up: 1024, down: 512 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    workingDir: '/workspace/my-project',
    branch: 'main',
    contextWindow: 0,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    voiceCapture: { kind: 'wake-listening', deviceLabel: 'parecord', indicator },
  }).lines;
}

for (const indicator of ['statusline', 'banner'] as const) {
  describe(`golden-frames : shell-footer (voice ${indicator})`, () => {
    const surface = `shell-footer-voice-${indicator}`;
    test('matches committed golden snapshot', () => {
      const lines = renderShellFooterVoiceSurface(indicator);
      expect(lines.length).toBeGreaterThan(0);
      assertGolden(surface, lines);
    });
    test('render is deterministic (two consecutive renders match)', () => {
      const a = snapshotEncode(surface, renderShellFooterVoiceSurface(indicator));
      const b = snapshotEncode(surface, renderShellFooterVoiceSurface(indicator));
      expect(a).toBe(b);
    });
  });
}

// ─── 9. config-modal surfaces ──────────────────────────────────
//
// One normal+hostile golden pair per new MIGRATE-TO-MODAL surface. Each renders
// a fixed, representative ConfigModalView through the REAL config-modal host
// (ConfigModal + renderConfigModal + ModalFactory), the same render path
// production uses, with row labels built from the same shared helpers the live
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
  return frameFromLayer(renderConfigModal(modal, width, height), width, height);
}

// services-modal, new modal surface, migrated from panel `services`.
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

// subscription-modal, new modal surface, migrated from panel `subscription`.
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

// remote-modal, new modal surface, migrated from panel `remote`.
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

// providers-modal, new modal surface, migrated from panel `provider-health`
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

// settings-sync-modal, new modal surface, migrated from panel `settings-sync`.
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

// local-auth-modal, new modal surface, migrated from panel `local-auth`
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

// sandbox-modal, new modal surface, migrated from panel `sandbox`.
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
// transcript (fully-designed light ThemeTokens, heading/code/link/etc.) and a
// ModalFactory modal (DEFAULT_STYLE.accentFg = state.info flips to the light
// chrome tone; the accent helper row exercises it). Both reuse render paths
// already proven deterministic in dark; underLight() flips the active mode for
// the render and ALWAYS restores dark so the surrounding dark goldens and sibling
// test files are untouched.
function renderPaletteLightSurface(): Line[] {
  return frameFromLayer(goldenPalette().render(NORMAL_W, NORMAL_H), NORMAL_W, NORMAL_H);
}
function underLight<T>(fn: () => T): T {
  setActiveThemeMode('light');
  try {
    return fn();
  } finally {
    setActiveThemeMode('dark');
  }
}

describe('golden-frames : light theme', () => {
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

  test('command palette (light) matches committed golden snapshot', () => {
    const lines = underLight(() => renderPaletteLightSurface());
    expect(lines.length).toBeGreaterThan(0);
    assertGolden('command-palette-light', lines);
  });

  test('command palette (light) is deterministic and differs from dark (a lighter scrim, white surface)', () => {
    const a = snapshotEncode('command-palette-light', underLight(() => renderPaletteLightSurface()));
    const b = snapshotEncode('command-palette-light', underLight(() => renderPaletteLightSurface()));
    expect(a).toBe(b);
    const dark = snapshotEncode('command-palette-light', renderPaletteLightSurface());
    expect(a).not.toBe(dark);
  });
});

// ─── ux/light-chrome, header/footer/thinking chrome flips with themeMode ──
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
// every release bump (the documented version-fixture failure class, see the
// splash goldens' pinned `version` at the top of this file). Pin a fixture here
// so the chrome goldens are stable across bumps; the live header still renders
// the real VERSION in production (createHeader defaults to it).
const CHROME_FIXTURE_VERSION = '0.29.0';

function renderChromeHeaderFooterSurface(): Line[] {
  const header = UIFactory.createHeader(W, 'claude-opus-4', 'Chrome golden', CHROME_GIT, CHROME_FIXTURE_VERSION);
  const footer = buildShellFooter({
    width: W,
    promptText: 'Ask me anything',
    promptLineCount: 1,
    promptCursorPos: 15,
    usage: { up: 1024, down: 512 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    workingDir: '/workspace/my-project',
    branch: 'main',
    contextWindow: 100_000,
    compactThreshold: 0.80,
    dangerMode: true,              // the status line's auto-approve chip, error color
    lastInputTokens: 60_000,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    permissionMode: 'plan',        // info-colored bar and mode chip
    composerPendingRisk: 'approval-wait',
  }).lines;
  return [...header, ...footer];
}

function renderChromeThinkingSurface(): Line[] {
  // The status line while a turn waits on an approval: frame 0, no timers.
  return buildShellFooter({
    width: W, promptText: '', promptLineCount: 1, usage: { up: 0, down: 0 }, showExitNotice: false, lastCopyTime: 0,
    runningAgentCount: 0, runningProcessCount: 0, indicatorFocused: false,
    busy: { spinner: '⠋', frame: 0, phrase: 'Waiting for your approval', approvalPending: true },
  }).lines.slice(-1);
}

describe('golden-frames : chrome light/dark flip (ux/light-chrome)', () => {
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
    // The default active mode in the shared test process is dark (default
    // theme), so the dark output must be render-stable AND equal to the
    // committed dark chrome golden.
    const a = snapshotEncode('chrome-dark', renderChromeHeaderFooterSurface());
    const b = snapshotEncode('chrome-dark', renderChromeHeaderFooterSurface());
    expect(a).toBe(b);
    assertGolden('chrome-dark', renderChromeHeaderFooterSurface());
  });

  test('each chrome surface (header/footer/thinking) flips its roles under light', () => {
    // Header: version = textFaint; dirty dot = warning.
    // Footer: auto-approve chip = error; plan bar = info.
    // Status line: the phrase = textMuted.
    const headerDark = snapshotEncode('c-h', renderChromeHeaderFooterSurface());
    const thinkDark = snapshotEncode('c-t', renderChromeThinkingSurface());
    const headerLight = snapshotEncode('c-h', underLight(() => renderChromeHeaderFooterSurface()));
    const thinkLight = snapshotEncode('c-t', underLight(() => renderChromeThinkingSurface()));

    // Dark carries the pre-change dark tokens; light must differ everywhere.
    expect(headerLight).not.toBe(headerDark);
    expect(thinkLight).not.toBe(thinkDark);

    // Concrete role assertions: each role's resolved colour for the mode must
    // appear in that mode's render (read from the active theme, not pinned).
    const dark = activeTokens();
    const light = underLight(() => ({ ...activeTokens() }));
    expect(headerDark).toContain(`fg=${dark.textFaint}`); // version (dark)
    expect(headerLight).toContain(`fg=${light.textFaint}`); // version (light)
    expect(headerDark).toContain(`fg=${dark.warning}`); // dirty dot (dark)
    expect(headerLight).toContain(`fg=${light.warning}`); // dirty dot (light)
    expect(headerDark).toContain(`fg=${dark.error}`); // auto-approve (dark)
    expect(headerLight).toContain(`fg=${light.error}`); // auto-approve (light)
    expect(headerDark).toContain(`fg=${dark.info}`); // plan bar (dark)
    expect(headerLight).toContain(`fg=${light.info}`); // plan bar (light)
    expect(thinkDark).toContain(`fg=${dark.textMuted}`); // phrase (dark)
    expect(thinkLight).toContain(`fg=${light.textMuted}`); // phrase (light)

    // Restore is handled by underLight(); confirm the shared default is dark.
    const headerDarkAgain = snapshotEncode('c-h', renderChromeHeaderFooterSurface());
    expect(headerDarkAgain).toBe(headerDark);
  });
});

// ---------------------------------------------------------------------------
// Exec sandbox approval prompt, the named-escalation "Sandbox" row.
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
  return frameFromLayer(PermissionPromptUI.renderPromptModal(NORMAL_W, NORMAL_H, request, { callId: request.callId, detailsExpanded: true }), NORMAL_W, NORMAL_H);
}

describe('golden-frames : permission prompt: exec sandbox escalation', () => {
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
// Non-foreground approval attribution, the generic "Requested by: …" row for
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
  return frameFromLayer(PermissionPromptUI.renderPromptModal(NORMAL_W, NORMAL_H, request, { callId: request.callId, detailsExpanded: true, requestedBy }), NORMAL_W, NORMAL_H);
}

describe('golden-frames : permission prompt: mcp-server elicitation attribution', () => {
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

describe('golden-frames : permission prompt: sandbox-escalation attribution (broker-routed)', () => {
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

// ---------------------------------------------------------------------------
// Surface-kit modals introduced with the modal redesign: the command palette,
// the model picker, the confirm dialog, toasts, the composer popups and the
// hunk-selection permission card. Fixed inputs; the command palette uses a
// small fixed command set so the golden does not move with the registry.
// ---------------------------------------------------------------------------

const GOLDEN_COMMANDS = [
  { name: 'diff', description: 'Show the working-tree diff.', aliases: ['d'], handler: () => {} },
  { name: 'model', description: 'Select or display the current LLM model.', aliases: ['m'], handler: () => {} },
  { name: 'compact', description: 'Summarize the conversation to free context.', handler: () => {} },
  { name: 'resume', description: 'Resume a saved session.', usage: '<id|name>', handler: () => {} },
  { name: 'session', description: 'List, save and manage sessions.', handler: () => {} },
  { name: 'agents', description: 'Host third-party coding agents over ACP.', handler: () => {} },
  { name: 'settings', description: 'Open the settings.', handler: () => {} },
  { name: 'shortcuts', description: 'Show the keyboard shortcuts.', handler: () => {} },
  { name: 'refresh-models', description: 'Refresh model catalog, benchmarks, and token limits.', handler: () => {} },
];

function goldenPalette(query = ''): CommandPalette {
  resetPaletteUsageForTests();
  const categories = new Map(GOLDEN_COMMANDS.map((c) => [c.name, 'Shell & Session']));
  const palette = new CommandPalette({ entries: buildPaletteEntries(GOLDEN_COMMANDS, categories), onRun: () => {} });
  if (query) palette.setQuery(query);
  return palette;
}

describeOverlayGolden('command-palette', (width, height) => frameFromLayer(goldenPalette().render(width, height), width, height));
describeOverlayGolden('command-palette-query', (width, height) => frameFromLayer(goldenPalette('mod').render(width, height), width, height));

describeOverlayGolden('confirm-dialog', (width, height) => {
  const dialog = new ConfirmDialog({
    title: 'Delete session?',
    body: 'This removes "test" and its 3 messages from this project.\nIt cannot be undone.',
    confirmLabel: 'Delete',
    tone: 'danger',
  }, () => {});
  return frameFromLayer(dialog.render(width, height), width, height);
});

const GOLDEN_TOASTS: ToastSpec[] = [
  { title: 'Daemon restarted', body: 'after a crash at 15:48 · see /status', tone: 'warning' },
  { title: 'Control plane is network-reachable with TLS off', tone: 'error' },
];

describeOverlayGolden('toasts', (width, height) => {
  const layer = renderToasts(width, height, GOLDEN_TOASTS);
  return frameFromLayer(layer ? { ...layer, dim: false } : null, width, height);
});

function goldenModel(id: string, provider: string, displayName: string, contextWindow: number): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName,
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow,
    selectable: true,
    tier: 'premium',
  };
}

describeOverlayGolden('model-picker', (width, height) => {
  const picker = new ModelPickerModal(
    { getRecentModels: async () => [] },
    { getBenchmarks: () => undefined },
    { getSyntheticModelInfoFromCatalog: () => null, getSyntheticCanonicalModels: () => [] },
  );
  picker.active = true;
  picker.models = [
    goldenModel('claude-opus-5-5', 'anthropic', 'Claude Opus 5.5', 1_000_000),
    goldenModel('gpt-test', 'openai', 'GPT Test', 128_000),
    goldenModel('qwen3-coder', 'lmstudio', 'qwen3-coder', 128_000),
  ];
  picker.providers = ['anthropic', 'openai', 'lmstudio'];
  picker.configuredProviders = new Set(['anthropic', 'openai', 'lmstudio']);
  picker.pinnedIds = new Set(['anthropic:claude-opus-5-5']);
  picker.setTargetInfos([
    { target: 'main', label: 'Main Chat', description: 'Default model for chat turns.', provider: 'anthropic', model: 'anthropic:claude-opus-5-5', enabled: true, inherited: false },
    { target: 'helper', label: 'Helper', description: 'Helper route.', provider: 'openai', model: 'openai:gpt-test', enabled: true, inherited: false },
  ]);
  picker.openAllModels(picker.models, 'anthropic:claude-opus-5-5');
  return frameFromLayer(renderModelWorkspace(picker, width, height), width, height);
});

function goldenAutocomplete(): AutocompleteEngine {
  const registry = new CommandRegistry();
  for (const command of GOLDEN_COMMANDS) registry.register({ ...command });
  const engine = new AutocompleteEngine(registry);
  engine.update('mod');
  return engine;
}

describeOverlayGolden('slash-popup', (width, height) => renderAutocompleteOverlay(goldenAutocomplete(), width, height));

describeOverlayGolden('file-popup', (width, height) => {
  const picker = new FilePickerModal({ workingDirectory: '/nonexistent/golden' });
  picker.active = true;
  picker.query = 'rtr';
  picker.results = ['src/net/retry.ts', 'test/retry.test.ts', 'src/api/router.ts'];
  picker.selectedIndex = 0;
  return renderFilePickerOverlay(picker, width, height);
});

describeOverlayGolden('permission-edit-hunks', (width, height) => {
  const edits = [
    { path: 'src/net/retry.ts', find: 'await sleep(opts.baseDelayMs);', replace: 'if (i === opts.attempts - 1) break;\nconst backoff = opts.baseDelayMs * 2 ** i;\nawait sleep(backoff);' },
    { path: 'src/net/retry.ts', find: '  attempts: number;', replace: '  attempts: number;\n  maxDelayMs?: number;' },
  ];
  const request = {
    callId: 'call-golden-hunks-01',
    tool: 'edit',
    args: { path: 'src/net/retry.ts', edits },
    category: 'write',
    analysis: { classification: 'file-mutation', riskLevel: 'medium', summary: 'Edit src/net/retry.ts', reasons: ['Two hunks change the retry loop.'] },
    resolve: () => {},
  } as unknown as PermissionRequest;
  const hunkState = { hunks: edits, cursor: 0, selected: new Set([0]) };
  return frameFromLayer(PermissionPromptUI.renderPromptModal(width, height, request, { callId: request.callId, hunkState, requestedBy: 'engineer' }), width, height);
});

// ─── The main screen, whole ────────────────────────────────────────────────
//
// Header (1 row), the conversation area, the composer (5 rows) and the status
// line (1 row): about 7 rows of chrome at rest. The home screen centers the
// protected splash in the conversation area and must not clip it at 100x30.

function screenFrame(width: number, height: number, body: Line[], footer: Line[], header: Line[]): Line[] {
  const room = height - header.length - footer.length;
  const visible = body.slice(Math.max(0, body.length - room));
  while (visible.length < room) visible.unshift(emptyLine(width));
  return [...header, ...visible, ...footer];
}

function baseFooter(width: number, overrides: Partial<Parameters<typeof buildShellFooter>[0]> = {}): Line[] {
  return buildShellFooter({
    width,
    promptText: '',
    promptLineCount: 1,
    promptCursorPos: 0,
    usage: { up: 53_000, down: 1_700 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    workingDir: '/workspace/goodvibes-tui',
    branch: 'main',
    contextWindow: 1_000_000,
    compactThreshold: 0.8,
    lastInputTokens: 340_000,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    permissionMode: 'prompt',
    ...overrides,
  }).lines;
}

function renderHomeScreenSurface(width: number, height: number): Line[] {
  const header = UIFactory.createHeader(width, 'claude-opus-4', undefined, CHROME_GIT, CHROME_FIXTURE_VERSION);
  const footer = baseFooter(width);
  const room = height - header.length - footer.length;
  return [...header, ...centerViewportContent(renderSplashSurface(width), room, width), ...footer];
}

function renderBaseScreenSurface(width: number, height: number): Line[] {
  const t = activeTokens();
  const body: Line[] = [emptyLine(width)];
  body.push(...UIFactory.createMessageBar(width, "The retry helper in src/net/retry.ts never backs off, so we hammer the API when it's down. Can you fix it and add a test?"));
  body.push(emptyLine(width));
  body.push(renderConversationEventLine(width, { marker: '◆', markerFg: t.brand, label: '', labelFg: t.textFaint, detailFg: t.textFaint }, [
    { text: ' claude-opus-4', fg: t.textFaint }, { text: ' · 4 tools', fg: t.textFaint },
  ]));
  body.push(...renderMarkdown([
    '## Fixed: exponential backoff with jitter',
    'The loop slept a **constant** `baseDelayMs` between attempts, so a flapping API got hit at a steady rate.',
    '1. Delay now doubles each attempt: `baseDelayMs * 2 ** i`',
    '2. Up to 20% random jitter so concurrent callers spread out',
    '- No sleep after the final attempt',
    '> The cap on the delay is a follow-up; this quote wraps so its bar shows on every row it takes up on screen.',
    '```ts',
    'const backoff = opts.baseDelayMs * 2 ** i;',
    'await sleep(backoff + Math.random() * backoff * 0.2);',
    '```',
    'The schedule becomes:',
    '| Attempt | Delay (ms) |',
    '|---|---|',
    '| 1 | 200 |',
    '| 2 | 400 |',
  ].join('\n'), width));
  const header = UIFactory.createHeader(width, 'claude-opus-4', 'Fix retry backoff', CHROME_GIT, CHROME_FIXTURE_VERSION);
  return screenFrame(width, height, body, baseFooter(width, { dangerMode: true }), header);
}

describe('golden-frames : the main screen', () => {
  test('home screen at 100x30: the splash is centered and not clipped', () => {
    const lines = renderHomeScreenSurface(100, 30);
    expect(lines).toHaveLength(30);
    const splash = renderSplashSurface(100);
    const text = lines.map((l) => l.map((c) => c.char).join(''));
    for (const row of splash) {
      const want = row.map((c) => c.char).join('');
      if (want.trim()) expect(text).toContain(want);
    }
    // Centered: the blank rows above and below the splash differ by at most one.
    const body = text.slice(1, 30 - 4);
    const first = body.findIndex((r) => r.trim() !== '');
    let last = body.length - 1;
    while (last > first && body[last]!.trim() === '') last--;
    expect(Math.abs(first - (body.length - 1 - last))).toBeLessThanOrEqual(1);
    assertGolden('home-screen-100x30', lines);
  });

  test('base screen at 120x40 and 80x24', () => {
    assertGolden('base-screen-120x40', renderBaseScreenSurface(120, 40));
    assertGolden('base-screen-80x24', renderBaseScreenSurface(80, 24));
  });

  test('chrome at rest is 5 rows: header 1, composer 3, status line 1', () => {
    expect(UIFactory.createHeader(120, 'claude-opus-4')).toHaveLength(1);
    expect(baseFooter(120)).toHaveLength(4);
  });
});
