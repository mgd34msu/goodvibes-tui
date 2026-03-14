import { center } from './terminal-width.ts';
import { VERSION } from '../version.ts';

const ART_LINES = [
  ' ██████╗    ██████╗    ██████╗   ██████╗   ██╗   ██╗  ██╗  ██████╗   ███████╗  ███████╗',
  '██╔════╝   ██╔═══██╗  ██╔═══██╗  ██╔══██╗  ██║   ██║  ██║  ██╔══██╗  ██╔════╝  ██╔════╝',
  '██║  ███╗  ██║   ██║  ██║   ██║  ██║  ██║  ██║   ██║  ██║  ██████╔╝  █████╗    ███████╗',
  '██║   ██║  ██║   ██║  ██║   ██║  ██║  ██║  ╚██╗ ██╔╝  ██║  ██╔══██╗  ██╔══╝    ╚════██║',
  '╚██████╔╝  ╚██████╔╝  ╚██████╔╝  ██████╔╝   ╚████╔╝   ██║  ██████╔╝  ███████╗  ███████║',
  ' ╚═════╝    ╚═════╝    ╚═════╝   ╚═════╝     ╚═══╝    ╚═╝  ╚═════╝   ╚══════╝  ╚══════╝',
] as const;

const ART_W = 87;
const TOP_BORDER = '━'.repeat(ART_W);
const SEPARATOR = '━'.repeat(ART_W);

/**
 * Audit Fix: Full-width English characters for vaporwave aesthetic.
 * ｇｏｏｄ ｖｉｂｅｓ ・ Ａ Ｉ ・ いい雰囲気
 */
const TAGLINE = '[ ｇｏｏｄ ｖｉｂｅｓ ・ Ａ Ｉ ・ いい雰囲気 ]';

const VERSION_LINE = `  ✦ v${VERSION}  █  terminal AI assistant  █  自動ｺｰﾄﾞ  ✦`;

export interface SplashOptions {
  workingDir?: string;
  model?: string;
  provider?: string;
  toolCount?: number;
}

export function getSplashLines(columns: number, opts: SplashOptions = {}): string[] {
  const lines = [
    center(TOP_BORDER, columns),
    center(ART_LINES[0], columns),
    center(ART_LINES[1], columns),
    center(ART_LINES[2], columns),
    center(ART_LINES[3], columns),
    center(ART_LINES[4], columns),
    center(ART_LINES[5], columns),
    center(SEPARATOR, columns),
    center(TAGLINE, columns),
    center(VERSION_LINE, columns),
  ];

  // Just a simple hint on the splash
  lines.push(center('start chatting or type /help for commands', columns));

  return lines;
}
