export const GLYPHS = {
  frame: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
    teeLeft: '├',
    teeRight: '┤',
    teeTop: '┬',
    teeBottom: '┴',
    cross: '┼',
  },
  surface: {
    top: '▄',
    bottom: '▀',
    cursor: '█',
    altCursor: '▌',
  },
  navigation: {
    selected: '▸',
    collapsed: '▸',
    expanded: '▾',
    up: '↑',
    down: '↓',
    moreAbove: '▲',
    moreBelow: '▼',
    next: '→',
    back: '←',
    pipeSeparator: '│',
  },
  status: {
    success: '✓',
    failure: '✕',
    pending: '•',
    active: '●',
    idle: '◌',
    info: '○',
    warn: '⚠',
    blocked: '⊘',
    skipped: '◇',
    review: '◈',
    retry: '↻',
    handoff: '⇢',
    reference: '↗',
    partial: '◐',
    dualPane: '◆',
    star: '★',
  },
  meter: {
    filled: '█',
    medium: '▓',
    light: '▒',
    empty: '░',
    spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  },
} as const;

/**
 * UI_TONES — the single chrome/color-token source for src/renderer and
 * src/panels. Concrete (dark-mode) values; resolveUiTones(mode) in theme.ts
 * is the single mode-resolved read path — this object is the 'dark' entry.
 */
export const UI_TONES = {
  fg: {
    primary: '#e2e8f0',
    secondary: '#cbd5e1',
    muted: '#94a3b8',
    dim: '#475569',
    inverse: '#0f172a',
    /** Empty-state / placeholder foreground (formerly DEFAULT_PANEL_PALETTE.empty literal). */
    empty: '#334155',
  },
  bg: {
    base: '#11131a',
    surface: '#161a22',
    title: '#0f172a',
    section: '#18202b',
    summary: '#1b2430',
    selected: '#223049',
    input: '#1e293b',
    warning: '#2b2116',
    error: '#2a161b',
    success: '#14241b',
    /** Fullscreen/shell footer background. */
    footer: '#111827',
  },
  state: {
    info: '#38bdf8',
    good: '#22c55e',
    warn: '#f59e0b',
    bad: '#ef4444',
    blocked: '#f97316',
    active: '#60a5fa',
    /** Single canonical reasoning/thinking purple (replaces #9945FF and ad-hoc purples). */
    reasoning: '#a855f7',
  },
  accent: {
    browser: '#7dd3fc',
    control: '#22d3ee',
    inspector: '#c4b5fd',
    workflow: '#fbbf24',
    conversation: '#93c5fd',
    /** Neon brand accent — header/splash/thinking gradient only. */
    brand: '#00ffff',
    gradientStart: '#00ffff',
    gradientEnd: '#d000ff',
  },
  /** Canonical border stroke color for fullscreen/panel chrome. */
  border: '#64748b',
} as const;

/**
 * Diff surface accent color shared across the three diff-rendering surfaces —
 * the conversation diff view (diff-view.ts), the file diff panel
 * (diff-panel.ts), and the git panel's inline diff (git-panel.ts). Hunk-header
 * blue has no matching UI_TONES.state/accent role, so WO-204 gives it one
 * named token here (value converged on diff-panel.ts's pre-existing hunk
 * color, the only one of the three surfaces that predates this token; add/del
 * on all three surfaces already converge on UI_TONES.state.good/bad).
 */
export const DIFF_TONES = {
  hunk: '#88aaff',
} as const;

export type UiGlyphRegistry = typeof GLYPHS;

/** Single spinner-frame source — layout.ts and progress.ts both re-export this. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
