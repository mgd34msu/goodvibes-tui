// ---------------------------------------------------------------------------
// ui-primitives.ts — glyph registry + tone-token table.
//
// These four tables (GLYPHS, UI_TONES, DIFF_TONES, SPINNER_FRAMES) are
// no longer minted locally. They are the SDK presentation contract
// (@pellux/goodvibes-sdk/platform/presentation, already
// adopted by the agent), consumed here so the TUI and the agent
// share ONE source (Mike's move-to-SDK ruling — machinery needed by 2+
// surfaces => SDK). The TUI was the reference these values were lifted from
// verbatim, so this swap is byte-identical. See
// docs/decisions/2026-07-05-presentation-contract-sdk-extraction.md in the SDK.
//
// Re-exported under the historical names (GLYPHS, UI_TONES) so every existing
// importer keeps working with no call-site churn. UI_TONES is the dark-mode
// tone table (== resolveTones('dark')); light is resolved via theme.ts's
// activeUiTones() / resolveUiTones(), which composes the mode dimension over
// this dark constant unchanged.
// ---------------------------------------------------------------------------

import {
  GLYPHS,
  TONE_TOKENS,
  DIFF_TONES,
  SPINNER_FRAMES,
} from '@pellux/goodvibes-sdk/platform/presentation';

export { GLYPHS, DIFF_TONES, SPINNER_FRAMES };

/**
 * UI_TONES — the single chrome/color-token source for src/renderer and
 * src/panels. Concrete (dark-mode) values; resolveUiTones(mode) in theme.ts
 * is the single mode-resolved read path — this object is the 'dark' entry
 * (== resolveTones('dark') from the SDK presentation contract).
 */
export const UI_TONES = TONE_TOKENS;
