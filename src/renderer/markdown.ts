import { type Line, type Cell, createStyledCell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { renderCodeBlock } from './code-block.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { LAYOUT } from './layout.ts';

export interface MarkdownRenderOptions {
  codeBlockLineNumbers?: boolean;
}

/** Module-level set of inline markdown special characters (hoisted out of hot loop). */
const INLINE_SPECIAL_CHARS = new Set(['[', '`', '*', '_', '~']);

function splitTableCells(row: string): string[] {
  const cells = row.trim().split('|').map((c) => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function isLikelyTableSeparatorRow(row: string): boolean {
  if (!row.includes('|')) return false;
  const cells = splitTableCells(row);
  if (cells.length === 0) return false;
  return cells.every((cell) => /:?-{3,}:?/.test(cell));
}

function isLikelyTableHeaderRow(row: string): boolean {
  return splitTableCells(row).length >= 2;
}

/**
 * renderMarkdown - Parse markdown text into styled Line[].
 * Thin wrapper over renderMarkdownTracked for callers that don't need code-block metadata.
 */
export function renderMarkdown(text: string, width: number, options: MarkdownRenderOptions = {}): Line[] {
  return renderMarkdownTracked(text, width, options).lines;
}

export interface CodeBlockSpan {
  /** Line offset from the start of renderMarkdown output where this block begins. */
  startOffset: number;
  /** Number of rendered lines occupied by this code block. */
  lineCount: number;
  /** Raw source lines inside the fence (no fence markers). */
  rawContent: string;
}

/**
 * renderMarkdownTracked - Same as renderMarkdown but also returns metadata
 * about every code block encountered, keyed by their line offset in the output.
 * Used by ConversationManager to register code blocks in the blockRegistry.
 */
export function renderMarkdownTracked(
  text: string,
  width: number,
  options: MarkdownRenderOptions = {},
): { lines: ReturnType<typeof renderMarkdown>; codeBlocks: CodeBlockSpan[] } {
  const lines: ReturnType<typeof renderMarkdown> = [];
  const codeBlocks: CodeBlockSpan[] = [];
  const rawLines = text.split('\n');

  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];
  const indent = LAYOUT.LEFT_MARGIN;
  const contentWidth = LAYOUT.contentWidth(width);

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];

    const fenceMatch = raw.match(/^```(\w*)/);
    if (fenceMatch && !inCodeBlock) {
      inCodeBlock = true;
      codeBlockLang = fenceMatch[1] || '';
      codeBlockLines = [];
      continue;
    }
    if (inCodeBlock) {
      if (raw.trimStart().startsWith('```')) {
        const blockStart = lines.length;
        const rendered = renderCodeBlock(codeBlockLines, codeBlockLang, width, {
          showLineNumbers: options.codeBlockLineNumbers ?? true,
        });
        codeBlocks.push({
          startOffset: blockStart,
          lineCount: rendered.length,
          rawContent: codeBlockLines.join('\n'),
        });
        lines.push(...rendered);
        inCodeBlock = false;
        codeBlockLang = '';
        codeBlockLines = [];
      } else {
        codeBlockLines.push(raw);
      }
      continue;
    }

    if (raw.trim() === '') {
      lines.push(UIFactory.stringToLine('', width));
      continue;
    }

    const h3 = raw.match(/^### (.+)/);
    const h2 = raw.match(/^## (.+)/);
    const h1 = raw.match(/^# (.+)/);
    if (h1) {
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + h1[1].toUpperCase(), width, { fg: '#00ffff', bold: true }));
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + '━'.repeat(Math.min(getDisplayWidth(h1[1]), contentWidth)), width, { fg: '244' }));
      continue;
    }
    if (h2) {
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + h2[1], width, { fg: '#00ffff', bold: true }));
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + '─'.repeat(Math.min(getDisplayWidth(h2[1]), contentWidth)), width, { fg: '240' }));
      continue;
    }
    if (h3) {
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + h3[1], width, { fg: '111', bold: true }));
      continue;
    }

    const taskMatch = raw.match(/^(\s*)[-*] \[([ xX])\] (.+)/);
    if (taskMatch) {
      const listIndent = Math.floor(taskMatch[1].length / 2);
      const checked = taskMatch[2] !== ' ';
      const bulletX = indent + listIndent * 2;
      const textStartX = bulletX + 4;
      const checkbox = checked ? '\u2611 ' : '\u2610 ';
      const rendered = renderInlineMarkdown(taskMatch[3]);
      const prefix = ' '.repeat(bulletX) + checkbox;
      const style = checked ? { fg: '244', strikethrough: true } : {};
      lines.push(...compositeInlineLine(prefix, rendered, width, { fg: checked ? '#22c55e' : '252', ...style }, textStartX));
      continue;
    }

    const ulMatch = raw.match(/^(\s*)[-*] (.+)/);
    if (ulMatch) {
      const listIndent = Math.floor(ulMatch[1].length / 2);
      const bulletX = indent + listIndent * 2;
      const textStartX = bulletX + 2;
      const rendered = renderInlineMarkdown(ulMatch[2]);
      const prefix = ' '.repeat(bulletX) + '• ';
      lines.push(...compositeInlineLine(prefix, rendered, width, { fg: '135', bold: false }, textStartX));
      continue;
    }

    const olMatch = raw.match(/^(\s*)(\d+)\. (.+)/);
    if (olMatch) {
      const listIndent = Math.floor(olMatch[1].length / 2);
      const numStr = olMatch[2] + '. ';
      const bulletX = indent + listIndent * 2;
      const textStartX = bulletX + numStr.length;
      const rendered = renderInlineMarkdown(olMatch[3]);
      const prefix = ' '.repeat(bulletX) + numStr;
      lines.push(...compositeInlineLine(prefix, rendered, width, { fg: '135', bold: false }, textStartX));
      continue;
    }

    if (/^[-*_]{3,}$/.test(raw.trim())) {
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + '─'.repeat(contentWidth), width, { fg: '240' }));
      continue;
    }

    const bqMatch = raw.match(/^> (.*)/);
    if (bqMatch) {
      const rendered = renderInlineMarkdown(bqMatch[1]);
      const prefix = ' '.repeat(indent) + '┃ ';
      lines.push(...compositeInlineLine(prefix, rendered, width, { fg: '244', italic: true }, indent + 3));
      continue;
    }

    if (raw.includes('|') && i + 1 < rawLines.length && isLikelyTableHeaderRow(raw) && isLikelyTableSeparatorRow(rawLines[i + 1])) {
      const tableRows: string[] = [];
      let j = i;
      while (j < rawLines.length && rawLines[j].includes('|')) {
        tableRows.push(rawLines[j]);
        j++;
      }
      i = j - 1;
      lines.push(...renderTable(tableRows, width, indent));
      continue;
    }

    const rendered = renderInlineMarkdown(raw);
    lines.push(...compositeInlineLine(' '.repeat(indent), rendered, width, {}, indent));
  }

  if (inCodeBlock && codeBlockLines.length > 0) {
    const blockStart = lines.length;
    const rendered = renderCodeBlock(codeBlockLines, codeBlockLang, width, {
      showLineNumbers: options.codeBlockLineNumbers ?? true,
    });
    codeBlocks.push({
      startOffset: blockStart,
      lineCount: rendered.length,
      rawContent: codeBlockLines.join('\n'),
    });
    lines.push(...rendered);
  }

  return { lines, codeBlocks };
}

