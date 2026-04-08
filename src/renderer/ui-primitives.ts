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
  },
  surface: {
    top: '▄',
    bottom: '▀',
    cursor: '█',
  },
  navigation: {
    selected: '▸',
    collapsed: '▸',
    expanded: '▾',
    up: '↑',
    down: '↓',
    pipeSeparator: '│',
  },
  status: {
    success: '✓',
    failure: '✕',
    pending: '•',
    active: '●',
    idle: '○',
    partial: '◐',
    dualPane: '◆',
  },
  meter: {
    filled: '█',
    empty: '░',
  },
} as const;

export type UiGlyphRegistry = typeof GLYPHS;
