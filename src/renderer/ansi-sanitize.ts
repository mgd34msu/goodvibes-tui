/**
 * ANSI sanitizer for untrusted content entering the renderer.
 *
 * The TUI grid renders content character-by-character via writeStyledText,
 * which already drops zero-width characters (including ESC \x1b) by checking
 * display width. However, that is incidental protection, not a contract.
 * This module provides explicit, intentional sanitization.
 *
 * Strategy:
 * - STRIP all non-SGR escape sequences (cursor moves, OSC, BEL, alt-screen,
 *   DECSET/private mode, and any other CSI/ESC sequences).
 * - PRESERVE SGR color/style codes (\x1b[<params>m), used legitimately by
 *   the TUI's own colorized output paths.
 * - STRIP bare BEL (\x07) characters.
 *
 * Safe SGR pattern: \x1b[ followed by digits/semicolons, ending in 'm'.
 * Everything else that starts with \x1b is dangerous and stripped.
 */

// Matches safe SGR sequences: ESC [ <digits/semicolons> m
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

// Matches ALL CSI sequences: ESC [ ... <final byte 0x40-0x7E>
const CSI_SEQUENCE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;

// Matches OSC sequences: ESC ] ... (ESC \ or BEL)
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Matches other ESC sequences (ESC + single character that is not '[' or ']')
const ESC_OTHER = /\x1b[^\[\]]/g;

// Matches standalone BEL
const BEL = /\x07/g;

/**
 * Strip dangerous ANSI escape sequences from untrusted content.
 *
 * Preserves SGR color codes (\x1b[<n>m). Removes:
 * - Cursor movement CSI sequences (\x1b[<n>A/B/C/D, \x1b[H, etc.)
 * - OSC sequences (\x1b]...\x07 or \x1b]...\x1b\\)
 * - Alt-screen and DECSET private mode (\x1b[?...h/l)
 * - Any other CSI or ESC sequences
 * - Bare BEL (\x07)
 *
 * @param input - Raw string that may contain ANSI escape sequences
 * @returns Sanitized string safe for grid rendering
 */
export function stripDangerousAnsi(input: string): string {
  // SGR sequences are extracted to placeholders before the other escape
  // sequences are stripped, then restored, to avoid complex negative
  // lookahead regexes.

  const sgrTokens: string[] = [];
  const withPlaceholders = input.replace(SGR_PATTERN, (match) => {
    const idx = sgrTokens.length;
    sgrTokens.push(match);
    return `\x00SGR${idx}\x00`;
  });

  // Strip all remaining dangerous sequences
  let sanitized = withPlaceholders
    .replace(CSI_SEQUENCE, '')   // removes cursor moves, alt-screen, DECSET, etc.
    .replace(OSC_SEQUENCE, '')   // removes OSC
    .replace(ESC_OTHER, '')      // removes remaining ESC+char sequences
    .replace(/\x1b/g, '')        // removes any leftover bare ESC
    .replace(BEL, '');           // removes BEL

  // Restore SGR sequences from placeholders
  sanitized = sanitized.replace(/\x00SGR(\d+)\x00/g, (_match, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return sgrTokens[idx] ?? '';
  });

  return sanitized;
}
