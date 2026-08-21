/**
 * theme.ts, Semantic colour token layer.
 *
 * Defines named tokens for every colour decision in the markdown/compositor/
 * conversation-rendering pipeline, resolved to concrete hex or ANSI-256 values
 * per background mode.
 *
 * Dark mode values are the historically used colours. Light mode values are
 * consumed when the terminal-background probe (terminal-bg-probe.ts) resolves a
 * light background under `display.themeMode: auto`, or when the owner forces
 * light. A caller with no mode of its own passes 'dark', the safe default for a
 * terminal whose background is unknown.
 *
 * IMPORTANT: inline code has NO background token. The bg:#1a1a1a hardcode
 * that previously existed caused a near-black box on light terminals.
 * Differentiate inline code via inlineCodeFg + bold only; bg inherits terminal.
 *
 * resolveUiTones(mode) is the sibling read path for CHROME tokens (UI_TONES
 * in ui-primitives.ts, panel/modal/overlay/fullscreen backgrounds, borders,
 * status colours). It composes the same ThemeMode dimension so that
 * DEFAULT_PANEL_PALETTE, DEFAULT_STYLE, FULLSCREEN_PALETTE and
 * DEFAULT_OVERLAY_PALETTE all read through ONE mode-resolved path instead of
 * importing the static UI_TONES constant directly, so one mode flip reaches
 * every one of them.
 */

import { UI_TONES } from './ui-primitives.ts';

/** Background mode, dark is the safe default for an unprobed terminal. */
export type ThemeMode = 'dark' | 'light';

