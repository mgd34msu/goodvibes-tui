/**
 * theme-runtime.test.ts — the active-mode runtime.
 *
 * Covers: the active-mode accessors, the in-place palette rebuild registry and
 * its reversibility (light→dark restores byte-identical dark), the transcript
 * token flip under light, the chrome-palette flip (base + extendPalette-derived),
 * the splash geometry invariance across modes (protected aesthetic), and the
 * display.themeMode config coercion.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  activeTheme,
  activeUiTones,
  resolveTheme,
  resolveUiTones,
  setActiveThemeMode,
} from '../../renderer/theme.ts';
import { DEFAULT_PANEL_PALETTE, extendPalette } from '../../panels/polish-core.ts';
import { FULLSCREEN_PALETTE } from '../../renderer/fullscreen-primitives.ts';
import { DEFAULT_OVERLAY_PALETTE } from '../../renderer/overlay-box.ts';
import { renderMarkdown } from '../../renderer/markdown.ts';
import { addConversationSplashScreen } from '../../core/conversation-rendering.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import {
  coerceThemeModeSetting,
  resolveConfiguredThemeMode,
  THEME_MODE_DEFAULT,
} from '../../renderer/theme-mode-config.ts';
import type { ConfigManager } from '../../config/index.ts';

// Always restore the shared default so later tests (and the golden suite in
// sibling files) see dark.
afterEach(() => setActiveThemeMode('dark'));

// ---------------------------------------------------------------------------
// Active-mode accessors
// ---------------------------------------------------------------------------

describe('active mode accessors', () => {
  test('default is dark', () => {
    expect(activeTheme()).toBe(resolveTheme('dark'));
    expect(activeUiTones()).toBe(resolveUiTones('dark'));
  });

  test('setActiveThemeMode(light) flips both token layers', () => {
    setActiveThemeMode('light');
    expect(activeTheme()).toBe(resolveTheme('light'));
    expect(activeUiTones()).toBe(resolveUiTones('light'));
  });

  test('setActiveThemeMode(dark) flips back', () => {
    setActiveThemeMode('light');
    setActiveThemeMode('dark');
    expect(activeTheme()).toBe(resolveTheme('dark'));
    expect(activeUiTones()).toBe(resolveUiTones('dark'));
  });
});

// ---------------------------------------------------------------------------
// Chrome palette rebuild + reversibility
// ---------------------------------------------------------------------------

describe('chrome palette in-place rebuild', () => {
  test('base panel palette flips its info role and restores byte-identically', () => {
    const darkInfo = DEFAULT_PANEL_PALETTE.info;
    const darkSnapshot = { ...DEFAULT_PANEL_PALETTE };

    setActiveThemeMode('light');
    expect(DEFAULT_PANEL_PALETTE.info).toBe(resolveUiTones('light').state.info);
    expect(DEFAULT_PANEL_PALETTE.info).not.toBe(darkInfo);

    setActiveThemeMode('dark');
    // Reversible: every field back to the exact dark value.
    expect({ ...DEFAULT_PANEL_PALETTE }).toEqual(darkSnapshot);
  });

  test('fullscreen palette flips its info role and restores', () => {
    const darkInfo = FULLSCREEN_PALETTE.info;
    setActiveThemeMode('light');
    expect(FULLSCREEN_PALETTE.info).toBe(resolveUiTones('light').state.info);
    expect(FULLSCREEN_PALETTE.info).not.toBe(darkInfo);
    setActiveThemeMode('dark');
    expect(FULLSCREEN_PALETTE.info).toBe(darkInfo);
  });

  test('overlay palette object identity is stable across flips (mutated in place)', () => {
    const ref = DEFAULT_OVERLAY_PALETTE;
    const darkSnapshot = { ...DEFAULT_OVERLAY_PALETTE };
    setActiveThemeMode('light');
    setActiveThemeMode('dark');
    expect(DEFAULT_OVERLAY_PALETTE).toBe(ref); // never replaced, only rebuilt
    expect({ ...DEFAULT_OVERLAY_PALETTE }).toEqual(darkSnapshot);
  });

  test('extendPalette-derived palette tracks the base flip; extras stay put', () => {
    const C = extendPalette(DEFAULT_PANEL_PALETTE, { custom: '#123456' });
    const darkInfo = C.info;
    setActiveThemeMode('light');
    // Base role re-merged from the (now-light) base…
    expect(C.info).toBe(resolveUiTones('light').state.info);
    expect(C.info).not.toBe(darkInfo);
    // …custom extra is untouched.
    expect(C.custom).toBe('#123456');
    setActiveThemeMode('dark');
    expect(C.info).toBe(darkInfo);
    expect(C.custom).toBe('#123456');
  });
});

// ---------------------------------------------------------------------------
// Transcript token flip (fully-designed light tokens)
// ---------------------------------------------------------------------------

/** Collect the distinct foreground colours used across a rendered surface. */
function fgSet(lines: Line[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) for (const cell of line) if (cell.fg) out.add(cell.fg);
  return out;
}

