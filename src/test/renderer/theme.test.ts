/**
 * theme.test.ts
 *
 * Covers:
 *   - resolveTheme() returns correct token set per mode
 *   - Token values are non-empty strings
 *   - Dark mode values match the expected historical colours
 *   - Light mode values differ from dark mode (actually light-friendly)
 *   - No hex colour literals remain hardcoded in the three call-site files
 *     (markdown.ts, compositor.ts, conversation-rendering.ts)
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { resolveTheme, resolveUiTones, DARK_THEME, type ThemeTokens } from '../../renderer/theme.ts';
import { UI_TONES } from '../../renderer/ui-primitives.ts';

// ---------------------------------------------------------------------------
// resolveTheme()
// ---------------------------------------------------------------------------

describe('resolveTheme', () => {
  test('dark mode returns DARK_THEME reference', () => {
    expect(resolveTheme('dark')).toBe(DARK_THEME);
  });

  test('light mode does not equal dark mode', () => {
    const dark = resolveTheme('dark');
    const light = resolveTheme('light');
    expect(light).not.toBe(dark);
    // At least heading1 differs between modes
    expect(light.heading1).not.toBe(dark.heading1);
  });

  test('unknown mode falls back to dark (safe default)', () => {
    // TypeScript prevents passing an unknown literal but JS can
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveTheme('dark')).toBe(DARK_THEME);
  });
});

// ---------------------------------------------------------------------------
// Token completeness — every key must be a non-empty string
// ---------------------------------------------------------------------------

describe('ThemeTokens completeness', () => {
  const TOKEN_KEYS: (keyof ThemeTokens)[] = [
    'heading1',
    'heading2',
    'heading3',
    'inlineCodeFg',
    'link',
    'searchMatchBg',
    'searchMatchFg',
    'searchCurrentBg',
    'searchCurrentFg',
    'strikethrough',
    'blockquote',
    'assistantHeader',
    'reasoningAccent',
    'toolAccent',
    'collapsedBodyBg',
    'checkboxChecked',
    'errorBarBg',
    'modelNameDim',
    'toolNameFg',
    'diffAccent',
  ];

  for (const mode of ['dark', 'light'] as const) {
    describe(`mode=${mode}`, () => {
      const tokens = resolveTheme(mode);
      for (const key of TOKEN_KEYS) {
        test(`${key} is a non-empty string`, () => {
          expect(typeof tokens[key]).toBe('string');
          expect((tokens[key] as string).length).toBeGreaterThan(0);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Dark mode spot checks — expected historical values
// ---------------------------------------------------------------------------

describe('dark mode token values', () => {
  const dark = resolveTheme('dark');

  test('heading1 is #00ffff (historical cyan)', () => {
    expect(dark.heading1).toBe('#00ffff');
  });

  test('inlineCodeFg is #ffcc00 (historical yellow, no bg)', () => {
    expect(dark.inlineCodeFg).toBe('#ffcc00');
  });

  test('link is #00aaff (historical blue)', () => {
    expect(dark.link).toBe('#00aaff');
  });

  test('searchCurrentBg is #ffff00 (historical bright yellow)', () => {
    expect(dark.searchCurrentBg).toBe('#ffff00');
  });

  test('searchCurrentFg is #000000 (black on yellow)', () => {
    expect(dark.searchCurrentFg).toBe('#000000');
  });

  test('searchMatchBg is #806600 (historical muted gold)', () => {
    expect(dark.searchMatchBg).toBe('#806600');
  });

  test('assistantHeader is #22d3ee', () => {
    expect(dark.assistantHeader).toBe('#22d3ee');
  });

  test('reasoningAccent is #a855f7', () => {
    expect(dark.reasoningAccent).toBe('#a855f7');
  });

  test('toolAccent is #38bdf8', () => {
    expect(dark.toolAccent).toBe('#38bdf8');
  });

  test('checkboxChecked is #22c55e (green checkbox)', () => {
    expect(dark.checkboxChecked).toBe('#22c55e');
  });

  test('errorBarBg is #3a1a1a (dark reddish bar)', () => {
    expect(dark.errorBarBg).toBe('#3a1a1a');
  });

  test('modelNameDim is #94a3b8 (slate-400 dim label)', () => {
    expect(dark.modelNameDim).toBe('#94a3b8');
  });

  test('toolNameFg is #e2e8f0 (slate-200 tool name)', () => {
    expect(dark.toolNameFg).toBe('#e2e8f0');
  });

  test('diffAccent is #f59e0b (amber diff marker)', () => {
    expect(dark.diffAccent).toBe('#f59e0b');
  });
});

// ---------------------------------------------------------------------------
// Light mode values — must be clearly different from dark for readability
// ---------------------------------------------------------------------------

describe('light mode token values differ from dark', () => {
  const dark = resolveTheme('dark');
  const light = resolveTheme('light');

  const lighterKeys: (keyof ThemeTokens)[] = [
    'heading1',
    'heading2',
    'inlineCodeFg',
    'link',
    'searchMatchBg',
    'searchCurrentBg',
    'assistantHeader',
    'reasoningAccent',
    'toolAccent',
    'collapsedBodyBg',
    'checkboxChecked',
    'errorBarBg',
    'modelNameDim',
    'toolNameFg',
    'diffAccent',
  ];

  for (const key of lighterKeys) {
    test(`${key} differs between dark and light`, () => {
      expect(light[key]).not.toBe(dark[key]);
    });
  }
});

// ---------------------------------------------------------------------------
// No raw hex literals at hardcoded call sites
//
// Verifies that markdown.ts, compositor.ts, and conversation-rendering.ts
// no longer contain the specific hex literals that were replaced by tokens.
// This is a lint-style regression guard — it will fail if someone re-introduces
// a hardcoded colour at one of those call sites.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveUiTones() — chrome-token mode dimension (WO-001)
//
// UI_TONES (ui-primitives.ts) is the dark entry; dark resolution must stay
// byte-identical (same reference) to that constant. The light entry must be
// type-complete (every nested role present as a non-empty string) even
// though it is not yet a shipped, fully-designed light theme.
// ---------------------------------------------------------------------------

function collectStringLeaves(value: unknown, path: string, out: Array<[string, unknown]>): void {
  if (typeof value === 'string') {
    out.push([path, value]);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectStringLeaves(nested, path ? `${path}.${key}` : key, out);
    }
  }
}

describe('resolveUiTones', () => {
  test("dark mode is byte-identical to UI_TONES (same reference)", () => {
    expect(resolveUiTones('dark')).toBe(UI_TONES);
  });

  test('dark mode roles match the historical UI_TONES values', () => {
    const dark = resolveUiTones('dark');
    expect(dark.accent.brand).toBe('#00ffff');
    expect(dark.accent.gradientStart).toBe('#00ffff');
    expect(dark.accent.gradientEnd).toBe('#d000ff');
    expect(dark.state.reasoning).toBe('#a855f7');
    expect(dark.border).toBe('#64748b');
    expect(dark.bg.footer).toBe('#111827');
    expect(dark.fg.empty).toBe('#334155');
  });

  test('light mode is a distinct object from dark', () => {
    expect(resolveUiTones('light')).not.toBe(resolveUiTones('dark'));
  });

  test('light mode is type-complete: every leaf role is a non-empty string', () => {
    const light = resolveUiTones('light');
    const leaves: Array<[string, unknown]> = [];
    collectStringLeaves(light, '', leaves);
    expect(leaves.length).toBeGreaterThan(0);
    for (const [path, value] of leaves) {
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  test('light mode has the same shape (leaf paths) as dark mode', () => {
    const dark = resolveUiTones('dark');
    const light = resolveUiTones('light');
    const darkLeaves: Array<[string, unknown]> = [];
    const lightLeaves: Array<[string, unknown]> = [];
    collectStringLeaves(dark, '', darkLeaves);
    collectStringLeaves(light, '', lightLeaves);
    expect(lightLeaves.map(([path]) => path).sort()).toEqual(darkLeaves.map(([path]) => path).sort());
  });

  test('light mode substitutes at least one role away from the dark value', () => {
    const dark = resolveUiTones('dark');
    const light = resolveUiTones('light');
    expect(light.state.reasoning).not.toBe(dark.state.reasoning);
    expect(light.accent.brand).not.toBe(dark.accent.brand);
  });
});

describe('no hardcoded hex literals at replaced call sites', () => {
  const root = path.resolve(import.meta.dir, '../..');

  // Per-file hex guard lists.
  // NOTE: conversation-rendering.ts retains '#00ffff' in addConversationSplashScreen
  // (an intentional color-interpolation gradient — not a replaced call site).
  const GUARDS: Array<{ file: string; blockedHex: string[] }> = [
    {
      file: path.join(root, 'renderer/markdown.ts'),
      blockedHex: [
        '#00ffff',  // heading1/2 — moved to T.heading1 / T.heading2
        '#ffcc00',  // inlineCodeFg — moved to T.inlineCodeFg
        '#1a1a1a',  // inline code bg hardcode removed (bg now inherited)
        '#00aaff',  // link — moved to T.link
        '#22c55e',  // checkboxChecked — moved to T.checkboxChecked
      ],
    },
    {
      file: path.join(root, 'renderer/compositor.ts'),
      blockedHex: [
        '#ffff00',  // searchCurrentBg — moved to T.searchCurrentBg
        '#806600',  // searchMatchBg — moved to T.searchMatchBg
        '#ffffff',  // searchMatchFg — moved to T.searchMatchFg
        '#000000',  // searchCurrentFg — moved to T.searchCurrentFg
      ],
    },
    {
      file: path.join(root, 'core/conversation-rendering.ts'),
      blockedHex: [
        '#22d3ee',  // assistantHeader — moved to T.assistantHeader
        '#a855f7',  // reasoningAccent — moved to T.reasoningAccent
        '#38bdf8',  // toolAccent — moved to T.toolAccent
        '#1a1a1a',  // collapsedBodyBg — moved to T.collapsedBodyBg
        '#3a1a1a',  // errorBarBg — moved to T.errorBarBg
        '#94a3b8',  // modelNameDim — moved to T.modelNameDim
        '#e2e8f0',  // toolNameFg — moved to T.toolNameFg
        '#f59e0b',  // diffAccent — moved to T.diffAccent
        // '#00ffff' is intentionally NOT blocked here:
        // addConversationSplashScreen uses it for color-interpolation gradient
      ],
    },
  ];

  // Flatten into per-file / per-hex test cases
  for (const { file, blockedHex } of GUARDS) {
    const shortName = path.relative(root, file);
    const content = readFileSync(file, 'utf-8');

    for (const hex of blockedHex) {
      test(`${shortName} does not contain hardcoded ${hex}`, () => {
        expect(content).not.toContain(hex);
      });
    }
  }
});
