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

const VERSION_LINE = `　✦　v${VERSION}　█　terminal AI assistant　█　自動ｺｰﾄﾞ 　✦`;

export interface SplashOptions {
  workingDir?: string;
  model?: string;
  provider?: string;
  toolCount?: number;
}

export function getSplashLines(columns: number, opts: SplashOptions = {}): string[] {
  const useCompact = columns < ART_W + 6;
  const compactWidth = 28;
  const compactBorder = '-'.repeat(compactWidth);
  const compactTitle = 'GOODVIBES';
  const compactTagline = '[ terminal AI ]';
  const compactVersionLine = `v${VERSION} | /help`;
  const splashHint = 'start chatting or type /help for commands';
  const compactSplashHint = 'start chatting or type /help';
  const lines: string[] = [
    center(useCompact ? compactBorder : TOP_BORDER, columns),
    ...(useCompact
      ? [
        center(compactTitle, columns),
        center(compactBorder, columns),
      ]
      : ART_LINES.map((line) => center(line, columns)).concat(center(SEPARATOR, columns))),
    center(useCompact ? compactTagline : TAGLINE, columns),
    center(useCompact ? compactVersionLine : VERSION_LINE, columns),
    '',
  ];

  lines.push(center(useCompact ? compactSplashHint : splashHint, columns));

  return lines;
}