describe('transcript renders in the active mode', () => {
  const MD = '# Heading One\n\nA `code` span and a [link](https://example.com).';

  test('dark uses the historical heading cyan (#00ffff)', () => {
    const fgs = fgSet(renderMarkdown(MD, 80));
    expect(fgs.has('#00ffff')).toBe(true);
    expect(fgs.has('#0077aa')).toBe(false);
  });

  test('light uses the reviewed light heading teal (#0077aa), never the dark cyan', () => {
    setActiveThemeMode('light');
    const fgs = fgSet(renderMarkdown(MD, 80));
    expect(fgs.has('#0077aa')).toBe(true);   // LIGHT.heading1
    expect(fgs.has('#00ffff')).toBe(false);  // no dark heading colour leaks
    // Inline code + link also swap to their light tokens.
    expect(fgs.has(resolveTheme('light').inlineCodeFg)).toBe(true);
    expect(fgs.has(resolveTheme('light').link)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Splash geometry invariance (protected aesthetic)
// ---------------------------------------------------------------------------

function renderSplash(width: number): Line[] {
  const lines: Line[] = [];
  const context = {
    history: {
      addLine: (l: Line) => { lines.push(l); },
      addLines: (ls: Line[]) => { lines.push(...ls); },
      getLineCount: () => lines.length,
    },
    blockRegistry: [], collapseState: new Map<string, boolean>(), errorLineRegistry: [],
    messageKindRegistry: new Map(), configManager: null,
    splashOptions: { workingDir: '/w', model: 'm', provider: 'p', toolCount: 1, version: '0.29.0' },
  };
  addConversationSplashScreen(context as never, width);
  return lines;
}

describe('splash geometry is identical across modes', () => {
  for (const width of [60, 100, 140]) {
    test(`width=${width}: every line's char content is byte-equal dark vs light`, () => {
      const dark = renderSplash(width).map((l) => l.map((c) => c.char).join(''));
      setActiveThemeMode('light');
      const light = renderSplash(width).map((l) => l.map((c) => c.char).join(''));
      expect(light).toEqual(dark);
      // Line lengths in particular must match (wide-glyph boundary math).
      expect(light.map((s) => s.length)).toEqual(dark.map((s) => s.length));
    });
  }
});

// ---------------------------------------------------------------------------
// display.themeMode config coercion
// ---------------------------------------------------------------------------

describe('theme-mode config', () => {
  test('coerceThemeModeSetting narrows valid values, else default', () => {
    expect(coerceThemeModeSetting('auto')).toBe('auto');
    expect(coerceThemeModeSetting('dark')).toBe('dark');
    expect(coerceThemeModeSetting('light')).toBe('light');
    expect(coerceThemeModeSetting(undefined)).toBe(THEME_MODE_DEFAULT);
    expect(coerceThemeModeSetting('nonsense')).toBe(THEME_MODE_DEFAULT);
    expect(coerceThemeModeSetting(42)).toBe(THEME_MODE_DEFAULT);
  });

  test('resolveConfiguredThemeMode reads the key and defaults to auto', () => {
    // display.themeMode is TUI-local (cast key, not in the SDK ConfigKey
    // union — see theme-mode-config.ts). `get` is cast through `unknown`
    // straight to ConfigManager's own method type (rather than reconstructed
    // as an independent generic signature): the SDK's ConfigValue mapped type
    // is a very large discriminated union, and asking the compiler to
    // structurally verify a freshly-written generic signature against it here
    // risks TS's "excessive stack depth" recursion limit (TS2321) — a
    // compiler limitation, not a real type mismatch.
    expect(resolveConfiguredThemeMode({
      get: ((_key: string) => 'light') as unknown as ConfigManager['get'],
    })).toBe('light');
    expect(resolveConfiguredThemeMode({
      get: ((_key: string) => undefined) as unknown as ConfigManager['get'],
    })).toBe('auto');
    // A throwing get (absent section) degrades to the honest default.
    expect(resolveConfiguredThemeMode({
      get: ((_key: string) => { throw new Error('no section'); }) as unknown as ConfigManager['get'],
    })).toBe('auto');
  });
});
