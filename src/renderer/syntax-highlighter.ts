/**
 * SyntaxHighlighter — Tree-sitter-powered syntax highlighting for code blocks.
 *
 * Designed for the synchronous TUI render loop:
 * - Initializes tree-sitter WASM and grammar parsers asynchronously in background
 * - Returns cached highlight data synchronously from highlight()
 * - Falls back to empty array (caller uses regex tokenizer) when parser not ready
 * - Caches parsed results keyed by language + content hash to avoid re-parsing
 *
 * Vaporwave color theme:
 *   Keywords:          #d000ff  (purple)
 *   Strings:           #00ff88  (green)
 *   Numbers:           #ffcc00  (yellow)
 *   Comments:          #666666  (dim grey)
 *   Functions/methods: #00ffff  (cyan)
 *   Types/classes:     #ff6b9d  (pink)
 *   Operators:         #ffffff  (white)
 *   Properties:        #87ceeb  (light blue)
 *   Built-ins/special: #ff8c00  (orange)
 *   Default:           252      (light grey)
 */
import type { Node } from 'web-tree-sitter';
import { TreeSitterService } from '../intelligence/tree-sitter/service.ts';
import { logger } from '../utils/logger.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SyntaxToken {
  text: string;
  fg: string;
  bold?: boolean;
  italic?: boolean;
}

export type HighlightedLine = SyntaxToken[];

// ─── Language Alias Map ──────────────────────────────────────────────────────

// Maps fence tag language strings → tree-sitter language IDs
const FENCE_TO_LANG_ID: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  json: 'json',
  json5: 'json',
  css: 'css',
  scss: 'css',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
};

// ─── Vaporwave Color Mapping ─────────────────────────────────────────────────

