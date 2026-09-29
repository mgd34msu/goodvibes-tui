import { type Line, type Cell, createStyledCell, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { LAYOUT } from './layout.ts';
import { SyntaxHighlighter, type SyntaxToken as HLToken } from './syntax-highlighter.ts';
import { activeTokens } from './theme.ts';
import { syntaxStyles } from './syntax-theme.ts';

/**
 * Regex-fallback tokenizer colours. The syntax hues come from the same role
 * map as the tree-sitter path (syntax-theme.ts), so a code block that starts
 * on the regex fallback and is replaced by the async tree-sitter parse does
 * not shift colour mid-stream. Text with no role uses the theme's text colour
 * (never the terminal default, which can vanish on the themed body fill).
 */
function fallbackTheme() {
  const styles = syntaxStyles();
  const tokens = activeTokens();
  return {
    string: styles.string.fg,
    number: styles.number.fg,
    keyword: styles.keyword.fg,
    type: styles.type.fg,
    function: styles.function.fg,
    operator: styles.operator.fg,
    property: styles.property.fg,
    comment: styles.comment.fg,
    plain: styles.plain.fg,
    punctuation: tokens.textMuted,
  };
}

// ─── Language Keyword Maps ───────────────────────────────────────────────────

const TS_JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'import',
  'export', 'default', 'from', 'new', 'this', 'super', 'typeof', 'instanceof',
  'in', 'of', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'null', 'undefined', 'true', 'false', 'void', 'delete', 'interface', 'type',
  'enum', 'namespace', 'module', 'declare', 'abstract', 'implements', 'static',
  'readonly', 'public', 'private', 'protected', 'as', 'satisfies',
]);
const TS_TYPES = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol',
  'bigint', 'void', 'Record', 'Array', 'Map', 'Set', 'Promise', 'Partial',
  'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable',
]);

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import',
  'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'break',
  'continue', 'and', 'or', 'not', 'in', 'is', 'lambda', 'yield', 'global',
  'nonlocal', 'del', 'assert', 'True', 'False', 'None', 'async', 'await',
]);

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'case',
  'esac', 'function', 'return', 'exit', 'echo', 'export', 'local', 'readonly',
  'source', 'set', 'unset', 'shift', 'trap', 'exec', 'eval', 'read',
]);

// ─── Language Detection ──────────────────────────────────────────────────────

function detectLanguage(lang: string): 'ts' | 'python' | 'bash' | 'json' | 'yaml' | 'html' | 'css' | 'unknown' {
  const l = lang.toLowerCase();
  if (l === 'ts' || l === 'tsx' || l === 'js' || l === 'jsx' || l === 'typescript' || l === 'javascript') return 'ts';
  if (l === 'py' || l === 'python') return 'python';
  if (l === 'sh' || l === 'bash' || l === 'shell' || l === 'zsh') return 'bash';
  if (l === 'json') return 'json';
  if (l === 'yaml' || l === 'yml') return 'yaml';
  if (l === 'html' || l === 'htm' || l === 'xml') return 'html';
  if (l === 'css' || l === 'scss' || l === 'less') return 'css';
  return 'unknown';
}

// ─── Token Types ─────────────────────────────────────────────────────────────

type SyntaxToken = { text: string; fg: string; bold?: boolean; italic?: boolean };

// ─── Tokenizers ──────────────────────────────────────────────────────────────

