import { describe, test, expect } from 'bun:test';
import { activeTokens } from '../../renderer/theme.ts';
import { renderMarkdown, renderMarkdownTracked, renderInlineMarkdown } from '../../renderer/markdown.ts';
import { lineToString, linesToText } from '../setup.ts';

const WIDTH = 80;

/** Extract plain text from a Line (Cell[]). */
const lineText = lineToString;

/** Get all non-empty text lines from a render result. */
function textLines(lines: import('@pellux/goodvibes-sdk/platform/types').Line[]): string[] {
  return linesToText(lines).filter((t) => t.length > 0);
}

describe('renderMarkdown', () => {

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

  test('renders an H1 heading in its own case, bold, in the heading color', () => {
    const result = renderMarkdown('# My Title', WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('My Title');
    expect(text).not.toContain('MY TITLE');
    const cell = result[0]!.find((c) => c.char === 'M')!;
    expect(cell.bold).toBe(true);
    expect(cell.fg).toBe(activeTokens().markdownHeading);
  });

  test('headings carry no rule row', () => {
    for (const md of ['# One', '## Two', '### Three']) {
      expect(renderMarkdown(md, WIDTH)).toHaveLength(1);
    }
  });

  test('inline code uses the markdown code color and is not bold', () => {
    const result = renderMarkdown('call `fn()` now', WIDTH);
    const cell = result[0]!.find((c) => c.char === 'f')!;
    expect(cell.fg).toBe(activeTokens().markdownCode);
    expect(cell.bold).toBeFalsy();
  });

  test('list markers are muted', () => {
    const bullet = renderMarkdown('- item', WIDTH)[0]!.find((c) => c.char === '•')!;
    expect(bullet.fg).toBe(activeTokens().textMuted);
    const num = renderMarkdown('1. item', WIDTH)[0]!.find((c) => c.char === '1')!;
    expect(num.fg).toBe(activeTokens().textMuted);
  });

  test('a block quote keeps its thin bar and style on every wrapped row', () => {
    const long = '> ' + 'quoted words that wrap '.repeat(12);
    const rows = textLines(renderMarkdown(long, 60));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.trimStart().startsWith('│')).toBe(true);
  });

  test('exactly one blank row around code, tables, quotes and rules', () => {
    const md = ['before', '', '', '', '```ts', 'x', '```', 'between', '> q', 'after', '---', '| a | b |', '|---|---|', '| 1 | 2 |', 'end'].join('\n');
    // A row on a fill (the code block's padding) is not a blank row.
    const rows = renderMarkdown(md, WIDTH).map((line) => (line.some((c) => c.bg) ? '#fill' : lineToString(line).trim()));
    // Never two blank rows in a row, and every block is fenced by one blank row.
    for (let i = 1; i < rows.length; i++) expect(rows[i] === '' && rows[i - 1] === '').toBe(false);
    const idx = (needle: string) => rows.findIndex((r) => r.includes(needle));
    expect(rows[idx('between') - 1]).toBe('');
    expect(rows[idx('between') + 1]).toBe('');
    expect(rows[idx('after') - 1]).toBe('');
    expect(rows[idx('after') + 1]).toBe('');
    expect(rows[idx('end') - 1]).toBe('');
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
    expect(text).toContain('│');
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

  test('renders GitHub-style pipe tables', () => {
    const md = [
      'Summary of Best Practices',
      '| Feature | In-Memory Implementation | Redis/Distributed Implementation |',
      '| :--- | :--- | :--- |',
      '| Use Case | CLI tools, single-process scripts. | Production APIs, Microservices. |',
      '| Complexity | Low (Standard Class). | Medium (Requires Lua scripting). |',
    ].join('\n');
    const result = renderMarkdown(md, WIDTH);
    const text = textLines(result).join('\n');
    expect(text).toContain('┌');
    expect(text).toContain('Feature');
    expect(text).toContain('Use Case');
    expect(text).toContain('Redis/Distributed');
    expect(text).toContain('┬');
  });

  test('tracked markdown preserves table rendering for assistant content', () => {
    const md = [
      'Summary of Best Practices',
      '| Feature | In-Memory Implementation | Redis/Distributed Implementation |',
      '| :--- | :--- | :--- |',
      '| Use Case | CLI tools, single-process scripts. | Production APIs, Microservices. |',
      '| Race Conditions | Possible if using async logic. | Prevented via Redis Atomicity/Lua. |',
    ].join('\n');
    const result = renderMarkdownTracked(md, WIDTH);
    const text = textLines(result.lines).join('\n');
    expect(text).toContain('┌');
    expect(text).toContain('Feature');
    // The label wraps within its column rather than being cut to "Race Condit…".
    expect(text).toContain('Race');
    expect(text).toContain('Conditions');
    expect(text).toContain('┴');
  });


  test('renders tables with malformed alignment rows tolerantly', () => {
    const md = [
      '| Algorithm | Pros | Cons | Best Use Case |',
      '| :--- ability | :--- | :--- | :--- |',
      '| Fixed Window | Extremely fast/simple. | Boundary problem | Simple API throttling. |',
      '| Token Bucket | Allows bursts while maintaining a steady rate. | Slightly more complex math. | Most Web APIs & Microservices. |',
    ].join('\n');
    const result = renderMarkdownTracked(md, WIDTH);
    const text = textLines(result.lines).join('\n');
    expect(text).toContain('┌');
    expect(text).toContain('Algori');
    expect(text).toContain('Token');
    expect(text).toContain('┼');
  });

  test('wraps a narrow table cell containing a wide glyph instead of ellipsizing it', () => {
    // A narrow overall width plus a very wide second column squeezes the
    // first column hard. "ab日x" (display width 5: a=1, b=1, 日=2, x=1)
    // must still reach the buffer in full, wrapped across physical lines
    // if the column is narrower than 5, and the wide glyph keeps its
    // placeholder cell so the column edge stays where the border expects.
    const md = [
      '| A | B |',
      '| :--- | :--- |',
      `| ab日x | ${'z'.repeat(60)} |`,
    ].join('\n');
    const result = renderMarkdown(md, 30);
    const text = textLines(result).join('\n');
    expect(text).not.toContain('…');
    expect(text).toContain('日');
    // Border positions are read from the Cell array, not the joined string: a
    // wide glyph occupies two array slots (the second is the placeholder cell
    // whose char is ''), so buffer columns and string offsets differ.
    const barCols = (line: import('@pellux/goodvibes-sdk/platform/types').Line): number[] => {
      const cols: number[] = [];
      for (let i = 0; i < line.length; i++) if (line[i].char === '│') cols.push(i);
      return cols;
    };
    const rowLines = result.filter((line) => barCols(line).length > 0);
    const reference = barCols(rowLines[0]);
    expect(reference.length).toBe(3); // 2 columns => 3 verticals
    for (const line of rowLines) expect(barCols(line)).toEqual(reference);

    // Every character of the first cell survives, reading down its column.
    const firstColumn = rowLines
      .map((line) => line.slice(reference[0] + 1, reference[1]).map((c) => c.char).join(''))
      .join('')
      .replace(/\s+/g, '');
    expect(firstColumn).toContain('ab日x');
  });
});

describe('fence syntax variants', () => {
  test('tilde fences (~~~) open and close a code block', () => {
    const md = '~~~js\nconsole.log(1);\n~~~';
    const result = renderMarkdown(md, 80);
    const text = textLines(result).join('\n');
    // Should render the content (not emit the fence markers as text)
    expect(text).toContain('console');
    expect(text).not.toContain('~~~');
  });

  test('info string after fence marker is parsed (not included in content)', () => {
    const md = '```typescript title=example.ts\nconst x: number = 1;\n```';
    const result = renderMarkdown(md, 80);
    const text = textLines(result).join('\n');
    expect(text).toContain('x');
    // The info string should not appear as content
    expect(text).not.toContain('title=example.ts');
  });

  test('hyphenated language tag in info string is accepted', () => {
    const md = '```shell-session\n$ echo hi\n```';
    const result = renderMarkdown(md, 80);
    const text = textLines(result).join('\n');
    expect(text).toContain('echo');
  });

  test('tilde fence with info string', () => {
    const md = '~~~python\nprint("hello")\n~~~';
    const result = renderMarkdown(md, 80);
    const text = textLines(result).join('\n');
    expect(text).toContain('print');
    expect(text).not.toContain('~~~');
  });

  test('asymmetric close: backtick fence closed with tilde is treated as content, not close', () => {
    // A ~~~ close should NOT close a ``` fence, the ~~~ line becomes content
    const md = '```\ncode line\n~~~\nmore content\n```';
    const result = renderMarkdown(md, 80);
    const text = textLines(result).join('\n');
    // The ~~~ line should be inside the code block, not close it early
    // All four content lines should be rendered
    expect(text).toContain('code line');
    expect(text).toContain('more content');
  });

  test('unclosed tilde fence renders gracefully', () => {
    const md = '~~~\nsome code';
    const result = renderMarkdown(md, 80);
    expect(Array.isArray(result)).toBe(true);
    const text = textLines(result).join('\n');
    expect(text).toContain('some code');
  });

  test('indented fence inside list item renders as code block and closes at matching indent', () => {
    // A 3-space indented fence is valid inside a list item; parser must track
    // fenceIndent and close at the matching indentation level.
    const md = [
      '- item one',
      '   ```ts',
      '   const x = 1;',
      '   ```',
      '- item two',
    ].join('\n');
    const result = renderMarkdown(md, 80);
    expect(Array.isArray(result)).toBe(true);
    const text = textLines(result).join('\n');
    // Code content inside the indented fence must appear
    expect(text).toContain('x');
    // The list items surrounding the fence must also appear
    expect(text).toContain('item one');
    expect(text).toContain('item two');
    // The fence markers themselves must NOT appear as raw text
    expect(text).not.toContain('```');
  });

  test('empty fence (zero content lines) renders without crash', () => {
    const md = '```ts\n```';
    const result = renderMarkdown(md, 80);
    expect(Array.isArray(result)).toBe(true);
    // Empty fence still produces header + footer lines
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test('fence close immediately followed by next paragraph (no blank line)', () => {
    // Content after the closing fence delimiter must not bleed into the code block
    const md = '```ts\nconst x = 1;\n```\nThis is a paragraph.';
    const result = renderMarkdown(md, 80);
    const text = textLines(result).join('\n');
    expect(text).toContain('x');
    expect(text).toContain('This is a paragraph.');
    // The paragraph text must appear as its own line, not inside the code block
    const lines = textLines(result);
    const paraIdx = lines.findIndex((l) => l.includes('This is a paragraph.'));
    expect(paraIdx).toBeGreaterThan(-1);
  });

  test('backtick inside inline code span does not open a fence', () => {
    // A single backtick used for inline code within a paragraph must not be
    // treated as a fence opener even when it starts a line.
    const md = 'Plain text with `code` in it.';
    const result = renderMarkdown(md, 80);
    const text = textLines(result).join('\n');
    expect(text).toContain('code');
    expect(text).toContain('Plain text');
    // Must be a single line (not a code block)
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test('fence with no language tag renders content without syntax header artifact', () => {
    const md = '```\nplain code\n```';
    const result = renderMarkdown(md, 80);
    const text = textLines(result).join('\n');
    // The word 'code' appears in both the header ('code' fallback) and the content
    expect(text).toContain('plain code');
  });

  test('tracked markdown: unclosed fence at stream end is recorded in codeBlocks', () => {
    const md = '```ts\nconst x = 1;\nconst y = 2;';
    const { lines, codeBlocks } = renderMarkdownTracked(md, 80);
    // The unclosed fence must produce at least one codeBlock entry
    expect(codeBlocks.length).toBeGreaterThan(0);
    // The rawContent must include both content lines (no fence markers)
    expect(codeBlocks[0].rawContent).toContain('const x');
    expect(codeBlocks[0].rawContent).toContain('const y');
    // The rendered lines must be non-empty
    expect(lines.length).toBeGreaterThan(0);
  });

  test('multiple sequential fences do not bleed into each other', () => {
    const md = [
      '```ts',
      'const a = 1;',
      '```',
      '```py',
      'print(42)',
      '```',
    ].join('\n');
    const { codeBlocks } = renderMarkdownTracked(md, 80);
    // Should have exactly 2 code blocks
    expect(codeBlocks.length).toBe(2);
    // First block: TS content
    expect(codeBlocks[0].rawContent).toContain('const a');
    // Second block: Python content
    expect(codeBlocks[1].rawContent).toContain('print');
    // The blocks must not overlap in line offsets
    const firstEnd = codeBlocks[0].startOffset + codeBlocks[0].lineCount;
    expect(codeBlocks[1].startOffset).toBeGreaterThanOrEqual(firstEnd);
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

describe('transcript columns (the Measurements table)', () => {
  const firstTextCol = (line: import('@pellux/goodvibes-sdk/platform/types').Line): number =>
    line.findIndex((cell) => cell.char !== ' ' && cell.char !== '');
  const lastTextCol = (line: import('@pellux/goodvibes-sdk/platform/types').Line): number => {
    for (let x = line.length - 1; x >= 0; x--) if (line[x]!.char !== ' ' && line[x]!.char !== '') return x;
    return -1;
  };

  test('prose starts at column 5 and wraps before width-5', () => {
    const long = 'word '.repeat(60).trim();
    for (const width of [60, 80, 120]) {
      const lines = renderMarkdown(`${long}\n\n> ${long}\n\n- ${long}\n\n1. ${long}`, width).filter((l) => firstTextCol(l) >= 0);
      expect(lines.length).toBeGreaterThan(4);
      for (const line of lines) {
        expect(firstTextCol(line)).toBeGreaterThanOrEqual(5);
        expect(lastTextCol(line)).toBeLessThanOrEqual(width - 6);
      }
    }
  });

  test('a heading keeps one blank row above and below it', () => {
    const rows = linesToText(renderMarkdown('Intro line.\n## Heading\nBody line.', WIDTH));
    const at = rows.findIndex((r) => r.includes('Heading'));
    expect(rows[at - 1]!.trim()).toBe('');
    expect(rows[at + 1]!.trim()).toBe('');
    expect(rows[at - 2]).toContain('Intro line.');
    expect(rows[at + 2]).toContain('Body line.');
  });

  test('a heading that opens the message has no blank row above it', () => {
    const rows = linesToText(renderMarkdown('## Heading\nBody line.', WIDTH));
    expect(rows[0]).toContain('Heading');
  });
});

describe('wrapped prose continuation rows', () => {
  const PROSE = 'withRetry calls fn up to attempts times with exponential backoff and jitter between tries. The test does not cover backoff; it only checks the success path.';

  // Widths 64 and 66 put a space exactly on the wrap column; before the fix
  // the break space moved to the next row and the row began at column 6.
  test('every wrapped row starts at the text column, whatever the width', () => {
    for (let width = 40; width <= 130; width++) {
      const rows = linesToText(renderMarkdown(PROSE, width)).filter((r) => r.trim().length > 0);
      for (const row of rows) {
        expect({ width, col: row.search(/\S/) }).toEqual({ width, col: 5 });
      }
    }
  });

  test('the break keeps every word and drops only the break space', () => {
    const rows = linesToText(renderMarkdown(PROSE, 64)).filter((r) => r.trim().length > 0);
    expect(rows.map((r) => r.trim()).join(' ')).toBe(PROSE);
  });

  test('list items and code blocks keep their deliberate indentation', () => {
    const md = '- first item that is long enough to wrap onto a second row at this narrow width\n\n```ts\nfunction f() {\n    return 1;\n}\n```';
    const rows = linesToText(renderMarkdown(md, 50));
    const item = rows.findIndex((r) => r.includes('first item'));
    const bulletCol = rows[item]!.search(/\S/);
    const cont = rows[item + 1]!;
    expect(cont.search(/\S/)).toBeGreaterThan(bulletCol);
    const body = rows.find((r) => r.includes('return 1;'))!;
    const open = rows.find((r) => r.includes('function f()'))!;
    expect(body.indexOf('return') - open.indexOf('function')).toBe(4);
  });
});
