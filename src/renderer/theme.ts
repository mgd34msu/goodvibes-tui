/**
 * theme.ts, the TUI's theme runtime.
 *
 * Every colour the TUI paints comes from ONE resolved token table: the active
 * theme (config `display.theme`) resolved for the active mode (config
 * `display.themeMode`, or the terminal-background probe under `auto`). The
 * theme data itself (bundled themes, the `system` theme generated from the
 * terminal palette, the resolver and its derived fallbacks) lives in the SDK
 * presentation contract; this module only holds the session state and the
 * read paths the renderer uses:
 *
 *   activeTokens()    the full resolved table (SDK ThemeTokens shape)
 *   activeTheme()     transcript tokens (markdown / conversation rendering)
 *   activeUiTones()   chrome tokens in the legacy TONE_TOKENS shape
 *   activeDiffTones() diff add/del/hunk in the legacy DIFF_TONES shape
 *
 * Theme names: every bundled theme, 'system', and the legacy 'vaporwave'
 * (an alias of 'goodvibes-neon', the pre-2026-09 look). Unknown names fall
 * back to the default theme. 'system' falls back to the default theme until a
 * terminal palette has been read (and stays there when the terminal answered
 * nothing).
 *
 * IMPORTANT: inline code has NO background token. Differentiate inline code
 * via inlineCodeFg + bold only; the background inherits the terminal.
 *
 * The protected splash gradient does NOT come from here; see splash-lines.ts.
 */

import {
  DEFAULT_THEME_NAME,
  SYSTEM_THEME_NAME,
  generateSystemTheme,
  getBundledTheme,
  listBundledThemes,
  resolveTheme as resolveThemeFile,
  themeToDiffTones,
  themeToTones,
  type DiffToneTokens,
  type ThemeTokens as PaletteTokens,
  type ToneTokens,
} from '@pellux/goodvibes-sdk/platform/presentation';
import { getTerminalPalette, type TerminalPalette } from './terminal-palette.ts';

export type { PaletteTokens, DiffToneTokens };

/** Background mode, dark is the safe default for an unprobed terminal. */
export type ThemeMode = 'dark' | 'light';

/** User-facing appearance preference: auto probes the terminal; dark/light force. */
export type ThemeModeSetting = 'auto' | 'dark' | 'light';

/** Legacy config value kept working: the old name of goodvibes-neon. */
const LEGACY_VAPORWAVE_THEME_NAME = 'vaporwave';
const NEON_THEME_NAME = 'goodvibes-neon';

/** Transcript tokens (markdown / conversation rendering), one mode. */
export interface ThemeTokens {
  /** H1 heading foreground + table header accent */
  heading1: string;
  /** H2 heading foreground */
  heading2: string;
  /** H3 heading foreground */
  heading3: string;
  /** Inline code foreground (bold is applied separately by caller) */
  inlineCodeFg: string;
  /** Hyperlink and bare-URL foreground */
  link: string;
  /** Non-current search match background */
  searchMatchBg: string;
  /** Non-current search match foreground */
  searchMatchFg: string;
  /** Current (focused) search match background */
  searchCurrentBg: string;
  /** Current (focused) search match foreground */
  searchCurrentFg: string;
  /** Strikethrough / muted text foreground */
  strikethrough: string;
  /** Blockquote text foreground */
  blockquote: string;
  /** Assistant event-line marker + label accent */
  assistantHeader: string;
  /** Reasoning / thinking block accent */
  reasoningAccent: string;
  /** Tool call / active status accent (also diff/tool result label) */
  toolAccent: string;
  /** Collapsed-fragment body background (tool result preview bg) */
  collapsedBodyBg: string;
  /** Checked task-list checkbox foreground */
  checkboxChecked: string;
  /** Error / cancelled message bar background */
  errorBarBg: string;
  /** Model name / provider dim label foreground */
  modelNameDim: string;
  /** Tool name foreground in tool-result event line */
  toolNameFg: string;
  /** Diff block accent, marker, label, and collapsed-prefix foreground */
  diffAccent: string;
}

/** Chrome tokens in the legacy TONE_TOKENS shape. */
export type UiToneTokens = ToneTokens;

