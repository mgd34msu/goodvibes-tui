/**
 * theme-selection.test.ts, choosing a theme at runtime.
 *
 * Covers: the default theme, name normalization (legacy vaporwave, unknown
 * names), the system theme (fallback before/without a terminal palette, and a
 * re-resolve when the palette arrives), in-place palette rebuilds on a theme
 * change (base palettes, extendPalette extras, the formerly stale copies), and
 * the protected splash gradient under every theme and mode.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  generateSystemTheme,
  getBundledTheme,
  resolveTheme as resolveThemeFile,
} from '@pellux/goodvibes-sdk/platform/presentation';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import {
  activeTokens,
  activeUiTones,
  getActiveThemeName,
  listThemeChoices,
  normalizeThemeName,
  refreshForTerminalPalette,
  setActiveThemeMode,
  setActiveThemeName,
} from '../../renderer/theme.ts';
import { resolveConfiguredThemeName } from '../../renderer/theme-mode-config.ts';
import {
  emptyTerminalPalette,
  resetTerminalPaletteForTests,
  setTerminalPalette,
  type TerminalPalette,
} from '../../renderer/terminal-palette.ts';
import { DEFAULT_PANEL_PALETTE, extendPalette } from '../../panels/polish-core.ts';
import { buildStatusBadge } from '../../panels/polish-tables.ts';
import { MODAL_TONES } from '../../panels/modals/modal-theme.ts';
import { DEFAULT_OVERLAY_PALETTE } from '../../renderer/overlay-box.ts';
import { BORDERS } from '../../renderer/layout.ts';
import { addConversationSplashScreen } from '../../core/conversation-rendering.ts';
import { SPLASH_GRADIENT } from '../../utils/splash-lines.ts';

afterEach(() => {
  resetTerminalPaletteForTests();
  setActiveThemeName('goodvibes');
  setActiveThemeMode('dark');
});

function bundledTokens(name: string, mode: 'dark' | 'light') {
  return resolveThemeFile(getBundledTheme(name)!.json, mode);
}

function config(value: unknown): Pick<ConfigManager, 'get'> {
  return { get: ((_key: string) => value) as unknown as ConfigManager['get'] };
}

describe('theme names', () => {
  test('a fresh session renders with the goodvibes theme', () => {
    expect(getActiveThemeName()).toBe('goodvibes');
    expect(activeTokens()).toEqual(bundledTokens('goodvibes', 'dark'));
  });

  test('normalizeThemeName maps vaporwave to goodvibes-neon and unknowns to the default', () => {
    expect(normalizeThemeName('vaporwave')).toBe('goodvibes-neon');
    expect(normalizeThemeName('Nord')).toBe('nord');
    expect(normalizeThemeName('system')).toBe('system');
    expect(normalizeThemeName('no-such-theme')).toBe('goodvibes');
    expect(normalizeThemeName(undefined)).toBe('goodvibes');
    expect(normalizeThemeName(7)).toBe('goodvibes');
  });

  test('resolveConfiguredThemeName reads display.theme, normalized', () => {
    expect(resolveConfiguredThemeName(config('vaporwave'))).toBe('goodvibes-neon');
    expect(resolveConfiguredThemeName(config('dracula'))).toBe('dracula');
    expect(resolveConfiguredThemeName(config(undefined))).toBe('goodvibes');
    expect(resolveConfiguredThemeName({
      get: ((_key: string) => { throw new Error('no section'); }) as unknown as ConfigManager['get'],
    })).toBe('goodvibes');
  });

  test('the picker lists system first, then every bundled theme with its variants', () => {
    const choices = listThemeChoices();
    expect(choices[0]!.name).toBe('system');
    expect(choices.map((c) => c.name)).toContain('goodvibes-neon');
    expect(choices.find((c) => c.name === 'nord')!.variants).toEqual(['dark']);
  });

  test('every theme resolves in the mode it is set to', () => {
    setActiveThemeName('catppuccin');
    setActiveThemeMode('light');
    expect(activeTokens()).toEqual(bundledTokens('catppuccin', 'light'));
  });
});

describe('the system theme', () => {
  const PALETTE: TerminalPalette = {
    background: '#101820',
    foreground: '#d0d0d0',
    ansi: ['#000000', '#cc3333', '#33cc66', '#cccc33', '#3366cc', '#cc33cc', '#33cccc', '#c0c0c0',
      '#555555', '#ff5555', '#55ff88', '#ffff55', '#5588ff', '#ff55ff', '#55ffff', '#ffffff'],
  };

  test('falls back to goodvibes until a palette arrives', () => {
    setActiveThemeName('system');
    expect(getActiveThemeName()).toBe('system');
    expect(activeTokens()).toEqual(bundledTokens('goodvibes', 'dark'));
  });

  test('falls back to goodvibes when the terminal answered nothing', () => {
    setTerminalPalette(emptyTerminalPalette());
    setActiveThemeName('system');
    expect(activeTokens()).toEqual(bundledTokens('goodvibes', 'dark'));
  });

  test('re-resolves from the palette once it arrives, and rebuilds the palettes', () => {
    setActiveThemeName('system');
    setTerminalPalette(PALETTE);
    expect(refreshForTerminalPalette()).toBe(true);
    const expected = resolveThemeFile(generateSystemTheme(PALETTE, 'dark'), 'dark');
    expect(activeTokens()).toEqual(expected);
    expect(DEFAULT_PANEL_PALETTE.info).toBe(expected.info);
  });

  test('a palette refresh is a no-op for any other theme', () => {
    setActiveThemeName('nord');
    setTerminalPalette(PALETTE);
    expect(refreshForTerminalPalette()).toBe(false);
    expect(activeTokens()).toEqual(bundledTokens('nord', 'dark'));
  });
});

describe('a theme change reaches every palette', () => {
  test('base palettes rebuild in place', () => {
    const overlay = DEFAULT_OVERLAY_PALETTE;
    setActiveThemeName('dracula');
    expect(DEFAULT_OVERLAY_PALETTE).toBe(overlay);
    expect(DEFAULT_OVERLAY_PALETTE.selectedBg).toBe(activeUiTones().bg.selected);
    expect(DEFAULT_PANEL_PALETTE.good).toBe(activeTokens().success);
    expect(MODAL_TONES.info).toBe(activeTokens().info);
  });

  test('extendPalette extras are rebuilt from the new theme', () => {
    const C = extendPalette(DEFAULT_PANEL_PALETTE, () => ({ series: activeTokens().secondary }));
    setActiveThemeName('gruvbox');
    expect(C.series).toBe(bundledTokens('gruvbox', 'dark').secondary);
    setActiveThemeName('rosepine');
    expect(C.series).toBe(bundledTokens('rosepine', 'dark').secondary);
  });

  test('status badges (formerly copied once) follow the theme', () => {
    setActiveThemeName('tokyonight');
    expect(buildStatusBadge('completed')[0]!.fg).toBe(activeTokens().success);
    setActiveThemeName('solarized');
    expect(buildStatusBadge('completed')[0]!.fg).toBe(activeTokens().success);
  });

  test('BORDERS colours read the active theme', () => {
    setActiveThemeName('one-dark');
    expect(BORDERS.ERROR.color).toBe(activeUiTones().state.bad);
  });
});

// ---------------------------------------------------------------------------
// Protected splash: the wordmark gradient never follows the theme.
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

/** Per wordmark row, the fg of every gradient-painted (bold) cell, left to right. */
function gradientRows(lines: Line[]): string[][] {
  return lines
    .map((line) => line.filter((cell) => cell.bold).map((cell) => cell.fg))
    .filter((row) => row.length > 1);
}

