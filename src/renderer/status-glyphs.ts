// ---------------------------------------------------------------------------
// status-glyphs.ts — canonical glyph map for status states.
//
// Extracted as a neutral module so both status-token.ts and polish.ts can
// import from here without creating a circular ESM dependency.
//
// STATE_GLYPHS is an alias into GLYPHS.status (ui-primitives.ts) — the single
// glyph registry. Previously GLYPHS.status.info ('•') collided with
// GLYPHS.status.pending, and STATE_GLYPHS.info ('○') collided with
// GLYPHS.status.idle. GLYPHS.status.info is now '○' (this module's historical
// value) and idle uses a distinct glyph ('◌').
// ---------------------------------------------------------------------------

import { GLYPHS } from './ui-primitives.ts';

export type StatusState = 'good' | 'warn' | 'bad' | 'info';

export const STATE_GLYPHS: Record<StatusState, string> = {
  good: GLYPHS.status.success, // ✓
  warn: GLYPHS.status.warn,    // ⚠
  bad:  GLYPHS.status.failure, // ✕
  info: GLYPHS.status.info,    // ○
};
