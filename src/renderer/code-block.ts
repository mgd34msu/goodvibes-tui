import { type Line, type Cell, createStyledCell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

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
  const tokens: SyntaxToken[] = [];
  let i = 0;

  while (i < line.length) {
    // Line comment
    if (line.slice(i, i + 2) === '//') {
      tokens.push({ text: line.slice(i), fg: '65', italic: true });
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
      tokens.push({ text: line.slice(i, j + 1), fg: '#ce9178' });
      i = j + 1;
      continue;
    }
    // Number
    if (/[0-9]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[0-9._xXbBoO]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), fg: '#b5cea8' });
      i = j;
      continue;
    }
    // Identifier or keyword
    if (/[a-zA-Z_$]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[\w$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (TS_JS_KEYWORDS.has(word)) {
        tokens.push({ text: word, fg: '#569cd6', bold: true });
      } else if (TS_TYPES.has(word)) {
        tokens.push({ text: word, fg: '#4ec9b0' });
      } else if (line[j] === '(') {
        tokens.push({ text: word, fg: '#dcdcaa' });
      } else {
        tokens.push({ text: word, fg: '' });
      }
      i = j;
      continue;
    }
    // Operators and punctuation
    const ch = line[i];
    const isOp = '=<>!&|+-*/%^~?:'.includes(ch);
    tokens.push({ text: ch, fg: isOp ? '#d4d4d4' : '' });
    i++;
  }

  return tokens;
}

function tokenizePython(line: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let i = 0;

  while (i < line.length) {
    if (line[i] === '#') {
      tokens.push({ text: line.slice(i), fg: '65', italic: true });
      break;
    }
    if (line[i] === '"' || line[i] === "'") {
      const q = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
      tokens.push({ text: line.slice(i, j + 1), fg: '#ce9178' });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[0-9._]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), fg: '#b5cea8' });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[\w]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (PYTHON_KEYWORDS.has(word)) {
        tokens.push({ text: word, fg: '#569cd6', bold: true });
      } else if (/^[A-Z]/.test(word)) {
        tokens.push({ text: word, fg: '#4ec9b0' });
      } else if (line[j] === '(') {
        tokens.push({ text: word, fg: '#dcdcaa' });
      } else {
        tokens.push({ text: word, fg: '' });
      }
      i = j;
      continue;
    }
    tokens.push({ text: line[i], fg: '' });
    i++;
  }
  return tokens;
}

function tokenizeBash(line: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let i = 0;

  while (i < line.length) {
    if (line[i] === '#') {
      tokens.push({ text: line.slice(i), fg: '65', italic: true });
      break;
    }
    if (line[i] === '"' || line[i] === "'") {
      const q = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
      tokens.push({ text: line.slice(i, j + 1), fg: '#ce9178' });
      i = j + 1;
      continue;
    }
    if (line[i] === '$') {
      let j = i + 1;
      while (j < line.length && /[\w{}_]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), fg: '#9cdcfe' });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[\w-]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (BASH_KEYWORDS.has(word)) {
        tokens.push({ text: word, fg: '#569cd6', bold: true });
      } else {
        tokens.push({ text: word, fg: '' });
      }
      i = j;
      continue;
    }
    tokens.push({ text: line[i], fg: '' });
    i++;
  }
  return tokens;
}

function tokenizeJson(line: string): SyntaxToken[] {
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
        tokens.push({ text: str, fg: '#9cdcfe' });
      } else {
        tokens.push({ text: str, fg: '#ce9178' });
      }
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[0-9.eE+-]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), fg: '#b5cea8' });
      i = j;
      continue;
    }
    const boolNull = ['true', 'false', 'null'].find(k => line.startsWith(k, i));
    if (boolNull) {
      tokens.push({ text: boolNull, fg: '#569cd6', bold: true });
      i += boolNull.length;
      continue;
    }
    tokens.push({ text: line[i], fg: '244' });
    i++;
  }
  return tokens;
}

function tokenizeYaml(line: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  if (line.trimStart().startsWith('#')) {
    return [{ text: line, fg: '65', italic: true }];
  }
  const keyMatch = line.match(/^(\s*)([^:]+)(:)(\s*.*)/);
  if (keyMatch) {
    if (keyMatch[1]) tokens.push({ text: keyMatch[1], fg: '' });
    tokens.push({ text: keyMatch[2], fg: '#9cdcfe' });
    tokens.push({ text: keyMatch[3], fg: '244' });
    if (keyMatch[4]) {
      const val = keyMatch[4];
      const trimVal = val.trimStart();
      // Differentiate YAML value types for syntax highlighting
      const isStr = /^['"]/.test(trimVal);
      const isBool = trimVal === 'true' || trimVal === 'false' || trimVal === 'null' || trimVal === 'yes' || trimVal === 'no';
      const isNum = /^-?[0-9]/.test(trimVal);
      const valFg = isStr ? '#ce9178' : isBool ? '#569cd6' : isNum ? '#b5cea8' : '';
      tokens.push({ text: val, fg: valFg });
    }
    return tokens;
  }
  return [{ text: line, fg: '' }];
}

function tokenizePlain(line: string): SyntaxToken[] {
  return [{ text: line, fg: '' }];
}

// ─── Main Renderer ───────────────────────────────────────────────────────────

/**
 * renderCodeBlock - Render lines of code with syntax highlighting and line numbers.
 * Returns Line[] for the cell-based pipeline.
 */
export function renderCodeBlock(codeLines: string[], lang: string, width: number): Line[] {
  const lines: Line[] = [];
  const language = detectLanguage(lang);
  const lineNumW = String(codeLines.length).length + 1; // e.g. "10 "
  const contentStartX = lineNumW + 1;
  const BG = '#0d0d0d';
  const LINE_NUM_FG = '238';

  // Tokenizer selection
  const tokenize = (line: string): SyntaxToken[] => {
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
  const langLabel = lang ? ` ${lang} ` : ' code ';
  const headerText = langLabel.padEnd(width);
  lines.push(UIFactory.stringToLine(headerText, width, { fg: '#1a1a1a', bg: '#4ec9b0', bold: true }));

  // Code lines
  for (let i = 0; i < codeLines.length; i++) {
    const rawLine = codeLines[i];
    const lineNum = String(i + 1).padStart(lineNumW);
    const tokens = tokenize(rawLine);

    const line: Cell[] = new Array(width).fill(null).map(() => createStyledCell(' ', { bg: BG }));

    // Line number
    let cx = 0;
    for (const ch of lineNum) {
      if (cx >= contentStartX) break;
      line[cx++] = createStyledCell(ch, { fg: LINE_NUM_FG, bg: BG, dim: true });
    }
    line[cx++] = createStyledCell(' ', { bg: BG });

    // Syntax tokens
    for (const token of tokens) {
      for (const ch of token.text) {
        if (cx >= width) break;
        const cw = getDisplayWidth(ch);
        const code = ch.charCodeAt(0);
        if (code < 32 || code === 127) {
          cx++;
          continue;
        }
        line[cx] = createStyledCell(ch, { fg: token.fg, bg: BG, bold: token.bold, italic: token.italic });
        if (cw === 2 && cx + 1 < width) line[cx + 1] = { ...line[cx], char: '' };
        cx += cw;
      }
    }

    lines.push(line);
  }

  // Footer line
  const footerText = ' '.repeat(width);
  lines.push(UIFactory.stringToLine(footerText, width, { bg: '#0d0d0d' }));

  return lines;
}
