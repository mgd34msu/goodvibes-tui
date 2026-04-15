import { type Line, type Cell, createStyledCell } from '@pellux/goodvibes-sdk/platform/types/grid';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';

/**
 * renderDiffView - Render a unified diff string as styled Line[].
 * '+' lines in green, '-' lines in red, '@@' hunks in cyan.
 */
export function renderDiffView(diffText: string, width: number, filename?: string): Line[] {
  const lines: Line[] = [];
  const BG = '#0a0a0a';

  // Filename header
  if (filename) {
    const header = ` ≡ ${filename} `;
    lines.push(UIFactory.stringToLine(header.padEnd(width), width, { fg: '#1a1a1a', bg: '#569cd6', bold: true }));
  }

  const diffLines = diffText.split('\n');
  let oldLineNo = 0;
  let newLineNo = 0;

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
      lines.push(makeStyledLine(raw, width, '#00bcd4', '#0f1f1f', false));
      continue;
    }

    // File headers: --- and +++
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      lines.push(makeStyledLine(raw, width, '244', BG, false));
      continue;
    }

    // Added line
    if (raw.startsWith('+')) {
      newLineNo++;
      const lineLabel = `${String(newLineNo).padStart(4)} `;
      const content = raw.slice(1);
      lines.push(makeGutterLine('+', lineLabel, content, width, '#22c55e', '#0a1a0a'));
      continue;
    }

    // Removed line
    if (raw.startsWith('-')) {
      oldLineNo++;
      const lineLabel = `${String(oldLineNo).padStart(4)} `;
      const content = raw.slice(1);
      lines.push(makeGutterLine('-', lineLabel, content, width, '#ef4444', '#1a0a0a'));
      continue;
    }

    // Context line
    if (raw.startsWith(' ') || (!raw.startsWith('\\') && raw.length > 0)) {
      oldLineNo++;
      newLineNo++;
      const lineLabel = `${String(oldLineNo).padStart(4)} `;
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      lines.push(makeGutterLine(' ', lineLabel, content, width, '244', BG));
    }
  }

  return lines;
}

/** Build a line with gutter indicator, line number, and content. */
function makeGutterLine(
  gutter: string,
  lineLabel: string,
  content: string,
  width: number,
  fg: string,
  bg: string
): Line {
  const line = makeFilledLine(width, bg);
  let cx = 0;

  // Gutter char
  line[cx++] = createStyledCell(gutter, { fg, bg, bold: gutter !== ' ' });

  // Line number
  for (const ch of lineLabel) {
    if (cx >= width) break;
    line[cx++] = createStyledCell(ch, { fg: '238', bg, dim: true });
  }

  // Content
  for (const ch of content) {
    if (cx >= width) break;
    const cw = getDisplayWidth(ch);
    const code = ch.charCodeAt(0);
    if (code < 32) { cx++; continue; }
    line[cx] = createStyledCell(ch, { fg, bg });
    if (cw === 2 && cx + 1 < width) line[cx + 1] = { ...line[cx], char: '' };
    cx += cw;
  }

  return line;
}

/** Build a simple styled line from text. */
function makeStyledLine(text: string, width: number, fg: string, bg: string, bold: boolean): Line {
  const line = makeFilledLine(width, bg);
  let cx = 0;
  for (const ch of text) {
    if (cx >= width) break;
    const cw = getDisplayWidth(ch);
    const code = ch.charCodeAt(0);
    if (code < 32) { cx++; continue; }
    line[cx] = createStyledCell(ch, { fg, bg, bold });
    if (cw === 2 && cx + 1 < width) line[cx + 1] = { ...line[cx], char: '' };
    cx += cw;
  }
  return line;
}

/** Create a line filled with bg color. */
function makeFilledLine(width: number, bg: string): Cell[] {
  return Array.from({ length: width }, () => createStyledCell(' ', { bg }));
}
