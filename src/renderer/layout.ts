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
  SUCCESS_ICON: '\u2713',   // ✓
  SPINNER_FRAMES: ['\u2819','\u2838','\u2834','\u2826','\u2807','\u280b','\u2819','\u2838'],
  FAIL_ICON: '\u2717',      // ✗
  PENDING_ICON: '\u2500',   // ─
  TOOL_NAME_PAD: 8,
} as const;

export const COLORS = {
  DIM_TEXT: '244',
} as const;

export const BORDERS = {
  THINKING: { char: '\u258D', color: '#9945FF' },  // ▍ in dim purple
  ERROR:    { char: '\u2502', color: '#ef4444' },   // │ in red
  WARNING:  { char: '\u2502', color: '#eab308' },   // │ in yellow
  INFO:     { char: '\u2502', color: '#22d3ee' },   // │ in cyan
} as const;
