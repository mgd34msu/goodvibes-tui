import { type Line, type Cell, createStyledCell } from '@pellux/goodvibes-sdk/platform/types';
import { UIFactory } from './ui-factory.ts';
import { renderCodeBlock } from './code-block.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { LAYOUT } from './layout.ts';
import { activeTheme } from './theme.ts';
import { renderInlineMarkdown, type InlineToken } from './markdown-inline.ts';
import { isLikelyTableHeaderRow, isLikelyTableSeparatorRow, renderTable } from './markdown-table.ts';

// Re-exported so existing importers of renderInlineMarkdown keep working after
// the tokenizer moved to markdown-inline.ts (see that module's header).
export { renderInlineMarkdown, type InlineToken };

// Transcript tokens are read live per render (const T = activeTheme() at the top
// of each render function below) so a dark→light repaint re-resolves with no
// module reload. See theme.ts's active-mode runtime note.

export interface MarkdownRenderOptions {
  codeBlockLineNumbers?: boolean;
  /** When true, suppresses tree-sitter parse scheduling for streaming code blocks. */
  isStreaming?: boolean;
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
  const T = activeTheme();
  const lines: ReturnType<typeof renderMarkdown> = [];
  const codeBlocks: CodeBlockSpan[] = [];
  const rawLines = text.split('\n');

  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];
  let fenceChar = '`';
  let fenceIndent = 0;
  const indent = LAYOUT.LEFT_MARGIN;
  const contentWidth = LAYOUT.contentWidth(width);

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];

    const fenceMatch = raw.match(/^(\s*)(```|~~~)\s*([\w-]*)/);
    if (fenceMatch && !inCodeBlock) {
      inCodeBlock = true;
      fenceIndent = fenceMatch[1].length;
      fenceChar = fenceMatch[2][0]; // '`' or '~'
      codeBlockLang = fenceMatch[3] || '';
      codeBlockLines = [];
      continue;
    }
    if (inCodeBlock) {
      // Close fence: same char, same or less indentation, at least 3 of that char
      const closeFenceRe = new RegExp(`^\\s{0,${fenceIndent}}${fenceChar === '`' ? '```' : '~~~'}`);
      if (closeFenceRe.test(raw)) {
        const blockStart = lines.length;
        const rendered = renderCodeBlock(codeBlockLines, codeBlockLang, width, {
          showLineNumbers: options.codeBlockLineNumbers ?? true,
          isStreaming: options.isStreaming ?? false,
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
        fenceChar = '`';
        fenceIndent = 0;
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
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + h1[1].toUpperCase(), width, { fg: T.heading1, bold: true }));
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + '━'.repeat(Math.min(getDisplayWidth(h1[1]), contentWidth)), width, { fg: '244' }));
      continue;
    }
    if (h2) {
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + h2[1], width, { fg: T.heading2, bold: true }));
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + '─'.repeat(Math.min(getDisplayWidth(h2[1]), contentWidth)), width, { fg: '240' }));
      continue;
    }
    if (h3) {
      lines.push(UIFactory.stringToLine(' '.repeat(indent) + h3[1], width, { fg: T.heading3, bold: true }));
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
      lines.push(...compositeInlineLine(prefix, rendered, width, { fg: checked ? T.checkboxChecked : '252', ...style }, textStartX));
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
      isStreaming: options.isStreaming ?? false,
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
  const T = activeTheme();
  const lines: Line[] = [];

  // Flatten tokens to [char, style] pairs
  type StyledChar = { char: string; style: Partial<Cell> };
  const chars: StyledChar[] = [];

  for (const token of tokens) {
    if (token.type === 'text') {
      for (const ch of token.text) chars.push({ char: ch, style: token.style });
    } else if (token.type === 'code') {
      for (const ch of token.text) chars.push({ char: ch, style: { fg: T.inlineCodeFg, bold: true } });
    } else if (token.type === 'link') {
      // Resolve URL: if url is empty or relative, treat as text; if it's a file path, use file:// protocol
      let resolvedUrl = token.url;
      if (resolvedUrl && !resolvedUrl.startsWith('http') && !resolvedUrl.startsWith('file://') && resolvedUrl.startsWith('/')) {
        resolvedUrl = `file://${resolvedUrl}`;
      }
      for (const ch of token.text) chars.push({ char: ch, style: { fg: T.link, underline: true, link: resolvedUrl || undefined } });
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