function tokenizeTsJs(line: string): SyntaxToken[] {
  const th = fallbackTheme();
  const tokens: SyntaxToken[] = [];
  let i = 0;

  while (i < line.length) {
    // Line comment
    if (line.slice(i, i + 2) === '//') {
      tokens.push({ text: line.slice(i), fg: th.comment, italic: true });
      break;
    }
    // String (single, double, template)
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const q = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== q) {
        if (line[j] === '\\') j++;
        j++;
      }
      tokens.push({ text: line.slice(i, j + 1), fg: th.string });
      i = j + 1;
      continue;
    }
    // Number
    if (/[0-9]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[0-9._xXbBoO]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), fg: th.number });
      i = j;
      continue;
    }
    // Identifier or keyword
    if (/[a-zA-Z_$]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[\w$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (TS_JS_KEYWORDS.has(word)) {
        tokens.push({ text: word, fg: th.keyword });
      } else if (TS_TYPES.has(word)) {
        tokens.push({ text: word, fg: th.type });
      } else if (line[j] === '(') {
        tokens.push({ text: word, fg: th.function });
      } else {
        tokens.push({ text: word, fg: th.plain });
      }
      i = j;
      continue;
    }
    // Operators and punctuation
    const ch = line[i];
    const isOp = '=<>!&|+-*/%^~?:'.includes(ch);
    tokens.push({ text: ch, fg: isOp ? th.operator : '' });
    i++;
  }

  return tokens;
}

function tokenizePython(line: string): SyntaxToken[] {
  const th = fallbackTheme();
  const tokens: SyntaxToken[] = [];
  let i = 0;

  while (i < line.length) {
    if (line[i] === '#') {
      tokens.push({ text: line.slice(i), fg: th.comment, italic: true });
      break;
    }
    if (line[i] === '"' || line[i] === "'") {
      const q = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
      tokens.push({ text: line.slice(i, j + 1), fg: th.string });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[0-9._]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), fg: th.number });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[\w]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (PYTHON_KEYWORDS.has(word)) {
        tokens.push({ text: word, fg: th.keyword });
      } else if (/^[A-Z]/.test(word)) {
        tokens.push({ text: word, fg: th.type });
      } else if (line[j] === '(') {
        tokens.push({ text: word, fg: th.function });
      } else {
        tokens.push({ text: word, fg: th.plain });
      }
      i = j;
      continue;
    }
    tokens.push({ text: line[i], fg: th.plain });
    i++;
  }
  return tokens;
}

function tokenizeBash(line: string): SyntaxToken[] {
  const th = fallbackTheme();
  const tokens: SyntaxToken[] = [];
  let i = 0;

  while (i < line.length) {
    if (line[i] === '#') {
      tokens.push({ text: line.slice(i), fg: th.comment, italic: true });
      break;
    }
    if (line[i] === '"' || line[i] === "'") {
      const q = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
      tokens.push({ text: line.slice(i, j + 1), fg: th.string });
      i = j + 1;
      continue;
    }
    if (line[i] === '$') {
      let j = i + 1;
      while (j < line.length && /[\w{}_]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), fg: th.property });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[\w-]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (BASH_KEYWORDS.has(word)) {
        tokens.push({ text: word, fg: th.keyword });
      } else {
        tokens.push({ text: word, fg: th.plain });
      }
      i = j;
      continue;
    }
    tokens.push({ text: line[i], fg: th.plain });
    i++;
  }
  return tokens;
}

function tokenizeJson(line: string): SyntaxToken[] {
  const th = fallbackTheme();
  const tokens: SyntaxToken[] = [];
  let i = 0;

  while (i < line.length) {
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') { if (line[j] === '\\') j++; j++; }
      const str = line.slice(i, j + 1);
      // JSON key: followed by :
      const rest = line.slice(j + 1).trimStart();
      if (rest.startsWith(':')) {
        tokens.push({ text: str, fg: th.property });
      } else {
        tokens.push({ text: str, fg: th.string });
      }
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[0-9.eE+-]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), fg: th.number });
      i = j;
      continue;
    }
    const boolNull = ['true', 'false', 'null'].find(k => line.startsWith(k, i));
    if (boolNull) {
      tokens.push({ text: boolNull, fg: th.keyword });
      i += boolNull.length;
      continue;
    }
    tokens.push({ text: line[i], fg: th.punctuation });
    i++;
  }
  return tokens;
}