/** One row of the theme picker: 'system' plus every bundled theme. */
export interface ThemeChoice {
  readonly name: string;
  readonly label: string;
  readonly variants: readonly ThemeMode[];
}

// ---------------------------------------------------------------------------
// Theme names
// ---------------------------------------------------------------------------

/** Every selectable theme: 'system' first, then the bundled catalog (default first). */
export function listThemeChoices(): ThemeChoice[] {
  return [
    { name: SYSTEM_THEME_NAME, label: 'System (terminal colors)', variants: ['dark', 'light'] },
    ...listBundledThemes().map(({ name, label, variants }) => ({ name, label, variants })),
  ];
}

/**
 * Turn a configured `display.theme` value into a theme name this runtime can
 * resolve: 'vaporwave' maps to 'goodvibes-neon', unknown or non-string values
 * map to the default theme.
 */
export function normalizeThemeName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_THEME_NAME;
  const name = raw.trim().toLowerCase();
  if (name === LEGACY_VAPORWAVE_THEME_NAME) return NEON_THEME_NAME;
  if (name === SYSTEM_THEME_NAME) return SYSTEM_THEME_NAME;
  return getBundledTheme(name) !== undefined ? name : DEFAULT_THEME_NAME;
}

// ---------------------------------------------------------------------------
// Resolution (cached per theme + mode; the system entry per probed palette)
// ---------------------------------------------------------------------------

interface ResolvedEntry {
  readonly palette: PaletteTokens;
  transcript?: Readonly<ThemeTokens>;
  tones?: Readonly<UiToneTokens>;
  diff?: Readonly<DiffToneTokens>;
}

const resolvedCache = new Map<string, ResolvedEntry>();
let systemCachePalette: TerminalPalette | null = null;

/** True when the probe returned at least one usable colour. */
function paletteHasColours(palette: TerminalPalette): boolean {
  return palette.background !== undefined
    || palette.foreground !== undefined
    || palette.ansi.some((slot) => slot !== undefined);
}

function resolveEntry(name: string, mode: ThemeMode): ResolvedEntry {
  if (name === SYSTEM_THEME_NAME) {
    const probed = getTerminalPalette();
    if (probed !== systemCachePalette) {
      for (const key of [...resolvedCache.keys()]) {
        if (key.startsWith(`${SYSTEM_THEME_NAME}:`)) resolvedCache.delete(key);
      }
      systemCachePalette = probed;
    }
    if (probed === null || !paletteHasColours(probed)) return resolveEntry(DEFAULT_THEME_NAME, mode);
  }
  const key = `${name}:${mode}`;
  const cached = resolvedCache.get(key);
  if (cached !== undefined) return cached;
  const json = name === SYSTEM_THEME_NAME
    ? generateSystemTheme(systemCachePalette!, mode)
    : (getBundledTheme(name) ?? getBundledTheme(DEFAULT_THEME_NAME)!).json;
  const entry: ResolvedEntry = { palette: Object.freeze(resolveThemeFile(json, mode)) };
  resolvedCache.set(key, entry);
  return entry;
}

function transcriptFrom(p: PaletteTokens): ThemeTokens {
  return {
    heading1: p.markdownHeading,
    heading2: p.markdownHeading,
    heading3: p.markdownHeading,
    inlineCodeFg: p.markdownCode,
    link: p.markdownLink,
    searchMatchBg: p.searchMatchBg,
    searchMatchFg: p.text,
    searchCurrentBg: p.searchCurrentBg,
    searchCurrentFg: p.selectedListItemText,
    strikethrough: p.textMuted,
    blockquote: p.markdownBlockQuote,
    assistantHeader: p.panelControl,
    reasoningAccent: p.reasoning,
    toolAccent: p.info,
    collapsedBodyBg: p.backgroundPanel,
    checkboxChecked: p.success,
    errorBarBg: p.backgroundError,
    modelNameDim: p.textMuted,
    toolNameFg: p.text,
    diffAccent: p.warning,
  };
}

/**
 * Transcript tokens of the active theme for `mode`. The returned object is
 * frozen and stable per (theme, mode), do not mutate it.
 */
