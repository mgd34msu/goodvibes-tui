import { type Line, type Cell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { renderCodeBlock } from './code-block.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

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
      const availableW = width - textStartX;
      const rendered = renderInlineMarkdown(ulMatch[2], availableW);
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
      const availableW = width - textStartX;
      const rendered = renderInlineMarkdown(olMatch[3], availableW);
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
      const bqAvailW = contentWidth - 3;
      const rendered = renderInlineMarkdown(bqMatch[1], bqAvailW);
      const prefix = ' '.repeat(indent) + '┃ ';
      lines.push(...compositeInlineLine(prefix, rendered, width, { fg: '244', italic: true }, indent + 3));
      continue;
    }

    // --- Normal paragraph ---
    const rendered = renderInlineMarkdown(raw, contentWidth);
    lines.push(...compositeInlineLine(' '.repeat(indent), rendered, width, {}, indent));
  }

  // Handle unclosed code block
  if (inCodeBlock && codeBlockLines.length > 0) {
    const rendered = renderCodeBlock(codeBlockLines, codeBlockLang, width);
    lines.push(...rendered);
  }

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
export function renderInlineMarkdown(text: string, _availWidth: number): InlineToken[] {
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
    const specialChars = new Set(['[', '`', '*', '_', '~']);
    let end = i + 1;
    while (end < text.length && !specialChars.has(text[end])) end++;
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
    const line = new Array(width).fill(null).map(() => ({
      char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false
    })) as Cell[];
    // Write prefix on first line
    if (isFirst) {
      let px = 0;
      for (const ch of prefix) {
        if (px >= width) break;
        const cw = getDisplayWidth(ch);
        line[px] = { char: ch, fg: prefixStyle.fg || '', bg: prefixStyle.bg || '', bold: prefixStyle.bold || false, dim: prefixStyle.dim || false, underline: prefixStyle.underline || false, italic: prefixStyle.italic || false, strikethrough: prefixStyle.strikethrough || false };
        if (cw === 2 && px + 1 < width) line[px + 1] = { ...line[px], char: '' };
        px += cw;
      }
    } else {
      // indent-only for continuation lines
      for (let x = 0; x < textStartX && x < width; x++) {
        line[x] = { char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
      }
    }
    // Write content chars
    let cx = textStartX;
    for (const sc of lineChars) {
      if (cx >= width) break;
      const cw = getDisplayWidth(sc.char);
      line[cx] = {
        char: sc.char,
        fg: sc.style.fg || '',
        bg: sc.style.bg || '',
        bold: sc.style.bold || false,
        dim: sc.style.dim || false,
        underline: sc.style.underline || false,
        italic: sc.style.italic || false,
        strikethrough: sc.style.strikethrough || false
      };
      if (cw === 2 && cx + 1 < width) line[cx + 1] = { ...line[cx], char: '' };
      cx += cw;
    }
    lines.push(line);
    lineChars = [];
    lineW = 0;
  };

  let isFirstLine = true;
  for (const sc of chars) {
    const cw = getDisplayWidth(sc.char);
    if (lineW + cw > availW && lineW > 0) {
      flushLine(isFirstLine);
      isFirstLine = false;
    }
    lineChars.push(sc);
    lineW += cw;
  }
  if (lineChars.length > 0 || isFirstLine) {
    flushLine(isFirstLine);
  }

  return lines;
}