/**
 * Strip markdown formatting from text for width measurement.
 * Removes **, *, `, ~~ markers but keeps the inner text.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
    .replace(/\*(.+?)\*/g, '$1')      // italic
    .replace(/~~(.+?)~~/g, '$1')      // strikethrough
    .replace(/`(.+?)`/g, '$1');       // inline code
}

/**
 * Render a markdown table with box-drawing borders.
 * Parses inline markdown in cells, fits to terminal width,
 * truncates long content, and renders with proper styling.
 */
function renderTable(rows: string[], width: number, indent: number): Line[] {
  const lines: Line[] = [];

  // Parse rows into cells, skip separator
  const parsedRows: string[][] = [];
  let hasSeparator = false;
  for (const row of rows) {
    const trimmed = row.trim();
    if (isLikelyTableSeparatorRow(trimmed)) {
      hasSeparator = true;
      continue;
    }
    const cells = splitTableCells(trimmed);
    if (cells.length > 0) parsedRows.push(cells);
  }

  if (parsedRows.length === 0) return lines;

  const colCount = Math.max(...parsedRows.map(r => r.length));
  const availW = width - indent;

  // Measure column widths using stripped text (no markdown markers)
  const naturalWidths: number[] = new Array(colCount).fill(0);
  for (const row of parsedRows) {
    for (let c = 0; c < row.length; c++) {
      naturalWidths[c] = Math.max(naturalWidths[c], getDisplayWidth(stripMarkdown(row[c])));
    }
  }

  // Budget: availW minus borders (colCount+1) minus padding (2 per col)
  const overhead = (colCount + 1) + (colCount * 2);
  const contentBudget = Math.max(colCount, availW - overhead);
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);

  // Compute final column widths
  const colWidths: number[] = new Array(colCount).fill(0);
  if (totalNatural <= contentBudget) {
    // Everything fits
    for (let c = 0; c < colCount; c++) colWidths[c] = naturalWidths[c];
  } else {
    // Proportionally shrink, with minimum of 4 chars per column
    const minW = 4;
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(minW, Math.floor((naturalWidths[c] / totalNatural) * contentBudget));
    }
    // Distribute leftover from rounding
    let used = colWidths.reduce((a, b) => a + b, 0);
    for (let c = 0; c < colCount && used < contentBudget; c++) {
      colWidths[c]++;
      used++;
    }
  }

  const bc = '240'; // border color

  // Helper: build a border line
  const makeBorder = (left: string, mid: string, right: string, horiz: string): Line => {
    let s = ' '.repeat(indent) + left;
    for (let c = 0; c < colCount; c++) {
      s += horiz.repeat(colWidths[c] + 2) + (c < colCount - 1 ? mid : right);
    }
    return UIFactory.stringToLine(s, width, { fg: bc });
  };

  // Helper: render a cell's content with inline markdown into Cell[]
  const renderCellContent = (raw: string, maxW: number, isHdr: boolean): Cell[] => {
    const cells: Cell[] = [];
    const tokens = renderInlineMarkdown(raw);
    let w = 0;

    for (const token of tokens) {
      const text = token.text;
      for (const ch of text) {
        const cw = getDisplayWidth(ch);
        if (w + cw > maxW) {
          // Truncate with ellipsis
          if (cells.length > 0) cells[cells.length - 1] = createStyledCell('\u2026', cells[cells.length - 1]);
          return cells;
        }
        let style: Partial<Cell> = {};
        if (token.type === 'code') {
          style = { fg: '#ffcc00', bg: '#1a1a1a' };
        } else if (token.type === 'link') {
          style = { fg: '#00aaff', underline: true };
        } else {
          style = { ...token.style };
        }
        if (isHdr) {
          style.fg = style.fg || '#00ffff';
          style.bold = true;
        } else {
          style.fg = style.fg || '252';
        }
        cells.push(createStyledCell(ch, style));
        if (cw === 2) cells.push(createStyledCell('', style)); // wide char placeholder
        w += cw;
      }
    }

    // Pad remaining space
    while (w < maxW) {
      cells.push(createStyledCell(' ', isHdr ? { fg: '#00ffff' } : { fg: '252' }));
      w++;
    }
    return cells;
  };

  // Top border
  lines.push(makeBorder('\u250c', '\u252c', '\u2510', '\u2500'));

  // Rows
  for (let r = 0; r < parsedRows.length; r++) {
    const row = parsedRows[r];
    const isHeader = hasSeparator && r === 0;

    // Build the row line cell-by-cell
    const line = new Array(width).fill(null).map(() => createStyledCell(' ')) as Cell[];
    let x = indent;

    // Left border
    if (x < width) line[x] = createStyledCell('\u2502', { fg: bc });
    x++;

    for (let c = 0; c < colCount; c++) {
      // Space before content
      if (x < width) line[x] = createStyledCell(' ');
      x++;

      // Cell content
      const raw = c < row.length ? row[c] : '';
      const cellContent = renderCellContent(raw, colWidths[c], isHeader);
      for (const cell of cellContent) {
        if (x < width) line[x] = cell;
        x++;
      }

      // Space after content
      if (x < width) line[x] = createStyledCell(' ');
      x++;

      // Column separator
      if (x < width) line[x] = createStyledCell('\u2502', { fg: bc });
      x++;
    }

    lines.push(line);

    // Header separator
    if (isHeader) {
      lines.push(makeBorder('\u251c', '\u253c', '\u2524', '\u2500'));
    }
  }

  // Bottom border
  lines.push(makeBorder('\u2514', '\u2534', '\u2518', '\u2500'));

  return lines;
}