export function resolveTheme(mode: ThemeMode): Readonly<ThemeTokens> {
  const entry = resolveEntry(activeThemeName, mode);
  entry.transcript ??= Object.freeze(transcriptFrom(entry.palette));
  return entry.transcript;
}

/**
 * Chrome tokens (legacy TONE_TOKENS shape) of the active theme for `mode`.
 * Prefer activeUiTones() at call sites.
 */
export function resolveUiTones(mode: ThemeMode): Readonly<UiToneTokens> {
  const entry = resolveEntry(activeThemeName, mode);
  entry.tones ??= Object.freeze(themeToTones(entry.palette));
  return entry.tones;
}

// ===========================================================================
// Active theme runtime.
//
// Theme name and mode are session state. Transcript tokens are read live per
// render (activeTheme()). Chrome palettes (DEFAULT_PANEL_PALETTE,
// DEFAULT_OVERLAY_PALETTE, FULLSCREEN_PALETTE, DEFAULT_STYLE, MODAL_TONES and
// every extendPalette result) are module-level objects read by reference at
// hundreds of call sites, so each owner registers an in-place rebuild via
// registerThemeRefresh(); every theme or mode change runs all rebuilds in
// registration order (base palettes before the extendPalette-derived ones).
// Callers that change the theme at runtime also request a full repaint.
// ===========================================================================

/** The resolved mode in effect for the current session. Dark is the safe default. */
let activeMode: ThemeMode = 'dark';

/** The theme in effect (already normalized). */
let activeThemeName: string = DEFAULT_THEME_NAME;

/** In-place palette rebuilders, run (in registration order) on every change. */
const themeRefreshers: Array<() => void> = [];

/**
 * Register an in-place palette rebuild to run whenever the active theme or
 * mode changes. Base-palette owners register at their own module-eval time,
 * before any extendPalette-derived palette (which depends on the base).
 */
export function registerThemeRefresh(rebuild: () => void): void {
  themeRefreshers.push(rebuild);
}

/** The entry for the active (theme, mode); cleared on every change. */
let activeEntry: ResolvedEntry | null = null;

function currentEntry(): ResolvedEntry {
  activeEntry ??= resolveEntry(activeThemeName, activeMode);
  return activeEntry;
}

function runRefreshers(): void {
  activeEntry = null;
  for (const rebuild of themeRefreshers) rebuild();
}

/**
 * Set the active background mode and rebuild every registered palette in
 * place. Idempotent and reversible.
 */
export function setActiveThemeMode(mode: ThemeMode): void {
  activeMode = mode;
  runRefreshers();
}

/**
 * Set the active theme by (configured) name and rebuild every registered
 * palette in place. Accepts any config value; see normalizeThemeName.
 * Returns the normalized name now in effect.
 */
export function setActiveThemeName(name: unknown): string {
  activeThemeName = normalizeThemeName(name);
  runRefreshers();
  return activeThemeName;
}

/**
 * Re-resolve after the terminal palette arrived or changed. Only the system
 * theme depends on it; for any other theme this is a no-op returning false.
 */
export function refreshForTerminalPalette(): boolean {
  if (activeThemeName !== SYSTEM_THEME_NAME) return false;
  runRefreshers();
  return true;
}

/** The normalized name of the active theme ('system' stays 'system'). */
export function getActiveThemeName(): string {
  return activeThemeName;
}

/** Full token table for the active theme and mode, read live. */
export function activeTokens(): Readonly<PaletteTokens> {
  return currentEntry().palette;
}

/** Transcript tokens for the active theme and mode, read live, per render. */
export function activeTheme(): Readonly<ThemeTokens> {
  const entry = currentEntry();
  entry.transcript ??= Object.freeze(transcriptFrom(entry.palette));
  return entry.transcript;
}

/** Chrome tokens for the active theme and mode, used to build (and rebuild) palettes. */
export function activeUiTones(): Readonly<UiToneTokens> {
  const entry = currentEntry();
  entry.tones ??= Object.freeze(themeToTones(entry.palette));
  return entry.tones;
}

/** Diff add/del/hunk tones for the active theme and mode. */
export function activeDiffTones(): Readonly<DiffToneTokens> {
  const entry = currentEntry();
  entry.diff ??= Object.freeze(themeToDiffTones(entry.palette));
  return entry.diff;
}
