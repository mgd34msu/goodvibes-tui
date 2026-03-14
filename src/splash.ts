/**
 * @module splash
 * Vaporwave ASCII art splash screen for goodvibes-tui.
 * Returns plain strings; the parent component handles colorization.
 */

import { VERSION } from './version.ts';
import { center } from './utils/terminal-width.ts';

/**
 * Raw art lines — "GOODVIBES" in box-drawing block letters.
 * Original polished style. Width: 72 chars.
 */
const ART_LINES = [
  ' ██████╗    ██████╗    ██████╗   ██████╗   ██╗   ██╗  ██╗  ██████╗   ███████╗  ███████╗',
  '██╔════╝   ██╔═══██╗  ██╔═══██╗  ██╔══██╗  ██║   ██║  ██║  ██╔══██╗  ██╔════╝  ██╔════╝',
  '██║  ███╗  ██║   ██║  ██║   ██║  ██║  ██║  ██║   ██║  ██║  ██████╔╝  █████╗    ███████╗',
  '██║   ██║  ██║   ██║  ██║   ██║  ██║  ██║  ╚██╗ ██╔╝  ██║  ██╔══██╗  ██╔══╝    ╚════██║',
  '╚██████╔╝  ╚██████╔╝  ╚██████╔╝  ██████╔╝   ╚████╔╝   ██║  ██████╔╝  ███████╗  ███████║',
  ' ╚═════╝    ╚═════╝    ╚═════╝   ╚═════╝     ╚═══╝    ╚═╝  ╚═════╝   ╚══════╝  ╚══════╝',
] as const;

const ART_W = 87;

// Splash lines (plain text, no ANSI), width anchored to ART_W
const TOP_BORDER    = '━'.repeat(ART_W);
const SEPARATOR     = '━'.repeat(ART_W);
const TAGLINE       = '[ ｇｏｏｄ ｖｉｂｅｓ ・ Ａ Ｉ ・ いい雰囲気 ]';
const VERSION_LINE  = ` ✦ v${VERSION}  ░  terminal AI assistant  ░  自動ｺｰﾄﾞ ✦ `;

// Ensure SPLASH_HEIGHT matches the number of lines getSplashLines returns
export const SPLASH_HEIGHT = 10;

/**
 * Generate the vaporwave splash screen.
 * @param columns - Available content width in columns (account for scrollbar).
 * @returns Array of plain strings, one per line. Length === SPLASH_HEIGHT.
 */
export function getSplashLines(columns: number): string[] {
  return [
    center(TOP_BORDER,   columns),  //  1: top gradient border
    center(ART_LINES[0], columns),  //  2: figlet row 1 (░)
    center(ART_LINES[1], columns),  //  3: figlet row 2 (░)
    center(ART_LINES[2], columns),  //  4: figlet row 3 (▒)
    center(ART_LINES[3], columns),  //  5: figlet row 4 (▓)
    center(ART_LINES[4], columns),  //  6: figlet row 5 (▓)
    center(ART_LINES[5], columns),  //  7: figlet row 6 (█)
    center(SEPARATOR,    columns),  //  8: thin separator
    center(TAGLINE,      columns),  //  9: Japanese / vaporwave tagline
    center(VERSION_LINE, columns),  // 10: version + subtitle
  ];
}
