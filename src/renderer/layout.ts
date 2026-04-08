import { GLYPHS } from './ui-primitives.ts';

/**
 * Layout constants — single source of truth for margins and content width.
 * All renderers import these instead of hardcoding indent values.
 */
export const LAYOUT = {
  LEFT_MARGIN: 4,
  RIGHT_MARGIN: 2,
  contentWidth: (termWidth: number) => termWidth - LAYOUT.LEFT_MARGIN - LAYOUT.RIGHT_MARGIN,
  /** Used by createMessageBar in ui-factory.ts for user message ghost boxes. */
  USER_BOX_MARGIN: 2,
} as const;

export const TOOL_STATUS = {
  SUCCESS_ICON: GLYPHS.status.success,
  SPINNER_FRAMES: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  FAIL_ICON: GLYPHS.status.failure,
  PENDING_ICON: GLYPHS.status.pending,
  TOOL_NAME_PAD: 8,
} as const;

export const COLORS = {
  DIM_TEXT: '244',
} as const;

export const BORDERS = {
  THINKING: { char: '▌', color: '#9945FF' },
  ERROR:    { char: '▌', color: '#ef4444' },
  WARNING:  { char: '▌', color: '#eab308' },
  INFO:     { char: '▌', color: '#22d3ee' },
} as const;