// Map tree-sitter node types to vaporwave theme colors.
// The node types are specific to each grammar's output.
const NODE_TYPE_COLORS: Record<string, { fg: string; bold?: boolean; italic?: boolean }> = {
  // ── Keywords
  'if': { fg: '#d000ff', bold: true },
  'else': { fg: '#d000ff', bold: true },
  'return': { fg: '#d000ff', bold: true },
  'const': { fg: '#d000ff', bold: true },
  'let': { fg: '#d000ff', bold: true },
  'var': { fg: '#d000ff', bold: true },
  'function': { fg: '#d000ff', bold: true },
  'class': { fg: '#d000ff', bold: true },
  'import': { fg: '#d000ff', bold: true },
  'export': { fg: '#d000ff', bold: true },
  'from': { fg: '#d000ff', bold: true },
  'new': { fg: '#d000ff', bold: true },
  'typeof': { fg: '#d000ff', bold: true },
  'instanceof': { fg: '#d000ff', bold: true },
  'in': { fg: '#d000ff', bold: true },
  'of': { fg: '#d000ff', bold: true },
  'for': { fg: '#d000ff', bold: true },
  'while': { fg: '#d000ff', bold: true },
  'do': { fg: '#d000ff', bold: true },
  'switch': { fg: '#d000ff', bold: true },
  'case': { fg: '#d000ff', bold: true },
  'break': { fg: '#d000ff', bold: true },
  'continue': { fg: '#d000ff', bold: true },
  'throw': { fg: '#d000ff', bold: true },
  'try': { fg: '#d000ff', bold: true },
  'catch': { fg: '#d000ff', bold: true },
  'finally': { fg: '#d000ff', bold: true },
  'async': { fg: '#d000ff', bold: true },
  'await': { fg: '#d000ff', bold: true },
  'yield': { fg: '#d000ff', bold: true },
  'delete': { fg: '#d000ff', bold: true },
  'void': { fg: '#d000ff', bold: true },
  'static': { fg: '#d000ff', bold: true },
  'extends': { fg: '#d000ff', bold: true },
  'implements': { fg: '#d000ff', bold: true },
  'interface': { fg: '#d000ff', bold: true },
  'type': { fg: '#d000ff', bold: true },
  'enum': { fg: '#d000ff', bold: true },
  'namespace': { fg: '#d000ff', bold: true },
  'abstract': { fg: '#d000ff', bold: true },
  'readonly': { fg: '#d000ff', bold: true },
  'as': { fg: '#d000ff', bold: true },
  'satisfies': { fg: '#d000ff', bold: true },
  // Python keywords
  'def': { fg: '#d000ff', bold: true },
  'lambda': { fg: '#d000ff', bold: true },
  'with': { fg: '#d000ff', bold: true },
  'pass': { fg: '#d000ff', bold: true },
  'global': { fg: '#d000ff', bold: true },
  'nonlocal': { fg: '#d000ff', bold: true },
  'assert': { fg: '#d000ff', bold: true },
  'raise': { fg: '#d000ff', bold: true },
  'except': { fg: '#d000ff', bold: true },
  'elif': { fg: '#d000ff', bold: true },
  'and': { fg: '#d000ff', bold: true },
  'or': { fg: '#d000ff', bold: true },
  'not': { fg: '#d000ff', bold: true },
  'is': { fg: '#d000ff', bold: true },
  // Bash keywords
  'then': { fg: '#d000ff', bold: true },
  'fi': { fg: '#d000ff', bold: true },
  'done': { fg: '#d000ff', bold: true },
  'esac': { fg: '#d000ff', bold: true },

  // ── Strings
  'string': { fg: '#00ff88' },
  'string_fragment': { fg: '#00ff88' },
  'template_string': { fg: '#00ff88' },
  'escape_sequence': { fg: '#00ff88' },
  'raw_string': { fg: '#00ff88' },
  'concatenated_string': { fg: '#00ff88' },
  'string_content': { fg: '#00ff88' },
  'quoted_attribute_value': { fg: '#00ff88' },
  'attribute_value': { fg: '#00ff88' },
  'pair_value': { fg: '#00ff88' },
  'plain_value': { fg: '#00ff88' },

  // ── Numbers
  'number': { fg: '#ffcc00' },
  'integer': { fg: '#ffcc00' },
  'float': { fg: '#ffcc00' },
  'decimal_integer_literal': { fg: '#ffcc00' },
  'hex_integer_literal': { fg: '#ffcc00' },
  'octal_integer_literal': { fg: '#ffcc00' },
  'binary_integer_literal': { fg: '#ffcc00' },

  // ── Comments
  'comment': { fg: '#666666', italic: true },
  'line_comment': { fg: '#666666', italic: true },
  'block_comment': { fg: '#666666', italic: true },
  'shebang': { fg: '#666666', italic: true },

  // ── Functions/methods
  'function_declaration': { fg: '#00ffff' },
  'method_declaration': { fg: '#00ffff' },
  'method_definition': { fg: '#00ffff' },
  'arrow_function': { fg: '#00ffff' },
  'function_expression': { fg: '#00ffff' },
  'call_expression': { fg: '#00ffff' },
  'function_definition': { fg: '#00ffff' }, // Python

  // ── Types and classes
  'type_identifier': { fg: '#ff6b9d' },
  'type_annotation': { fg: '#ff6b9d' },
  'class_declaration': { fg: '#ff6b9d' },
  'class_definition': { fg: '#ff6b9d' }, // Python
  'interface_declaration': { fg: '#ff6b9d' },
  'type_alias_declaration': { fg: '#ff6b9d' },
  'predefined_type': { fg: '#ff6b9d' },
  'builtin_type': { fg: '#ff6b9d' },
  'tag_name': { fg: '#ff6b9d' },
  'element': { fg: '#ff6b9d' },

  // ── Operators
  '+': { fg: '#ffffff' },
  '-': { fg: '#ffffff' },
  '*': { fg: '#ffffff' },
  '/': { fg: '#ffffff' },
  '%': { fg: '#ffffff' },
  '=': { fg: '#ffffff' },
  '==': { fg: '#ffffff' },
  '===': { fg: '#ffffff' },
  '!=': { fg: '#ffffff' },
  '!==': { fg: '#ffffff' },
  '<': { fg: '#ffffff' },
  '>': { fg: '#ffffff' },
  '<=': { fg: '#ffffff' },
  '>=': { fg: '#ffffff' },
  '&&': { fg: '#ffffff' },
  '||': { fg: '#ffffff' },
  '??': { fg: '#ffffff' },
  '=>': { fg: '#ffffff' },
  '!': { fg: '#ffffff' },
  '&': { fg: '#ffffff' },
  '|': { fg: '#ffffff' },
  '^': { fg: '#ffffff' },
  '~': { fg: '#ffffff' },
  '<<': { fg: '#ffffff' },
  '>>': { fg: '#ffffff' },
  '>>>': { fg: '#ffffff' },

  // ── Properties
  'property_identifier': { fg: '#87ceeb' },
  'shorthand_property_identifier': { fg: '#87ceeb' },
  'attribute_name': { fg: '#87ceeb' },
  'property_name': { fg: '#87ceeb' },
  'pair_key': { fg: '#87ceeb' },

  // ── Built-ins / special values
  'true': { fg: '#ff8c00' },
  'false': { fg: '#ff8c00' },
  'null': { fg: '#ff8c00' },
  'undefined': { fg: '#ff8c00' },
  'none': { fg: '#ff8c00' },
  'None': { fg: '#ff8c00' },
  'True': { fg: '#ff8c00' },
  'False': { fg: '#ff8c00' },
  'this': { fg: '#ff8c00' },
  'super': { fg: '#ff8c00' },
  'self': { fg: '#ff8c00' },
  'boolean': { fg: '#ff8c00' },

  // ── JSON specific
  'json_string': { fg: '#00ff88' },
  'json_key': { fg: '#87ceeb' },
  'json_number': { fg: '#ffcc00' },

  // ── CSS specific
  'class_selector': { fg: '#ff6b9d' },
  'id_selector': { fg: '#ff6b9d' },
  'pseudo_class_selector': { fg: '#d000ff' },
  'pseudo_element_selector': { fg: '#d000ff' },
  'property_name_css': { fg: '#87ceeb' },
  'unit': { fg: '#ffcc00' },
  'color_value': { fg: '#00ff88' },
  'at_keyword': { fg: '#d000ff', bold: true },
  'important': { fg: '#d000ff', bold: true },
};

