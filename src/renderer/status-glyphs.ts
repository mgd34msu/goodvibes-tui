// ---------------------------------------------------------------------------
// status-glyphs.ts — canonical glyph map for status states.
//
// Extracted as a neutral module so both status-token.ts and polish.ts can
// import from here without creating a circular ESM dependency.
//
// STATE_GLYPHS is no longer hardcoded here. It is the SDK presentation
// contract (@pellux/goodvibes-sdk/platform/presentation, and
// already adopted by the agent), aliased to GLYPHS.status so the
// four semantic glyphs are spelled out in exactly one place and can never
// drift from the registry again. Re-exported under the historical name so
// status-token.ts and polish.ts import unchanged.
//
// Glyphs (unchanged — this module's historical values, the TUI reference the
// contract was extracted from):
//   good  ✓  (CHECK MARK U+2713)     — GLYPHS.status.success
//   warn  ⚠  (WARNING SIGN U+26A0)    — GLYPHS.status.warn
//   bad   ✕  (MULTIPLICATION X U+2715) — GLYPHS.status.failure
//   info  ○  (WHITE CIRCLE U+25CB)    — GLYPHS.status.info
// ---------------------------------------------------------------------------

export { STATE_GLYPHS, type StatusState } from '@pellux/goodvibes-sdk/platform/presentation';
