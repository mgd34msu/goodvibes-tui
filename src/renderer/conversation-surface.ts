import { type Line, createEmptyLine, createStyledCell } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { LAYOUT } from './layout.ts';
import { GLYPHS } from './ui-primitives.ts';
import { foldPreviewText } from '@pellux/goodvibes-terminal-shell';

/** Column of a transcript event row's marker (the ● of a flush row). */
const MARKER_COL = LAYOUT.LEFT_MARGIN - 1;
/** Column where the row's segment run begins (segments carry their own leading blank). */
const CONTENT_COL = MARKER_COL + 2;
import { activeTokens } from './theme.ts';

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
  // A fragment (a user message ghost box) keeps the box margin it has always used.
  const margin = LAYOUT.USER_BOX_MARGIN;
  const prefixWidth = getDisplayWidth(palette.prefix);
  // A narrow terminal shrinks the preview text instead of silently truncating its tail.
  const maxContentWidth = Math.max(1, width - margin - LAYOUT.USER_BOX_MARGIN - prefixWidth - 2);
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

/**
 * A COLLAPSED block, as exactly one row: the event line, with its preview
 * riding on the same line right after the badges.
 *
 * Collapsed blocks used to render as a framed fragment, a `▄▄▄` cap, an
 * interior line of text, a `▀▀▀` cap, around what was, in every case, a single
 * line. Four rows of chrome per fold made a screen of collapsed output mostly
 * frame. The text those rows carried moves onto the event line and the frame
 * goes; the `▸ N lines` badge is the count, so nothing restates it.
 *
 * The preview is TRUNCATED to fit, never wrapped: wrapping would put the row
 * back to two lines, which is the thing being removed. Whitespace is flattened
 * by the caller's choice of preview text, a raw tab or newline would blow the
 * column out.
 */
export function renderConversationFoldedRow(
  width: number,
  tone: ConversationEventTone,
  details: readonly ConversationStatusSegment[],
  preview: string,
): Line {
  // What is left of the row after the marker, the label and the badges.
  const usedCols = (tone.label ? getDisplayWidth(` ${tone.label} `) : 0)
    + details.reduce((sum, segment) => sum + getDisplayWidth(segment.text), 0);
  const availCols = width - LAYOUT.RIGHT_MARGIN - CONTENT_COL - usedCols - 1;
  // Whether a preview renders at all, and its flattening, are the policy's call
  // (foldPreviewText returns null for "no preview"). Only the TRUNCATION is
  // ours: display width is a product-local rule the policy deliberately leaves
  // to the caller, and it must truncate, never wrap.
  const trimmed = foldPreviewText(preview, availCols);
  if (trimmed === null) {
    return renderConversationEventLine(width, tone, details);
  }
  const text = getDisplayWidth(trimmed) > availCols
    ? `${trimmed.slice(0, Math.max(1, availCols - 1))}…`
    : trimmed;
  return renderConversationEventLine(
    width,
    tone,
    [...details, { text: `${text} `, fg: activeTokens().textFaint }],
  );
}

function renderConversationStatusLine(
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
  const markerCol = MARKER_COL;
  const startCol = CONTENT_COL;
  const endCol = Math.max(startCol, width - LAYOUT.RIGHT_MARGIN);
  const marker = options.marker ?? '▌';
  const markerWidth = getDisplayWidth(marker);
  if (markerCol >= 0 && markerCol < width && markerWidth > 0) {
    const markerStyle = {
      fg: options.markerFg ?? activeTokens().textMuted,
      bg: options.markerBg ?? options.bodyBg ?? '',
      bold: true,
    };
    line[markerCol] = createStyledCell(marker, markerStyle);
    // A double-width marker claims its trailing cell, so the segment run that
    // follows still starts where the grid says it does.
    if (markerWidth > 1 && markerCol + 1 < width) {
      line[markerCol + 1] = createStyledCell('', markerStyle);
    }
  }
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
  // An empty label is legitimate: the row then leads with its own first
  // informative detail segment.
  const labelSegments = tone.label
    ? [{ text: ` ${tone.label} `, fg: tone.labelFg, bold: true }]
    : [];
  return renderConversationStatusLine(
    width,
    [
      ...labelSegments,
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
