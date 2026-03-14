import { describe, test, expect } from 'bun:test';
import { renderMarkdown, renderInlineMarkdown } from '../../renderer/markdown.ts';
import { lineToString, linesToText } from '../setup.ts';

const WIDTH = 80;

/** Extract plain text from a Line (Cell[]). */
const lineText = lineToString;

/** Get all non-empty text lines from a render result. */
function textLines(lines: import('../../types/grid.ts').Line[]): string[] {
  return linesToText(lines).filter((t) => t.length > 0);
}

describe('renderMarkdown', () => {
  test('returns Line array', () => {
    const result = renderMarkdown('hello', WIDTH);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('each line has correct width', () => {
    const result = renderMarkdown('hello world', WIDTH);
    for (const line of result) {
      expect(line.length).toBe(WIDTH);
    }
  });

  test('renders plain paragraph text', () => {
    const result = renderMarkdown('hello world', WIDTH);
    const text = textLines(result).join(' ');
    expect(text).toContain('hello world');
  });

  test('renders H1 heading in uppercase', () => {
    const result = renderMarkdown('# My Title', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('MY TITLE');
  });

  test('renders H2 heading with underline', () => {
    const result = renderMarkdown('## Section Header', WIDTH);
    const texts = textLines(result);
    expect(texts.some((t) => t.includes('Section Header'))).toBe(true);
    // H2 produces 2 lines (text + rule)
    expect(texts.length).toBeGreaterThanOrEqual(2);
  });

  test('renders H3 heading', () => {
    const result = renderMarkdown('### Subsection', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('Subsection');
  });

  test('renders unordered list with bullet', () => {
    const result = renderMarkdown('- item one\n- item two', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('•');
    expect(text).toContain('item one');
    expect(text).toContain('item two');
  });

  test('renders ordered list', () => {
    const result = renderMarkdown('1. first\n2. second', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect(text).toContain('1.');
  });

  test('renders horizontal rule', () => {
    const result = renderMarkdown('---', WIDTH);
    const text = textLines(result).join('');
    expect(text).toContain('─');
  });

  test('renders blockquote', () => {
    const result = renderMarkdown('> quoted text', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('┃');
    expect(text).toContain('quoted text');
  });

  test('renders fenced code block', () => {
    const md = '```ts\nconst x = 1;\n```';
    const result = renderMarkdown(md, WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('x');
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles unclosed code block gracefully', () => {
    const md = '```ts\nconst x = 1;';
    const result = renderMarkdown(md, WIDTH);
    expect(Array.isArray(result)).toBe(true);
    const text = textLines(result).join('\n');
    expect(text).toContain('x');
  });

  test('handles empty string input', () => {
    const result = renderMarkdown('', WIDTH);
    expect(Array.isArray(result)).toBe(true);
  });

  test('H1 heading cells are bold', () => {
    const result = renderMarkdown('# Bold Title', WIDTH);
    // First non-space, non-empty line should have bold cells
    const firstContentLine = result.find((l) =>
      l.some((c) => c.char !== ' ' && c.char !== '')
    );
    expect(firstContentLine).toBeDefined();
    const contentCells = firstContentLine!.filter((c) => c.char !== ' ' && c.char !== '');
    expect(contentCells.some((c) => c.bold)).toBe(true);
  });
});

describe('renderInlineMarkdown', () => {
  test('returns text token for plain text', () => {
    const tokens = renderInlineMarkdown('hello');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.some((t) => t.type === 'text' && t.text.includes('hello'))).toBe(true);
  });

  test('identifies bold tokens (type=text with bold style)', () => {
    const tokens = renderInlineMarkdown('**bold**');
    // Bold is represented as { type: 'text', style: { bold: true } }
    expect(tokens.some((t) => t.type === 'text' && (t as { style?: { bold?: boolean } }).style?.bold === true)).toBe(true);
  });

  test('identifies italic tokens (type=text with italic style)', () => {
    const tokens = renderInlineMarkdown('_italic_');
    // Italic is represented as { type: 'text', style: { italic: true } }
    expect(tokens.some((t) => t.type === 'text' && (t as { style?: { italic?: boolean } }).style?.italic === true)).toBe(true);
  });

  test('identifies inline code tokens', () => {
    const tokens = renderInlineMarkdown('`code`');
    expect(tokens.some((t) => t.type === 'code')).toBe(true);
  });

  test('handles mixed inline markdown', () => {
    const tokens = renderInlineMarkdown('text **bold** and `code`');
    expect(tokens.some((t) => t.type === 'text')).toBe(true);
    // Bold produces a text token with bold style
    expect(tokens.some((t) => t.type === 'text' && (t as { style?: { bold?: boolean } }).style?.bold === true)).toBe(true);
    expect(tokens.some((t) => t.type === 'code')).toBe(true);
  });
});