/** Resolved semantic colour tokens (concrete hex strings or ANSI-256 indices). */
export interface ThemeTokens {
  /** H1 heading foreground + table header accent */
  heading1: string;
  /** H2 heading foreground */
  heading2: string;
  /** H3 heading foreground (ANSI-256, falls back to nearest on ansi256 terminals) */
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
  /** Blockquote / dim text foreground */
  blockquote: string;
  /** Assistant event-line marker + label accent */
  assistantHeader: string;
  /** Reasoning / thinking block accent */
  reasoningAccent: string;
  /** Tool call / active status accent (also diff/tool result label) */
  toolAccent: string;
  /** Collapsed-fragment body background (tool result preview bg) */
  collapsedBodyBg: string;
  /** Checked task-list checkbox foreground (✓ in green) */
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

// ---------------------------------------------------------------------------
// Dark palette
// ---------------------------------------------------------------------------
const DARK: ThemeTokens = {
  heading1:        '#00ffff',
  heading2:        '#00ffff',
  heading3:        '111',
  inlineCodeFg:    '#ffcc00',
  link:            '#00aaff',
  searchMatchBg:   '#806600',
  searchMatchFg:   '#ffffff',
  searchCurrentBg: '#ffff00',
  searchCurrentFg: '#000000',
  strikethrough:   '244',
  blockquote:      '244',
  assistantHeader: UI_TONES.accent.control,
  reasoningAccent: UI_TONES.state.reasoning,
  toolAccent:      UI_TONES.state.info,
  collapsedBodyBg: '#1a1a1a',
  checkboxChecked: '#22c55e',
  errorBarBg:      '#3a1a1a',
  modelNameDim:    '#94a3b8',
  toolNameFg:      '#e2e8f0',
  diffAccent:      '#f59e0b',
};

// ---------------------------------------------------------------------------
// Light palette
//
// Rationale per token:
//   heading1/2:        Deep teal (#0077aa), readable on white/cream terminals
//   heading3:          ANSI-256 #244 equivalent on light bg → use 24 (dark cyan)
//   inlineCodeFg:      Dark orange (#b45309), distinguishable without a box bg
//   link:              Standard blue (#0055cc), matches browser convention
//   searchMatchBg:     Muted yellow (#ffe066), visible on light bg
//   searchMatchFg:     Black (#000000)
//   searchCurrentBg:   Strong amber (#f59e0b), current match is more vivid
//   searchCurrentFg:   Black (#000000)
//   strikethrough:     Medium gray (ANSI-256 244 stays; light terminals map it fine)
//   blockquote:        Dim blue-gray (ANSI-256 67)
//   assistantHeader:   Dark cyan (#0e7490)
//   reasoningAccent:   Dark purple (#7c3aed)
//   toolAccent:        Dark sky (#0369a1)
//   collapsedBodyBg:   Very light gray (#f3f4f6)
//   checkboxChecked:   Forest green (#15803d), AA on white (contrast ~5.2:1 on #fff)
//   errorBarBg:        Soft rose (#fee2e2), light error bar bg, legible text on top
//   modelNameDim:      Slate-500 (#64748b), dim label; contrast ~4.6:1 on #fff
//   toolNameFg:        Slate-800 (#334155), strong enough for tool names
//   diffAccent:        Amber-700 (#b45309), darker amber, contrast ~4.7:1 on #fff
// ---------------------------------------------------------------------------
const LIGHT: ThemeTokens = {
  heading1:        '#0077aa',
  heading2:        '#0077aa',
  heading3:        '24',
  inlineCodeFg:    '#b45309',
  link:            '#0055cc',
  searchMatchBg:   '#ffe066',
  searchMatchFg:   '#000000',
  searchCurrentBg: '#f59e0b',
  searchCurrentFg: '#000000',
  strikethrough:   '244',
  blockquote:      '67',
  assistantHeader: '#0e7490',
  reasoningAccent: '#7c3aed',
  toolAccent:      '#0369a1',
  collapsedBodyBg: '#f3f4f6',
  checkboxChecked: '#15803d',
  errorBarBg:      '#fee2e2',
  modelNameDim:    '#64748b',
  toolNameFg:      '#334155',
  diffAccent:      '#b45309',
};

/**
 * resolveTheme, Return the semantic token set for the given background mode.
 *
 * Call with the session's resolved mode; 'dark' is the safe default for a
 * caller that has none. The returned object is frozen, do not mutate it.
 */
export function resolveTheme(mode: ThemeMode): Readonly<ThemeTokens> {
  return mode === 'light' ? LIGHT : DARK;
}

// Freeze both palette objects so they are truly immutable at runtime,
// matching the Readonly<ThemeTokens> return type in the doc comment above.
Object.freeze(DARK);
Object.freeze(LIGHT);

/**
 * Default dark-mode token set, exported for convenience.
 * Frozen, do not mutate.
 */
export const DARK_THEME: Readonly<ThemeTokens> = DARK;

// ---------------------------------------------------------------------------
// Chrome tokens (UI_TONES), mode-resolved sibling to resolveTheme().
//
// UI_TONES (ui-primitives.ts) is the dark entry. The light entry mirrors
// dark for every role that has no light-appropriate equivalent yet, the
// deliverable is the mode dimension and single read path, not a
// shipped light chrome theme (see module doc comment above).
// ---------------------------------------------------------------------------

/** Recursively widen the `as const` literal leaves of UI_TONES to `string`
 * so mode variants (e.g. UI_TONES_LIGHT) can assign different colour
 * values without fighting TypeScript's literal-type inference. */
type DeepWidenToString<T> = T extends string ? string : { [K in keyof T]: DeepWidenToString<T[K]> };

export type UiToneTokens = DeepWidenToString<typeof UI_TONES>;

//
// chrome.*, persistent header/footer/thinking foregrounds that paint on the
// TRANSPARENT terminal background (see the chrome group's doc in
// ui-primitives.ts). Unlike fg.muted/fg.dim (which stay light for the opaque
// dark modal/panel boxes), these invert toward dark so they read on a light
// terminal. Contrast ratios below are against a white terminal (#ffffff),
// matching the discipline of the LIGHT ThemeTokens above:
//   label: Slate-500 (#64748b), header title; ~4.9:1 on #fff (matches modelNameDim)
//   faint: Slate-400 (#94a3b8), version/rule/clean-git; ~2.7:1 on #fff, deliberately
//          faint (mirrors the low-contrast intent of the dark fg.dim role)
//   warn:  Amber-700 (#b45309), dirty git / pending risk; ~5.0:1 on #fff (matches diffAccent)
//   bad:   Red-600  (#dc2626), DANGER banner / shell risk (bold); ~5.3:1 on #fff
//   good:  Forest-700 (#15803d), tool-call ✓ status; ~5.02:1 on #fff (matches checkboxChecked)
//   remote: Violet-700 (#6d28d9), risk:remote marker / plain status; ~7.10:1 on #fff,
//          deliberately distinct from reasoningAccent (#7c3aed) so the remote-risk cue
//          never reads as a reasoning accent on a light terminal
const UI_TONES_LIGHT: UiToneTokens = {
  ...UI_TONES,
  state: {
    ...UI_TONES.state,
    info: LIGHT.toolAccent,
    reasoning: LIGHT.reasoningAccent,
  },
  accent: {
    ...UI_TONES.accent,
    brand: LIGHT.heading1,
    gradientStart: LIGHT.heading1,
    gradientEnd: LIGHT.reasoningAccent,
  },
  chrome: {
    ...UI_TONES.chrome,
    label: '#64748b',
    faint: '#94a3b8',
    warn:  '#b45309',
    bad:   '#dc2626',
    good:  '#15803d',
    remote: '#6d28d9',
  },
};

Object.freeze(UI_TONES_LIGHT.state);
Object.freeze(UI_TONES_LIGHT.accent);
Object.freeze(UI_TONES_LIGHT.chrome);
Object.freeze(UI_TONES_LIGHT);

/**
 * resolveUiTones, Return the chrome (panel/modal/overlay/fullscreen) token
 * set for the given background mode. Single read path for UI_TONES; the
 * 'dark' resolution is byte-identical to the UI_TONES constant.
 *
 * Prefer activeUiTones() at call sites, resolveUiTones is the pure per-mode
 * resolver underneath it.
 */
export function resolveUiTones(mode: ThemeMode): Readonly<UiToneTokens> {
  return mode === 'light' ? UI_TONES_LIGHT : UI_TONES;
}

// ===========================================================================
// Active-mode runtime.
//
// The mode is decided ONCE at startup, from appearance config (display.themeMode
// forced dark/light) or the terminal-background probe (auto), and is then stable
// for the session. Two read shapes exist because the two token layers are
// consumed differently:
//
//   - Transcript tokens (ThemeTokens): read live per render via activeTheme(),
//     so a dark→light repaint (auto mode, light wins within the probe window)
//     re-resolves without any module reload.
//
//   - Chrome tokens (UiToneTokens): baked into module-level palette CONSTANTS
//     (DEFAULT_PANEL_PALETTE, DEFAULT_OVERLAY_PALETTE, FULLSCREEN_PALETTE,
//     DEFAULT_STYLE) that hundreds of call sites read by reference. Those
//     constants cannot be re-resolved per call without a rewrite, so each owner
//     registers an in-place rebuild via registerThemeRefresh(); setActiveThemeMode
//     runs every rebuild in registration order (base palettes before the
//     extendPalette-derived panel palettes) so a single mode flip updates them
//     all. The rebuild is fully reversible: light→dark restores byte-identical
//     dark values (tests rely on this to keep the shared test process's default
//     at dark).
// ===========================================================================

/** User-facing appearance preference: auto probes the terminal; dark/light force. */
export type ThemeModeSetting = 'auto' | 'dark' | 'light';

/** The resolved mode in effect for the current session. Dark is the safe default. */
let activeMode: ThemeMode = 'dark';

/** In-place palette rebuilders, run (in registration order) on every mode flip. */
const themeRefreshers: Array<() => void> = [];

/**
 * Register an in-place palette rebuild to run whenever the active mode changes.
 * Base-palette owners register at their own module-eval time (before any
 * extendPalette-derived palette, which depends on the base), so refreshers run
 * base-first, the ordering the extended palettes require to re-merge correctly.
 */
export function registerThemeRefresh(rebuild: () => void): void {
  themeRefreshers.push(rebuild);
}

/**
 * Set the active background mode and rebuild every registered chrome palette
 * in place. Idempotent and reversible. Callers: startup (forced mode or probe
 * result) and the settings-modal change hook for forced modes.
 */
export function setActiveThemeMode(mode: ThemeMode): void {
  activeMode = mode;
  for (const rebuild of themeRefreshers) rebuild();
}

/** Transcript tokens for the active mode, read live, per render. */
export function activeTheme(): Readonly<ThemeTokens> {
  return resolveTheme(activeMode);
}

/** Chrome tokens for the active mode, used to build (and rebuild) palettes. */
export function activeUiTones(): Readonly<UiToneTokens> {
  return resolveUiTones(activeMode);
}
