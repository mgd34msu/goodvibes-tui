// ---------------------------------------------------------------------------
// status-glyphs.ts — canonical glyph map for status states.
//
// Extracted as a neutral module so both status-token.ts and polish.ts can
// import from here without creating a circular ESM dependency.
//
// Glyphs:
//   good  ✓  (CHECK MARK U+2713)
//   warn  ⚠  (WARNING SIGN U+26A0)
//   bad   ✕  (MULTIPLICATION X U+2715)
//   info  ○  (WHITE CIRCLE U+25CB)
// ---------------------------------------------------------------------------

export type StatusState = 'good' | 'warn' | 'bad' | 'info';

export const STATE_GLYPHS: Record<StatusState, string> = {
  good: '\u2713', // ✓
  warn: '\u26a0', // ⚠
  bad:  '\u2715', // ✕
  info: '\u25cb', // ○
};
