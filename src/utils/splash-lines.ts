import { center, getDisplayWidth } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';
import { VERSION } from '../version.ts';

const ART_LINES = [
  ' ██████╗    ██████╗    ██████╗   ██████╗   ██╗   ██╗  ██╗  ██████╗   ███████╗  ███████╗',
  '██╔════╝   ██╔═══██╗  ██╔═══██╗  ██╔══██╗  ██║   ██║  ██║  ██╔══██╗  ██╔════╝  ██╔════╝',
  '██║  ███╗  ██║   ██║  ██║   ██║  ██║  ██║  ██║   ██║  ██║  ██████╔╝  █████╗    ███████╗',
  '██║   ██║  ██║   ██║  ██║   ██║  ██║  ██║  ╚██╗ ██╔╝  ██║  ██╔══██╗  ██╔══╝    ╚════██║',
  '╚██████╔╝  ╚██████╔╝  ╚██████╔╝  ██████╔╝   ╚████╔╝   ██║  ██████╔╝  ███████╗  ███████║',
  ' ╚═════╝    ╚═════╝    ╚═════╝   ╚═════╝     ╚═══╝    ╚═╝  ╚═════╝   ╚══════╝  ╚══════╝',
] as const;

const ART_W = Math.max(...ART_LINES.map((line) => getDisplayWidth(line)));
const TOP_BORDER = '━'.repeat(ART_W);
const SEPARATOR = '━'.repeat(ART_W);

/**
 * Audit Fix: Full-width English characters for vaporwave aesthetic.
 * ｇｏｏｄ ｖｉｂｅｓ ・ Ａ Ｉ ・ いい雰囲気
 */
const TAGLINE = '[ ｇｏｏｄ ｖｉｂｅｓ ・ Ａ Ｉ ・ いい雰囲気 ]';

const VERSION_LINE = `　✦　v${VERSION}　█　terminal AI assistant　█　自動ｺｰﾄﾞ 　✦`;

export interface SplashOptions {
  workingDir?: string;
  model?: string;
  provider?: string;
  toolCount?: number;
}

export function getSplashLines(columns: number, opts: SplashOptions = {}): string[] {
  const splashHint = 'start chatting or type /help for commands';
  const lines: string[] = [
    center(TOP_BORDER, columns),
    ...ART_LINES.map((line) => center(line, columns)),
    center(SEPARATOR, columns),
    center(TAGLINE, columns),
    center(VERSION_LINE, columns),
    '',
  ];

  lines.push(center(splashHint, columns));

  return lines;
}
