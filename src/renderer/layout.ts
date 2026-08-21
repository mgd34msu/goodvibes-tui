import { GLYPHS, SPINNER_FRAMES, UI_TONES } from './ui-primitives.ts';

/**
 * Layout constants, single source of truth for margins and content width.
 * All renderers import these instead of hardcoding indent values. The object
 * itself lives in @pellux/goodvibes-terminal-shell alongside the transcript
 * tree geometry that reads LEFT_MARGIN/RIGHT_MARGIN out of it, so the margins
 * and the glyph columns derived from them cannot drift apart.
 */
export { TRANSCRIPT_LAYOUT as LAYOUT } from '@pellux/goodvibes-terminal-shell';

export const TOOL_STATUS = {
  SUCCESS_ICON: GLYPHS.status.success,
  SPINNER_FRAMES,
  FAIL_ICON: GLYPHS.status.failure,
  PENDING_ICON: GLYPHS.status.pending,
  TOOL_NAME_PAD: 8,
} as const;

export const BORDERS = {
  THINKING: { char: '▌', color: UI_TONES.state.reasoning },
  ERROR:    { char: '▌', color: UI_TONES.state.bad },
  WARNING:  { char: '▌', color: UI_TONES.state.warn },
  INFO:     { char: '▌', color: UI_TONES.state.info },
} as const;
