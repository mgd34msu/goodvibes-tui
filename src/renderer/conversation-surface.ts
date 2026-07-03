import { type Line, createEmptyLine, createStyledCell } from '../types/grid.ts';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { LAYOUT } from './layout.ts';
import { GLYPHS } from './ui-primitives.ts';

export interface ConversationSurfacePalette {
  readonly accent: string;
  readonly text: string;
  readonly dim?: boolean;
  readonly bodyBg?: string;
  readonly italic?: boolean;
}

export interface ConversationFragmentPalette {
  readonly prefix: string;
  readonly prefixFg: string;
  readonly text: string;
  readonly bodyBg: string;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
}

export interface ConversationStatusSegment {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
}

export interface ConversationEventTone {
  readonly marker: string;
  readonly markerFg: string;
  readonly label: string;
  readonly labelFg: string;
  readonly detailFg?: string;
}

function writeText(
  line: Line,
  startCol: number,
  endColExclusive: number,
  text: string,
  fg: string,
  options: { readonly bg?: string; readonly bold?: boolean; readonly dim?: boolean; readonly italic?: boolean; readonly strikethrough?: boolean } = {},
): void {
  let col = startCol;
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (col + w > endColExclusive) break;
    line[col] = createStyledCell(ch, {
      fg,
      bg: options.bg ?? '',
      bold: options.bold ?? false,
      dim: options.dim ?? false,
      italic: options.italic ?? false,
      strikethrough: options.strikethrough ?? false,
    });
    if (w > 1 && col + 1 < endColExclusive) {
      line[col + 1] = createStyledCell('', {
        fg,
        bg: options.bg ?? '',
        bold: options.bold ?? false,
        dim: options.dim ?? false,
        italic: options.italic ?? false,
        strikethrough: options.strikethrough ?? false,
      });
    }
    col += w;
  }
}

export function renderConversationNotice(
  content: string,
  width: number,
  palette: ConversationSurfacePalette,
  marker = '▌',
): Line[] {
  const borderCol = LAYOUT.LEFT_MARGIN - 1;
  const textStartCol = LAYOUT.LEFT_MARGIN + 1;
  const textWidth = Math.max(1, width - textStartCol - LAYOUT.RIGHT_MARGIN);
  const wrapped = wrapText(content, textWidth);
  const lines: Line[] = [];

  for (const text of wrapped) {
    const line = createEmptyLine(width);
    line[borderCol] = createStyledCell(marker, { fg: palette.accent, bg: palette.bodyBg ?? '' });
    writeText(line, textStartCol, width - LAYOUT.RIGHT_MARGIN, text, palette.text, {
      bg: palette.bodyBg,
      dim: palette.dim ?? false,
      italic: palette.italic ?? false,
    });
    lines.push(line);
  }

  return lines;
}

export function renderConversationFragment(
  content: string,
  width: number,
  palette: ConversationFragmentPalette,
): Line[] {
  const margin = LAYOUT.USER_BOX_MARGIN;
  const prefixWidth = getDisplayWidth(palette.prefix);
  const maxContentWidth = Math.max(1, width - (margin * 2) - prefixWidth - 2);
  const wrapped = wrapText(content, maxContentWidth);
  const contentWidth = wrapped.length > 0 ? Math.max(...wrapped.map((line) => getDisplayWidth(line))) : 0;
  const fragmentWidth = Math.max(prefixWidth + 2, prefixWidth + contentWidth + 2);
  const startCol = margin;
  const lines: Line[] = [];

  const createFilledLine = (): Line => {
    const line = createEmptyLine(width);
    for (let x = 0; x < fragmentWidth && startCol + x < width; x++) {
      line[startCol + x] = createStyledCell(' ', {
        fg: palette.text,
        bg: palette.bodyBg,
        dim: palette.dim ?? false,
        italic: palette.italic ?? false,
        strikethrough: palette.strikethrough ?? false,
      });
    }
    return line;
  };

  const topLine = createEmptyLine(width);
  const bottomLine = createEmptyLine(width);
  for (let x = 0; x < fragmentWidth && startCol + x < width; x++) {
    topLine[startCol + x] = createStyledCell(GLYPHS.surface.top, {
      fg: palette.bodyBg,
      bg: '',
      dim: palette.dim ?? false,
      italic: palette.italic ?? false,
    });
    bottomLine[startCol + x] = createStyledCell(GLYPHS.surface.bottom, {
      fg: palette.bodyBg,
      bg: '',
      dim: palette.dim ?? false,
      italic: palette.italic ?? false,
    });
  }
  lines.push(topLine);
  for (let index = 0; index < wrapped.length; index++) {
    const line = createFilledLine();
    const prefix = index === 0 ? palette.prefix : ' '.repeat(prefixWidth);
    writeText(line, startCol, startCol + prefixWidth, prefix, palette.prefixFg, {
      bg: palette.bodyBg,
      dim: palette.dim ?? false,
      italic: palette.italic ?? false,
    });
    writeText(line, startCol + prefixWidth, startCol + fragmentWidth - 1, wrapped[index] ?? '', palette.text, {
      bg: palette.bodyBg,
      dim: palette.dim ?? false,
      italic: palette.italic ?? false,
      strikethrough: palette.strikethrough ?? false,
    });
    lines.push(line);
  }
  lines.push(bottomLine);
  return lines;
}

export function renderConversationCollapsedFragment(
  content: string,
  width: number,
  options: {
    readonly prefix?: string;
    readonly prefixFg?: string;
    readonly text?: string;
    readonly bodyBg?: string;
    readonly dim?: boolean;
    readonly italic?: boolean;
  } = {},
): Line[] {
  return renderConversationFragment(content, width, {
    prefix: options.prefix ?? ` ${GLYPHS.navigation.selected} `,
    prefixFg: options.prefixFg ?? '#38bdf8',
    text: options.text ?? '244',
    bodyBg: options.bodyBg ?? '#1a1a1a',
    dim: options.dim ?? true,
    italic: options.italic ?? false,
  });
}

export function renderConversationStatusLine(
  width: number,
  segments: readonly ConversationStatusSegment[],
  options: {
    readonly marker?: string;
    readonly markerFg?: string;
    readonly markerBg?: string;
    readonly bodyBg?: string;
  } = {},
): Line {
  const line = createEmptyLine(width);
  const markerCol = LAYOUT.LEFT_MARGIN - 1;
  const startCol = LAYOUT.LEFT_MARGIN + 1;
  const endCol = Math.max(startCol, width - LAYOUT.RIGHT_MARGIN);
  line[markerCol] = createStyledCell(options.marker ?? '▌', {
    fg: options.markerFg ?? '#64748b',
    bg: options.markerBg ?? options.bodyBg ?? '',
    bold: true,
  });
  let col = startCol;
  for (const segment of segments) {
    if (col >= endCol) break;
    writeText(line, col, endCol, segment.text, segment.fg, {
      bg: options.bodyBg,
      bold: segment.bold ?? false,
      dim: segment.dim ?? false,
      italic: segment.italic ?? false,
    });
    col += getDisplayWidth(segment.text);
  }
  return line;
}

export function renderConversationEventLine(
  width: number,
  tone: ConversationEventTone,
  details: readonly ConversationStatusSegment[] = [],
): Line {
  return renderConversationStatusLine(
    width,
    [
      { text: ` ${tone.label} `, fg: tone.labelFg, bold: true },
      ...details.map((segment) => ({
        ...segment,
        fg: segment.fg || tone.detailFg || tone.labelFg,
      })),
    ],
    {
      marker: tone.marker,
      markerFg: tone.markerFg,
    },
  );
}