// Default color for unrecognized node types
const DEFAULT_FG = '252';

// ─── Content Hash ─────────────────────────────────────────────────────────────

/** Cheap DJB2-variant hash for cache keying. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h;
}

// ─── AST Walker ──────────────────────────────────────────────────────────────

interface Span {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  text: string;
  fg: string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * Walk the AST and collect leaf nodes with their positions and colors.
 * Returns a flat array of colored spans that covers all tokens in the code.
 */
function collectSpans(root: Node, code: string): Span[] {
  const spans: Span[] = [];

  function getStyle(node: Node): { fg: string; bold?: boolean; italic?: boolean } | null {
    // Named nodes (keywords, identifiers, etc.)
    const namedStyle = NODE_TYPE_COLORS[node.type];
    if (namedStyle) return namedStyle;

    // Anonymous nodes (punctuation, operators, keywords stored as literals)
    if (!node.isNamed) {
      const text = node.text.trim();
      const literalStyle = NODE_TYPE_COLORS[text];
      if (literalStyle) return literalStyle;
    }

    return null;
  }

  function visit(node: Node): void {
    // Leaf nodes: emit a span
    if (node.childCount === 0) {
      const style = getStyle(node);
      const text = node.text;
      if (text.length === 0) return;
      spans.push({
        startRow: node.startPosition.row,
        startCol: node.startPosition.column,
        endRow: node.endPosition.row,
        endCol: node.endPosition.column,
        text,
        fg: style?.fg ?? DEFAULT_FG,
        bold: style?.bold,
        italic: style?.italic,
      });
      return;
    }

    // For named nodes with a dominant style (comments, strings, etc.),
    // emit as a single span rather than recursing into children.
    // This prevents partial coloring of multi-char nodes.
    const style = getStyle(node);
    if (style && isLeafLike(node)) {
      const text = node.text;
      if (text.length === 0) return;
      spans.push({
        startRow: node.startPosition.row,
        startCol: node.startPosition.column,
        endRow: node.endPosition.row,
        endCol: node.endPosition.column,
        text,
        fg: style.fg,
        bold: style.bold,
        italic: style.italic,
      });
      return;
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  }

  visit(root);

  // Sort spans by start position for proper ordering
  spans.sort((a, b) => {
    if (a.startRow !== b.startRow) return a.startRow - b.startRow;
    return a.startCol - b.startCol;
  });

  return spans;
}

/** Node types where we emit the whole subtree as one colored span. */
const LEAF_LIKE_TYPES = new Set([
  'string', 'template_string', 'comment', 'line_comment', 'block_comment',
  'raw_string', 'concatenated_string', 'string_content', 'shebang',
  'attribute_value', 'quoted_attribute_value',
]);

function isLeafLike(node: Node): boolean {
  return LEAF_LIKE_TYPES.has(node.type);
}

// ─── Span → Per-line Token Arrays ────────────────────────────────────────────

/**
 * Convert a flat list of positioned spans into per-line SyntaxToken arrays.
 * Handles multi-line spans (e.g., block comments, template literals).
 */
function spansToLines(spans: Span[], codeLines: string[]): HighlightedLine[] {
  // Initialize result: one entry per code line, each starting with no tokens
  const result: HighlightedLine[] = codeLines.map(() => []);

  // Track the current position to emit default-colored text for gaps
  const linePositions: number[] = codeLines.map(() => 0);

  for (const span of spans) {
    // For single-line spans
    if (span.startRow === span.endRow) {
      const row = span.startRow;
      if (row >= codeLines.length) continue;

      // Skip if we've already passed this position (overlap)
      if (linePositions[row] > span.startCol) continue;

      // Emit gap text with default color
      const currentCol = linePositions[row];
      if (currentCol < span.startCol) {
        const gapText = codeLines[row].slice(currentCol, span.startCol);
        if (gapText) result[row].push({ text: gapText, fg: DEFAULT_FG });
      }

      const tokenText = codeLines[row].slice(span.startCol, span.endCol);
      if (tokenText) {
        result[row].push({ text: tokenText, fg: span.fg, bold: span.bold, italic: span.italic });
      }
      linePositions[row] = span.endCol;
    } else {
      // Multi-line span: slice each line
      for (let r = span.startRow; r <= span.endRow; r++) {
        if (r >= codeLines.length) break;

        const colStart = r === span.startRow ? span.startCol : 0;
        const colEnd = r === span.endRow ? span.endCol : codeLines[r].length;

        // Overlap guard FIRST
        if (linePositions[r] > colStart) continue;

        // Emit gap
        const currentCol = linePositions[r];
        if (currentCol < colStart) {
          const gapText = codeLines[r].slice(currentCol, colStart);
          if (gapText) result[r].push({ text: gapText, fg: DEFAULT_FG });
        }

        const tokenText = codeLines[r].slice(colStart, colEnd);
        if (tokenText) {
          result[r].push({ text: tokenText, fg: span.fg, bold: span.bold, italic: span.italic });
        }
        linePositions[r] = colEnd;
      }
    }
  }

  // Fill remaining text on each line with default color
  for (let r = 0; r < codeLines.length; r++) {
    const remaining = codeLines[r].slice(linePositions[r]);
    if (remaining) result[r].push({ text: remaining, fg: DEFAULT_FG });
  }

  return result;
}

// ─── SyntaxHighlighter Class ──────────────────────────────────────────────────

const MAX_HIGHLIGHT_CACHE = 200;

export class SyntaxHighlighter {
  private service: TreeSitterService;
  private cache: Map<string, HighlightedLine[]> = new Map();
  private pending: Set<string> = new Set();
  private static instance: SyntaxHighlighter | null = null;

  private constructor() {
    this.service = TreeSitterService.getInstance();
    // Kick off WASM initialization in background
    this.service.initialize().catch((err: unknown) => {
      logger.warn('SyntaxHighlighter: background init failed', { error: String(err) });
    });
  }

  static getInstance(): SyntaxHighlighter {
    if (!SyntaxHighlighter.instance) {
      SyntaxHighlighter.instance = new SyntaxHighlighter();
    }
    return SyntaxHighlighter.instance;
  }

  /**
   * Map a fence tag language string to a tree-sitter language ID.
   * Returns null if the language is not supported by tree-sitter.
   */
  fenceToLangId(fenceTag: string): string | null {
    return FENCE_TO_LANG_ID[fenceTag.toLowerCase()] ?? null;
  }

  /**
   * Synchronous highlight lookup.
   *
   * If the highlight cache has a result for this code+language, returns it.
   * Otherwise, schedules an async parse in background and returns null.
   * Callers should fall back to regex-based tokenization when null is returned.
   */
  highlight(code: string, fenceTag: string): HighlightedLine[] | null {
    const langId = this.fenceToLangId(fenceTag);
    if (!langId) return null; // unsupported language

    const key = `${langId}:${hashString(code)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Schedule background parse if not already pending
    if (!this.pending.has(key)) {
      this.scheduleParse(code, langId, key);
    }

    return null; // not ready yet
  }

  /**
   * Schedule an async parse. Fires and forgets — result lands in cache.
   * Callers will pick it up on the next render cycle.
   */
  private scheduleParse(code: string, langId: string, key: string): void {
    this.pending.add(key);

    // Use a stable virtual path for the parser cache key
    const virtualPath = `__highlight__.${langId}`;

    Promise.resolve().then(async () => {
      try {
        // Ensure the grammar is loaded
        const language = await this.service.loadLanguage(langId);
        if (!language) {
          logger.debug('SyntaxHighlighter: grammar not available', { langId });
          return;
        }

        // Parse the code
        const tree = await this.service.parse(virtualPath, code, langId);
        if (!tree) {
          logger.debug('SyntaxHighlighter: parse returned null', { langId });
          return;
        }

        // Walk AST and build per-line token arrays
        const codeLines = code.split('\n');
        const spans = collectSpans(tree.rootNode, code);
        const highlighted = spansToLines(spans, codeLines);

        // Evict oldest entry if at capacity (FIFO)
        if (this.cache.size >= MAX_HIGHLIGHT_CACHE) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey !== undefined) this.cache.delete(firstKey);
        }

        this.cache.set(key, highlighted);
        logger.debug('SyntaxHighlighter: parsed and cached', { langId, lines: codeLines.length });
      } catch (err) {
        logger.warn('SyntaxHighlighter: parse error', { langId, error: String(err) });
      } finally {
        this.pending.delete(key);
      }
    });
  }

  /** Clear all cached highlights (e.g., on theme change). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Current cache size (for diagnostics). */
  get cacheSize(): number {
    return this.cache.size;
  }
}

/** Global singleton — import and use directly. */
export const syntaxHighlighter = SyntaxHighlighter.getInstance();