/**
 * Inline markdown token types.
 */
type InlineToken =
  | { type: 'text'; text: string; style: Partial<Cell> }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string };

/**
 * renderInlineMarkdown - Parse inline markdown (bold, italic, inline code, links)
 * and return a flat array of tokens with style info.
 */
export function renderInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;

  while (i < text.length) {
    // Link: [text](url)
    if (text[i] === '[') {
      const closeB = text.indexOf(']', i);
      if (closeB !== -1 && text[closeB + 1] === '(') {
        const closeP = text.indexOf(')', closeB + 2);
        if (closeP !== -1) {
          const linkText = text.slice(i + 1, closeB);
          const url = text.slice(closeB + 2, closeP);
          tokens.push({ type: 'link', text: linkText, url });
          i = closeP + 1;
          continue;
        }
      }
    }

    // Inline code: `code`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        tokens.push({ type: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Bold+italic: ***text***
    if (text.slice(i, i + 3) === '***') {
      const end = text.indexOf('***', i + 3);
      if (end !== -1) {
        tokens.push({ type: 'text', text: text.slice(i + 3, end), style: { bold: true, italic: true } });
        i = end + 3;
        continue;
      }
      // No closing *** found — emit the leading * as plain text so the ** bold
      // check can handle the remaining ** on the next iteration.
      tokens.push({ type: 'text', text: '*', style: {} });
      i += 1;
      continue;
    }

    // Bold: **text**
    if (text.slice(i, i + 2) === '**') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'text', text: text.slice(i + 2, end), style: { bold: true } });
        i = end + 2;
        continue;
      }
    }

    // Italic: *text* or _text_
    // Guard: text[i - 1] !== '*' prevents the second * of ** from starting italic.
    // Guard: text[i + 1] !== text[i] prevents the first * of ** (or _ of __) from
    // starting italic when bold/underscore-bold detection failed (e.g. unclosed **).
    if (
      (text[i] === '*' || text[i] === '_') &&
      text[i - 1] !== text[i] &&
      text[i + 1] !== text[i]
    ) {
      const closer = text[i];
      const end = text.indexOf(closer, i + 1);
      if (end !== -1 && end > i + 1) {
        tokens.push({ type: 'text', text: text.slice(i + 1, end), style: { italic: true } });
        i = end + 1;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (text.slice(i, i + 2) === '~~') {
      const end = text.indexOf('~~', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'text', text: text.slice(i + 2, end), style: { strikethrough: true, fg: '244' } });
        i = end + 2;
        continue;
      }
    }

    // Plain text — accumulate until next special char, detect bare URLs and file paths
    let end = i + 1;
    while (end < text.length && !INLINE_SPECIAL_CHARS.has(text[end])) {
      const code = text.charCodeAt(end);
      end += (code >= 0xD800 && code <= 0xDBFF) ? 2 : 1;
    }
    const plainText = text.slice(i, end);

    // Detect http/https URLs in plain text
    const urlMatch = plainText.match(/^(https?:\/\/[^\s,)>"]+)/);
    if (urlMatch) {
      const url = urlMatch[1];
      tokens.push({ type: 'link', text: url, url });
      i += url.length;
      continue;
    }

    // Detect absolute file paths in plain text (require at least one directory separator)
    const fileMatch = plainText.match(/^(\/[^\s,)>"]+\/[^\s,)>"]+(?:\.[a-zA-Z0-9]+)?)/);
    if (fileMatch) {
      const filePath = fileMatch[1];
      const fileUrl = `file://${filePath}`;
      tokens.push({ type: 'link', text: filePath, url: fileUrl });
      i += filePath.length;
      continue;
    }

    tokens.push({ type: 'text', text: plainText, style: {} });
    i = end;
  }

  return tokens;
}

