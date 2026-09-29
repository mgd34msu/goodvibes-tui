import { GLYPHS, SPINNER_FRAMES } from './ui-primitives.ts';
import { activeUiTones } from './theme.ts';

/**
 * Layout constants, single source of truth for margins and content width.
 * All renderers import these instead of hardcoding indent values. The object
 * itself lives in @pellux/goodvibes-terminal-shell alongside the transcript
 * tree geometry that reads LEFT_MARGIN/RIGHT_MARGIN out of it, so the margins
 * and the glyph columns derived from them cannot drift apart.
 */
export { TRANSCRIPT_LAYOUT as LAYOUT } from '@pellux/goodvibes-terminal-shell';

// `color` is a getter so it always reads the active theme.
export const BORDERS = {
  THINKING: { char: '▌', get color(): string { return activeUiTones().state.reasoning; } },
  ERROR:    { char: '▌', get color(): string { return activeUiTones().state.bad; } },
  WARNING:  { char: '▌', get color(): string { return activeUiTones().state.warn; } },
  INFO:     { char: '▌', get color(): string { return activeUiTones().state.info; } },
} as const;
