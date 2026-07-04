import { center, getDisplayWidth, truncateDisplay } from './terminal-width.ts';
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

const versionLine = (version: string) =>
  `　✦　v${version}　█　terminal AI assistant　█　自動ｺｰﾄﾞ 　✦`;

/** Fixed hint line — the three primary shell entry points. */
const HINT_LINE = 'Ctrl+P panels  /  ? help  /  F2 fleet';

export interface SplashOptions {
  workingDir?: string;
  model?: string;
  provider?: string;
  toolCount?: number;
  /**
   * Session id of the most recent session, as resolved by readLastSessionPointer.
   * When present, the splash advertises a resume affordance.
   */
  lastSessionId?: string;
  /**
   * Version string rendered on the splash's version line. Defaults to the
   * build VERSION; injectable so the golden-frame tests can pin a fixture —
   * the version's display width shifts the line's centering, so goldens tied
   * to the live VERSION break on every release bump (v1.0.0 release failure).
   */
  version?: string;
}

/** Collapse a $HOME-prefixed working directory to a leading `~`. */
function collapseHome(dir: string): string {
  const home = typeof process !== 'undefined' ? process.env.HOME ?? '' : '';
  return home && dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
}

/** Center a meta line, truncating first so it never overflows the terminal width. */
function metaLine(text: string, columns: number): string {
  return center(truncateDisplay(text, Math.max(0, columns)), columns);
}

export function getSplashLines(columns: number, opts: SplashOptions = {}): string[] {
  const lines: string[] = [
    center(TOP_BORDER, columns),
    ...ART_LINES.map((line) => center(line, columns)),
    center(SEPARATOR, columns),
    center(TAGLINE, columns),
    center(versionLine(opts.version ?? VERSION), columns),
    '',
  ];

  // Live session context — real state pulled from SplashOptions rather than a
  // static "/help" signpost: model (provider) and tool count on one line, cwd
  // on the next.
  const contextBits: string[] = [];
  if (opts.model) {
    contextBits.push(opts.provider ? `${opts.model} (${opts.provider})` : opts.model);
  }
  if (typeof opts.toolCount === 'number') {
    contextBits.push(`${opts.toolCount} tool${opts.toolCount === 1 ? '' : 's'}`);
  }
  if (contextBits.length > 0) {
    lines.push(metaLine(contextBits.join('  ·  '), columns));
  }
  if (opts.workingDir) {
    lines.push(metaLine(collapseHome(opts.workingDir), columns));
  }

  // Last-session resume pointer (readLastSessionPointer result), when recorded.
  if (opts.lastSessionId) {
    lines.push(metaLine(`↩ resume last session — /sessions resume ${opts.lastSessionId}`, columns));
  }

  lines.push('');
  lines.push(metaLine(HINT_LINE, columns));

  return lines;
}