/**
 * compositeInlineLine - Convert a prefix + InlineTokens into Line[], applying word wrap.
 * Builds cells directly from token styles.
 */
function compositeInlineLine(
  prefix: string,
  tokens: InlineToken[],
  width: number,
  prefixStyle: Partial<Cell>,
  textStartX: number
): Line[] {
  const lines: Line[] = [];

  // Flatten tokens to [char, style] pairs
  type StyledChar = { char: string; style: Partial<Cell> };
  const chars: StyledChar[] = [];

  for (const token of tokens) {
    if (token.type === 'text') {
      for (const ch of token.text) chars.push({ char: ch, style: token.style });
    } else if (token.type === 'code') {
      for (const ch of token.text) chars.push({ char: ch, style: { fg: '#ffcc00', bg: '#1a1a1a' } });
    } else if (token.type === 'link') {
      // Resolve URL: if url is empty or relative, treat as text; if it's a file path, use file:// protocol
      let resolvedUrl = token.url;
      if (resolvedUrl && !resolvedUrl.startsWith('http') && !resolvedUrl.startsWith('file://') && resolvedUrl.startsWith('/')) {
        resolvedUrl = `file://${resolvedUrl}`;
      }
      for (const ch of token.text) chars.push({ char: ch, style: { fg: '#00aaff', underline: true, link: resolvedUrl || undefined } });
    }
  }

  // Render with simple line-breaking at width
  const availW = width - textStartX;
  if (availW <= 0) return lines;

  let lineChars: StyledChar[] = [];
  let lineW = 0;

  const flushLine = (isFirst: boolean) => {
    const line = new Array(width).fill(null).map(() => createStyledCell(' ')) as Cell[];
    // Write prefix on first line
    if (isFirst) {
      let px = 0;
      for (const ch of prefix) {
        if (px >= width) break;
        const cw = getDisplayWidth(ch);
        line[px] = createStyledCell(ch, { fg: prefixStyle.fg, bg: prefixStyle.bg, bold: prefixStyle.bold, dim: prefixStyle.dim, underline: prefixStyle.underline, italic: prefixStyle.italic, strikethrough: prefixStyle.strikethrough });
        if (cw === 2 && px + 1 < width) line[px + 1] = { ...line[px], char: '' };
        px += cw;
      }
    } else {
      // indent-only for continuation lines
      for (let x = 0; x < textStartX && x < width; x++) {
        line[x] = createStyledCell(' ');
      }
    }
    // Write content chars
    let cx = textStartX;
    for (const sc of lineChars) {
      if (cx >= width) break;
      const cw = getDisplayWidth(sc.char);
      line[cx] = createStyledCell(sc.char, sc.style);
      if (cw === 2 && cx + 1 < width) line[cx + 1] = { ...line[cx], char: '' };
      cx += cw;
    }
    lines.push(line);
    lineChars = [];
    lineW = 0;
  };

  // Word-aware line breaking: accumulate words, break at spaces
  let isFirstLine = true;
  let wordChars: StyledChar[] = [];
  let wordW = 0;

  const flushWord = () => {
    // If the word doesn't fit on the current line, wrap first
    if (lineW > 0 && lineW + wordW > availW) {
      flushLine(isFirstLine);
      isFirstLine = false;
    }
    // If a single word is wider than availW, force-break it character by character
    if (wordW > availW) {
      for (const sc of wordChars) {
        const cw = getDisplayWidth(sc.char);
        if (lineW + cw > availW && lineW > 0) {
          flushLine(isFirstLine);
          isFirstLine = false;
        }
        lineChars.push(sc);
        lineW += cw;
      }
    } else {
      lineChars.push(...wordChars);
      lineW += wordW;
    }
    wordChars = [];
    wordW = 0;
  };

  for (const sc of chars) {
    const cw = getDisplayWidth(sc.char);
    if (sc.char === ' ') {
      // Space: flush current word, then add the space
      flushWord();
      if (lineW + cw > availW && lineW > 0) {
        flushLine(isFirstLine);
        isFirstLine = false;
      }
      lineChars.push(sc);
      lineW += cw;
    } else {
      // Non-space: accumulate into current word
      wordChars.push(sc);
      wordW += cw;
    }
  }
  // Flush remaining word
  if (wordChars.length > 0) flushWord();
  if (lineChars.length > 0 || isFirstLine) {
    flushLine(isFirstLine);
  }

  return lines;
}
