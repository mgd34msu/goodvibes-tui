import { type Line, type Cell, createStyledCell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { renderCodeBlock } from './code-block.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

/** Module-level set of inline markdown special characters (hoisted out of hot loop). */
const INLINE_SPECIAL_CHARS = new Set(['[', '`', '*', '_', '~']);

/**
 * renderMarkdown - Parse markdown text into styled Line[] using a line-by-line state machine.
 * Supports headers, bold, italic, inline code, code blocks, lists, and links.
 */
export function renderMarkdown(text: string, width: number): Line[] {
  const lines: Line[] = [];
  const rawLines = text.split('\n');

  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];
  const indent = 2;
  const contentWidth = width - indent;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];

    // --- Code block fence ---
    const fenceMatch = raw.match(/^```(\w*)/);
    if (fenceMatch && !inCodeBlock) {
      inCodeBlock = true;
      codeBlockLang = fenceMatch[1] || '';
      codeBlockLines = [];
      continue;
    }
    if (inCodeBlock) {
      if (raw.trimStart().startsWith('```')) {
        // End of code block - delegate to code block renderer
        const rendered = renderCodeBlock(codeBlockLines, codeBlockLang, width);
        lines.push(...rendered);
        inCodeBlock = false;
        codeBlockLang = '';
        codeBlockLines = [];
      } else {
        codeBlockLines.push(raw);
      }
      continue;
    }

    // --- Empty line ---
    if (raw.trim() === '') {
      lines.push(UIFactory.stringToLine('', width));
      continue;
    }

    // --- Heading ---
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

    // --- Unordered list ---
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

    // --- Ordered list ---
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

    // --- Horizontal rule ---
    if (/^[-*_]{3,}$/.test(raw.trim())) {
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + '─'.repeat(contentWidth), width, { fg: '240' }));
      continue;
    }

    // --- Blockquote ---
    const bqMatch = raw.match(/^> (.*)/);
    if (bqMatch) {
      const rendered = renderInlineMarkdown(bqMatch[1]);
      const prefix = ' '.repeat(indent) + '┃ ';
      lines.push(...compositeInlineLine(prefix, rendered, width, { fg: '244', italic: true }, indent + 3));
      continue;
    }

    // --- Table ---
    if (raw.includes('|') && i + 1 < rawLines.length && /^[\s|:-]+$/.test(rawLines[i + 1])) {
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

    // --- Normal paragraph ---
    const rendered = renderInlineMarkdown(raw);
    lines.push(...compositeInlineLine(' '.repeat(indent), rendered, width, {}, indent));
  }

  // Handle unclosed code block
  if (inCodeBlock && codeBlockLines.length > 0) {
    const rendered = renderCodeBlock(codeBlockLines, codeBlockLang, width);
    lines.push(...rendered);
  }

  return lines;
}

/** Render a markdown table with box-drawing borders. */
function renderTable(rows: string[], width: number, indent: number): Line[] {
  const lines: Line[] = [];
  const parsedRows: string[][] = [];
  let separatorIdx = -1;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r].trim();
    if (/^[\s|:-]+$/.test(row) && row.includes('-')) {
      separatorIdx = r;
      continue;
    }
    const cells = row.split('|').map(c => c.trim()).filter((_, i, arr) => {
      if (i === 0 && arr[i] === '') return false;
      if (i === arr.length - 1 && arr[i] === '') return false;
      return true;
    });
    parsedRows.push(cells);
  }

  if (parsedRows.length === 0) return lines;

  const colCount = Math.max(...parsedRows.map(r => r.length));
  const colWidths: number[] = new Array(colCount).fill(0);
  for (const row of parsedRows) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c], getDisplayWidth(row[c]));
    }
  }

  const borderChars = colCount + 1;
  const padding = colCount * 2;
  const totalTableW = colWidths.reduce((a, b) => a + b, 0) + borderChars + padding;
  const availW = width - indent;

  if (totalTableW > availW) {
    const contentW = availW - borderChars - padding;
    const totalContent = colWidths.reduce((a, b) => a + b, 0);
    if (totalContent > 0) {
      for (let c = 0; c < colCount; c++) {
        colWidths[c] = Math.max(3, Math.floor((colWidths[c] / totalContent) * contentW));
      }
    }
  }

  const pad = ' '.repeat(indent);
  const bc = '240';

  let top = pad + '\u250c';
  for (let c = 0; c < colCount; c++) {
    top += '\u2500'.repeat(colWidths[c] + 2) + (c < colCount - 1 ? '\u252c' : '\u2510');
  }
  lines.push(UIFactory.stringToLine(top, width, { fg: bc }));

  for (let r = 0; r < parsedRows.length; r++) {
    const row = parsedRows[r];
    const isHeader = separatorIdx > 0 ? r === 0 : false;

    let rowStr = pad + '\u2502';
    for (let c = 0; c < colCount; c++) {
      const cell = c < row.length ? row[c] : '';
      const cellW = getDisplayWidth(cell);
      const padR = Math.max(0, colWidths[c] - cellW);
      rowStr += ' ' + cell + ' '.repeat(padR) + ' \u2502';
    }
    lines.push(UIFactory.stringToLine(rowStr, width, { fg: isHeader ? '#00ffff' : '252', bold: isHeader }));

    if (isHeader) {
      let mid = pad + '\u251c';
      for (let c = 0; c < colCount; c++) {
        mid += '\u2500'.repeat(colWidths[c] + 2) + (c < colCount - 1 ? '\u253c' : '\u2524');
      }
      lines.push(UIFactory.stringToLine(mid, width, { fg: bc }));
    }
  }

  let bottom = pad + '\u2514';
  for (let c = 0; c < colCount; c++) {
    bottom += '\u2500'.repeat(colWidths[c] + 2) + (c < colCount - 1 ? '\u2534' : '\u2518');
  }
  lines.push(UIFactory.stringToLine(bottom, width, { fg: bc }));

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
    if ((text[i] === '*' || text[i] === '_') && text[i - 1] !== '*') {
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

    // Plain text — accumulate until next special char
    let end = i + 1;
    while (end < text.length && !INLINE_SPECIAL_CHARS.has(text[end])) end++;
    tokens.push({ type: 'text', text: text.slice(i, end), style: {} });
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
      for (const ch of token.text) chars.push({ char: ch, style: { fg: '#00aaff', underline: true } });
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
