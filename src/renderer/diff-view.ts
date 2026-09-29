import { type Line, type Cell, createStyledCell } from '@pellux/goodvibes-sdk/platform/types';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth, padDisplayEnd } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';

/**
 * renderDiffView - Render a unified diff string as styled Line[].
 * Colours come from the active theme's diff tokens (diffAdded/diffRemoved/
 * diffHunkHeader, the matching backgrounds and the line-number tokens), shared
 * with diff-panel.ts and git-panel.ts's inline diff.
 */
/** Columns between the diff's fill edges and its text. */
const DIFF_PAD = 2;

export function renderDiffView(diffText: string, width: number, filename?: string): Line[] {
  const lines: Line[] = [];
  const p = activeTokens();
  const BG = p.diffContextBg;

  // Filename header
  if (filename) {
    const header = `  ≡ ${filename} `;
    lines.push(UIFactory.stringToLine(padDisplayEnd(header, width), width, { fg: p.selectedListItemText, bg: p.diffHunkHeader, bold: true }));
  }

  const diffLines = diffText.split('\n');
  let oldLineNo = 0;
  let newLineNo = 0;
  // The diff is one filled block: an empty row above and below, and text two
  // columns in from both edges (the Measurements padding rule).
  lines.push(makeFilledLine(width, BG));

  for (const raw of diffLines) {
    if (raw === '') {
      const emptyLine = makeFilledLine(width, BG);
      lines.push(emptyLine);
      continue;
    }

    // Hunk header: @@ -old,count +new,count @@
    if (raw.startsWith('@@')) {
      const hunkMatch = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        oldLineNo = parseInt(hunkMatch[1], 10) - 1;
        newLineNo = parseInt(hunkMatch[2], 10) - 1;
      }
      lines.push(makeStyledLine(raw, width, p.diffHunkHeader, BG, false));
      continue;
    }

    // File headers: --- and +++
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      lines.push(makeStyledLine(raw, width, p.textMuted, BG, false));
      continue;
    }

    // Added line
    if (raw.startsWith('+')) {
      newLineNo++;
      const lineLabel = `${String(newLineNo).padStart(4)} `;
      const content = raw.slice(1);
      lines.push(makeGutterLine('+', lineLabel, content, width, p.diffAdded, p.diffAddedBg, p.diffAddedLineNumberBg));
      continue;
    }

    // Removed line
    if (raw.startsWith('-')) {
      oldLineNo++;
      const lineLabel = `${String(oldLineNo).padStart(4)} `;
      const content = raw.slice(1);
      lines.push(makeGutterLine('-', lineLabel, content, width, p.diffRemoved, p.diffRemovedBg, p.diffRemovedLineNumberBg));
      continue;
    }

    // Context line
    if (raw.startsWith(' ') || (!raw.startsWith('\\') && raw.length > 0)) {
      oldLineNo++;
      newLineNo++;
      const lineLabel = `${String(oldLineNo).padStart(4)} `;
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      lines.push(makeGutterLine(' ', lineLabel, content, width, p.diffContext, BG, BG));
    }
  }

  lines.push(makeFilledLine(width, BG));
  return lines;
}

/** Build a line with gutter indicator, line number, and content. */
function makeGutterLine(
  gutter: string,
  lineLabel: string,
  content: string,
  width: number,
  fg: string,
  bg: string,
  lineNumBg: string,
): Line {
  const line = makeFilledLine(width, bg);
  const end = width - DIFF_PAD;
  let cx = DIFF_PAD;

  // Gutter char
  line[cx++] = createStyledCell(gutter, { fg, bg, bold: gutter !== ' ' });

  // Line number
  for (const ch of lineLabel) {
    if (cx >= width) break;
    line[cx++] = createStyledCell(ch, { fg: activeTokens().diffLineNumber, bg: lineNumBg });
  }

  // Content
  for (const ch of content) {
    const cw = getDisplayWidth(ch);
    if (cx + Math.max(1, cw) > end) break;
    const code = ch.charCodeAt(0);
    if (code < 32) { cx++; continue; }
    line[cx] = createStyledCell(ch, { fg, bg });
    if (cw === 2) line[cx + 1] = { ...line[cx], char: '' };
    cx += cw;
  }

  return line;
}

/** Build a simple styled line from text. */
function makeStyledLine(text: string, width: number, fg: string, bg: string, bold: boolean): Line {
  const line = makeFilledLine(width, bg);
  const end = width - DIFF_PAD;
  let cx = DIFF_PAD;
  for (const ch of text) {
    const cw = getDisplayWidth(ch);
    if (cx + Math.max(1, cw) > end) break;
    const code = ch.charCodeAt(0);
    if (code < 32) { cx++; continue; }
    line[cx] = createStyledCell(ch, { fg, bg, bold });
    if (cw === 2) line[cx + 1] = { ...line[cx], char: '' };
    cx += cw;
  }
  return line;
}

/** Create a line filled with bg color. */
function makeFilledLine(width: number, bg: string): Cell[] {
  return Array.from({ length: width }, () => createStyledCell(' ', { bg }));
}
