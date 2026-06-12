/**
 * theme.ts — Semantic colour token layer.
 *
 * Defines named tokens for every colour decision in the markdown/compositor/
 * conversation-rendering pipeline, resolved to concrete hex or ANSI-256 values
 * per background mode.
 *
 * Dark mode values are the historically used colours.
 * Light mode values are defined now for correctness parity; they are consumed
 * when background-detection (F5 / terminal-bg-probe) lands and passes the
 * resolved mode down. Callers that do not yet have mode detection MUST call
 * resolveTheme('dark') as the safe default.
 *
 * IMPORTANT: inline code has NO background token. The bg:#1a1a1a hardcode
 * that previously existed caused a near-black box on light terminals.
 * Differentiate inline code via inlineCodeFg + bold only; bg inherits terminal.
 */

/** Background mode — dark is the safe default until terminal-bg-probe lands. */
export type ThemeMode = 'dark' | 'light';

/** Resolved semantic colour tokens (concrete hex strings or ANSI-256 indices). */
export interface ThemeTokens {
  /** H1 heading foreground + table header accent */
  heading1: string;
  /** H2 heading foreground */
  heading2: string;
  /** H3 heading foreground (ANSI-256 — falls back to nearest on ansi256 terminals) */
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
  /** Diff block accent — marker, label, and collapsed-prefix foreground */
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
  assistantHeader: '#22d3ee',
  reasoningAccent: '#a855f7',
  toolAccent:      '#38bdf8',
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
//   heading1/2:        Deep teal (#0077aa) — readable on white/cream terminals
//   heading3:          ANSI-256 #244 equivalent on light bg → use 24 (dark cyan)
//   inlineCodeFg:      Dark orange (#b45309) — distinguishable without a box bg
//   link:              Standard blue (#0055cc) — matches browser convention
//   searchMatchBg:     Muted yellow (#ffe066) — visible on light bg
//   searchMatchFg:     Black (#000000)
//   searchCurrentBg:   Strong amber (#f59e0b) — current match is more vivid
//   searchCurrentFg:   Black (#000000)
//   strikethrough:     Medium gray (ANSI-256 244 stays; light terminals map it fine)
//   blockquote:        Dim blue-gray (ANSI-256 67)
//   assistantHeader:   Dark cyan (#0e7490)
//   reasoningAccent:   Dark purple (#7c3aed)
//   toolAccent:        Dark sky (#0369a1)
//   collapsedBodyBg:   Very light gray (#f3f4f6)
//   checkboxChecked:   Forest green (#15803d) — AA on white (contrast ~5.2:1 on #fff)
//   errorBarBg:        Soft rose (#fee2e2) — light error bar bg, legible text on top
//   modelNameDim:      Slate-500 (#64748b) — dim label; contrast ~4.6:1 on #fff
//   toolNameFg:        Slate-800 (#334155) — strong enough for tool names
//   diffAccent:        Amber-700 (#b45309) — darker amber, contrast ~4.7:1 on #fff
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
 * resolveTheme — Return the semantic token set for the given background mode.
 *
 * Call with 'dark' (the safe default) until terminal-bg-probe lands.
 * The returned object is frozen; callers should not mutate it.
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
 * Frozen — do not mutate.
 */
export const DARK_THEME: Readonly<ThemeTokens> = DARK;