describe('the splash gradient is protected', () => {
  test('the named constant pins the two stops', () => {
    expect(SPLASH_GRADIENT.start).toBe('#00ffff');
    expect(SPLASH_GRADIENT.end).toBe('#d000ff');
  });

  // Reference: the gradient as rendered with no theme involvement at all is the
  // same under every theme; pin it against the first theme and compare.
  for (const choice of listThemeChoices()) {
    for (const mode of ['dark', 'light'] as const) {
      test(`${choice.name}/${mode}: every wordmark row runs from #00ffff toward #d000ff`, () => {
        setActiveThemeName('goodvibes-neon');
        setActiveThemeMode('dark');
        const reference = gradientRows(renderSplash(100));
        setActiveThemeName(choice.name);
        setActiveThemeMode(mode);
        const rows = gradientRows(renderSplash(100));
        expect(rows.length).toBeGreaterThan(0);
        expect(rows).toEqual(reference);
        // Cells carry truecolor "r;g;b" (interpolateColor). Row start is the
        // cyan stop #00ffff exactly; the last cell sits one step short of the
        // purple stop #d000ff.
        for (const row of rows) {
          expect(row[0]).toBe('0;255;255');
          const [r, g, b] = row[row.length - 1]!.split(';').map(Number);
          expect(r).toBeGreaterThan(0xc0);
          expect(g).toBeLessThan(0x20);
          expect(b).toBe(255);
        }
      });
    }
  }
});