function tokenizeYaml(line: string): SyntaxToken[] {
  const th = fallbackTheme();
  const tokens: SyntaxToken[] = [];
  if (line.trimStart().startsWith('#')) {
    return [{ text: line, fg: th.comment, italic: true }];
  }
  const keyMatch = line.match(/^(\s*)([^:]+)(:)(\s*.*)/);
  if (keyMatch) {
    if (keyMatch[1]) tokens.push({ text: keyMatch[1], fg: th.plain });
    tokens.push({ text: keyMatch[2], fg: th.property });
    tokens.push({ text: keyMatch[3], fg: th.punctuation });
    if (keyMatch[4]) {
      const val = keyMatch[4];
      const trimVal = val.trimStart();
      // Differentiate YAML value types for syntax highlighting
      const isStr = /^['"]/.test(trimVal);
      const isBool = trimVal === 'true' || trimVal === 'false' || trimVal === 'null' || trimVal === 'yes' || trimVal === 'no';
      const isNum = /^-?[0-9]/.test(trimVal);
      const valFg = isStr ? th.string : isBool ? th.keyword : isNum ? th.number : th.plain;
      tokens.push({ text: val, fg: valFg });
    }
    return tokens;
  }
  return [{ text: line, fg: th.plain }];
}

function tokenizePlain(line: string): SyntaxToken[] {
  const th = fallbackTheme();
  return [{ text: line, fg: th.plain }];
}

// ─── Line highlighting outside a code block ─────────────────────────────────

/**
 * Syntax colors for lines of code in `lang` (a fence tag or a file extension),
 * one token list per line: the tree-sitter result once it is cached, the regex
 * tokenizer until then. The Changes modal colors diff lines with this.
 */
export function highlightCodeLines(codeLines: readonly string[], lang: string): SyntaxToken[][] {
  const hl = lang ? _sharedHighlighter.highlight(codeLines.join('\n'), lang) : null;
  const language = detectLanguage(lang);
  return codeLines.map((line, i) => {
    const fromTree = hl?.[i];
    if (fromTree && fromTree.length > 0) return fromTree as HLToken[];
    switch (language) {
      case 'ts': return tokenizeTsJs(line);
      case 'python': return tokenizePython(line);
      case 'bash': return tokenizeBash(line);
      case 'json': return tokenizeJson(line);
      case 'yaml': return tokenizeYaml(line);
      default: return tokenizePlain(line);
    }
  });
}

// ─── Main Renderer ───────────────────────────────────────────────────────────

/**
 * Module-level SyntaxHighlighter singleton.
 * Shared across all renderCodeBlock calls so the parse cache and pending-dedup
 * set persist between renders. Creating a new instance per call was throwing away
 * cached results and defeating the FIFO-200 cache.
 */
const _sharedHighlighter = new SyntaxHighlighter();

/**
 * The shared highlighter's state, for anything that caches drawn code: a line
 * drawn with the regex placeholder (a miss) is stale once the generation moves
 * on, and onSyntaxHighlightReady says when to repaint.
 */
export function syntaxHighlightGeneration(): number { return _sharedHighlighter.generation; }
export function syntaxHighlightMisses(): number { return _sharedHighlighter.missCount; }
export function onSyntaxHighlightReady(listener: () => void): () => void { return _sharedHighlighter.onReady(listener); }
/** Resolves once no parse is in flight: a frame drawn after it no longer depends on timing or on what drew before. */
export function settleSyntaxHighlighting(): Promise<void> { return _sharedHighlighter.settle(); }

/**
 * renderCodeBlock - Render lines of code with syntax highlighting and line numbers.
 * Returns Line[] for the cell-based pipeline.
 */
export function renderCodeBlock(
  codeLines: string[],
  lang: string,
  width: number,
  opts: { showLineNumbers?: boolean; isStreaming?: boolean } = {},
): Line[] {
  const lines: Line[] = [];
  const language = detectLanguage(lang);
  // The fill starts at column 3 like every other fill (user messages, the
  // composer), so code text lands on column 5 after the 2-column padding.
  const leftMargin = LAYOUT.LEFT_MARGIN - 1;
  const showLineNumbers = opts.showLineNumbers ?? true;
  const lineNumW = showLineNumbers ? String(codeLines.length).length + 1 : 0; // e.g. "10 "
  // Text keeps 2 columns from both edges of the code fill (the Measurements
  // table's padding rule), and the fill has a blank row above and below it.
  const PAD = 2;
  const contentStartX = showLineNumbers ? leftMargin + PAD + lineNumW + 1 : leftMargin + PAD;
  const palette = activeTokens();
  const BG = palette.backgroundCode;
  const LINE_NUM_FG = palette.textFaint;
  const effectiveWidth = width - LAYOUT.RIGHT_MARGIN;

  // Try tree-sitter highlight cache first (populated asynchronously).
  // Falls back to regex tokenizer when parser not yet ready or language unsupported.
  const fullCode = codeLines.join('\n');
  const hlLines = lang ? _sharedHighlighter.highlight(fullCode, lang, opts.isStreaming ?? false) : null;

  // Regex tokenizer fallback (used when tree-sitter not ready)
  const regexTokenize = (line: string): SyntaxToken[] => {
    switch (language) {
      case 'ts': return tokenizeTsJs(line);
      case 'python': return tokenizePython(line);
      case 'bash': return tokenizeBash(line);
      case 'json': return tokenizeJson(line);
      case 'yaml': return tokenizeYaml(line);
      default: return tokenizePlain(line);
    }
  };

  // Header bar: language label
  // No header bar: the language (when the fence names one) sits muted on the
  // right of the first code row, and only when the code leaves room for it.
  const langLabel = lang;
  const padLine = createEmptyLine(width);
  for (let px = leftMargin; px < effectiveWidth; px++) padLine[px] = createStyledCell(' ', { bg: BG });
  lines.push(padLine);

  // Code lines
  for (let i = 0; i < codeLines.length; i++) {
    const rawLine = codeLines[i];
    const lineNum = String(i + 1).padStart(lineNumW);

    // Select token source: tree-sitter (accurate) or regex (fallback)
    const tokens: SyntaxToken[] =
      hlLines && i < hlLines.length && hlLines[i].length > 0
        ? (hlLines[i] as HLToken[])
        : regexTokenize(rawLine);

    const line: Cell[] = createEmptyLine(width);
    // Paint only the code-block body band so body rows match the header/footer width.
    for (let x = leftMargin; x < effectiveWidth; x++) {
      line[x] = createStyledCell(' ', { bg: BG });
    }

    const textEnd = effectiveWidth - PAD;
    let cx = leftMargin + PAD;
    if (showLineNumbers) {
      for (const ch of lineNum) {
        if (cx >= contentStartX) break;
        line[cx++] = createStyledCell(ch, { fg: LINE_NUM_FG, bg: BG });
      }
      line[cx++] = createStyledCell(' ', { bg: BG });
    }

    // Syntax tokens
    for (const token of tokens) {
      for (const ch of token.text) {
        if (cx >= textEnd) break;
        const cw = getDisplayWidth(ch);
        const code = ch.charCodeAt(0);
        if (code < 32 || code === 127) {
          cx++;
          continue;
        }
        // A wide glyph that does not fit before the text edge ends the row
        // rather than drawing half of itself into the padding.
        if (cx + cw > textEnd) break;
        line[cx] = createStyledCell(ch, { fg: token.fg, bg: BG, bold: token.bold, italic: token.italic });
        // Bound the wide-glyph placeholder against the body's own right edge
        // (effectiveWidth), not the full line width, otherwise a 2-column
        // glyph landing on the last body column spills its placeholder cell
        // into the reserved right-margin band the header/footer stop at.
        if (cw === 2 && cx + 1 < textEnd) line[cx + 1] = { ...line[cx], char: '' };
        cx += cw;
      }
    }

    if (i === 0 && langLabel) {
      const labelX = textEnd - getDisplayWidth(langLabel);
      if (labelX > cx + 1) {
        let lx = labelX;
        for (const ch of langLabel) line[lx++] = createStyledCell(ch, { fg: palette.textMuted, bg: BG });
      }
    }

    lines.push(line);
  }

  // Footer line
  const footerLine = createEmptyLine(width);
  for (let fx = leftMargin; fx < effectiveWidth; fx++) {
    footerLine[fx] = createStyledCell(' ', { bg: BG });
  }
  lines.push(footerLine);

  return lines;
}
