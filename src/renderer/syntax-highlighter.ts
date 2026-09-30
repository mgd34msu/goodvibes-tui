/**
 * SyntaxHighlighter, Tree-sitter-powered syntax highlighting for code blocks.
 *
 * Designed for the synchronous TUI render loop:
 * - Initializes tree-sitter WASM and grammar parsers asynchronously in background
 * - Returns cached highlight data synchronously from highlight()
 * - Falls back to empty array (caller uses regex tokenizer) when parser not ready
 * - Caches parsed results keyed by language + content hash to avoid re-parsing
 *
 * Colours: every node type maps to a syntax role (keyword, string, number,
 * comment, function, type, operator, property, builtin, plain); the active
 * theme's syntax tokens colour each role (syntax-theme.ts). The cache holds
 * roles, so a theme change re-colours cached blocks without re-parsing.
 */
import type { Node } from 'web-tree-sitter';
import { TreeSitterService } from '@pellux/goodvibes-sdk/platform/intelligence';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { syntaxStyles, type SyntaxRole, type SyntaxStyle } from './syntax-theme.ts';

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

// ─── Node Type → Syntax Role ─────────────────────────────────────────────────

// Map tree-sitter node types to syntax roles; syntax-theme.ts turns a role into
// the active theme's colour (shared with code-block.ts's regex fallback).
// The node types are specific to each grammar's output.
const NODE_TYPE_COLORS: Record<string, SyntaxRole> = {
  // ── Keywords
  'if': 'keyword',
  'else': 'keyword',
  'return': 'keyword',
  'const': 'keyword',
  'let': 'keyword',
  'var': 'keyword',
  'function': 'keyword',
  'class': 'keyword',
  'import': 'keyword',
  'export': 'keyword',
  'from': 'keyword',
  'new': 'keyword',
  'typeof': 'keyword',
  'instanceof': 'keyword',
  'in': 'keyword',
  'of': 'keyword',
  'for': 'keyword',
  'while': 'keyword',
  'do': 'keyword',
  'switch': 'keyword',
  'case': 'keyword',
  'break': 'keyword',
  'continue': 'keyword',
  'throw': 'keyword',
  'try': 'keyword',
  'catch': 'keyword',
  'finally': 'keyword',
  'async': 'keyword',
  'await': 'keyword',
  'yield': 'keyword',
  'delete': 'keyword',
  'void': 'keyword',
  'static': 'keyword',
  'extends': 'keyword',
  'implements': 'keyword',
  'interface': 'keyword',
  'type': 'keyword',
  'enum': 'keyword',
  'namespace': 'keyword',
  'abstract': 'keyword',
  'readonly': 'keyword',
  'as': 'keyword',
  'satisfies': 'keyword',
  // Python keywords
  'def': 'keyword',
  'lambda': 'keyword',
  'with': 'keyword',
  'pass': 'keyword',
  'global': 'keyword',
  'nonlocal': 'keyword',
  'assert': 'keyword',
  'raise': 'keyword',
  'except': 'keyword',
  'elif': 'keyword',
  'and': 'keyword',
  'or': 'keyword',
  'not': 'keyword',
  'is': 'keyword',
  // Bash keywords
  'then': 'keyword',
  'fi': 'keyword',
  'done': 'keyword',
  'esac': 'keyword',

  // ── Strings
  'string': 'string',
  'string_fragment': 'string',
  'template_string': 'string',
  'escape_sequence': 'string',
  'raw_string': 'string',
  'concatenated_string': 'string',
  'string_content': 'string',
  'quoted_attribute_value': 'string',
  'attribute_value': 'string',
  'pair_value': 'string',
  'plain_value': 'string',

  // ── Numbers
  'number': 'number',
  'integer': 'number',
  'float': 'number',
  'decimal_integer_literal': 'number',
  'hex_integer_literal': 'number',
  'octal_integer_literal': 'number',
  'binary_integer_literal': 'number',

  // ── Comments
  'comment': 'comment',
  'line_comment': 'comment',
  'block_comment': 'comment',
  'shebang': 'comment',

  // ── Functions/methods
  'function_declaration': 'function',
  'method_declaration': 'function',
  'method_definition': 'function',
  'arrow_function': 'function',
  'function_expression': 'function',
  'call_expression': 'function',
  'function_definition': 'function', // Python

  // ── Types and classes
  'type_identifier': 'type',
  'type_annotation': 'type',
  'class_declaration': 'type',
  'class_definition': 'type', // Python
  'interface_declaration': 'type',
  'type_alias_declaration': 'type',
  'predefined_type': 'type',
  'builtin_type': 'type',
  'tag_name': 'type',
  'element': 'type',

  // ── Operators
  '+': 'operator',
  '-': 'operator',
  '*': 'operator',
  '/': 'operator',
  '%': 'operator',
  '=': 'operator',
  '==': 'operator',
  '===': 'operator',
  '!=': 'operator',
  '!==': 'operator',
  '<': 'operator',
  '>': 'operator',
  '<=': 'operator',
  '>=': 'operator',
  '&&': 'operator',
  '||': 'operator',
  '??': 'operator',
  '=>': 'operator',
  '!': 'operator',
  '&': 'operator',
  '|': 'operator',
  '^': 'operator',
  '~': 'operator',
  '<<': 'operator',
  '>>': 'operator',
  '>>>': 'operator',

  // ── Properties
  'property_identifier': 'property',
  'shorthand_property_identifier': 'property',
  'attribute_name': 'property',
  'property_name': 'property',
  'pair_key': 'property',

  // ── Built-ins / special values
  'true': 'builtin',
  'false': 'builtin',
  'null': 'builtin',
  'undefined': 'builtin',
  'none': 'builtin',
  'None': 'builtin',
  'True': 'builtin',
  'False': 'builtin',
  'this': 'builtin',
  'super': 'builtin',
  'self': 'builtin',
  'boolean': 'builtin',

  // ── JSON specific
  'json_string': 'string',
  'json_key': 'property',
  'json_number': 'number',

  // ── CSS specific
  'class_selector': 'type',
  'id_selector': 'type',
  'pseudo_class_selector': 'keyword',
  'pseudo_element_selector': 'keyword',
  'property_name_css': 'property',
  'unit': 'number',
  'color_value': 'string',
  'at_keyword': 'keyword',
  'important': 'keyword',
};

// Default role for unrecognized node types
const DEFAULT_ROLE: SyntaxRole = 'plain';

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
  role: SyntaxRole;
}

/** A cached token: text plus its role (colour resolved per theme on read). */
interface RoleToken {
  text: string;
  role: SyntaxRole;
}

type RoleLine = RoleToken[];

/**
 * Walk the AST and collect leaf nodes with their positions and colors.
 * Returns a flat array of colored spans that covers all tokens in the code.
 */
function collectSpans(root: Node, code: string): Span[] {
  const spans: Span[] = [];

  function getStyle(node: Node): SyntaxRole | null {
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
        role: style ?? DEFAULT_ROLE,
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
        role: style,
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
function spansToLines(spans: Span[], codeLines: string[]): RoleLine[] {
  const result: RoleLine[] = codeLines.map(() => []);

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
        if (gapText) result[row].push({ text: gapText, role: DEFAULT_ROLE });
      }

      const tokenText = codeLines[row].slice(span.startCol, span.endCol);
      if (tokenText) {
        result[row].push({ text: tokenText, role: span.role });
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
          if (gapText) result[r].push({ text: gapText, role: DEFAULT_ROLE });
        }

        const tokenText = codeLines[r].slice(colStart, colEnd);
        if (tokenText) {
          result[r].push({ text: tokenText, role: span.role });
        }
        linePositions[r] = colEnd;
      }
    }
  }

  // Fill remaining text on each line with default color
  for (let r = 0; r < codeLines.length; r++) {
    const remaining = codeLines[r].slice(linePositions[r]);
    if (remaining) result[r].push({ text: remaining, role: DEFAULT_ROLE });
  }

  return result;
}

// ─── SyntaxHighlighter Class ──────────────────────────────────────────────────

const MAX_HIGHLIGHT_CACHE = 200;

/** A parsed block: roles, plus the colours resolved for the last theme read. */
interface HighlightEntry {
  readonly roles: RoleLine[];
  resolved?: HighlightedLine[];
  resolvedFor?: Readonly<Record<SyntaxRole, SyntaxStyle>>;
}

function resolveRoleLines(roles: RoleLine[], styles: Readonly<Record<SyntaxRole, SyntaxStyle>>): HighlightedLine[] {
  return roles.map((line) => line.map(({ text, role }) => {
    const style = styles[role];
    return style.italic ? { text, fg: style.fg, italic: true } : { text, fg: style.fg };
  }));
}

export class SyntaxHighlighter {
  private service: TreeSitterService;
  private cache: Map<string, HighlightEntry> = new Map();
  private pending: Set<string> = new Set();
  /** Blocks whose parse cannot succeed (no grammar, parse failed): never rescheduled, always the regex tokens. */
  private failed: Set<string> = new Set();
  private inflight: Set<Promise<void>> = new Set();
  private readonly readyListeners = new Set<() => void>();
  private _generation = 0;
  private _misses = 0;
  /** Numbers each parse's virtual path, so no two parses in flight share a tree. */
  private parseSeq = 0;

  constructor() {
    this.service = new TreeSitterService();
    // Kick off WASM initialization in background
    this.service.initialize().catch((err: unknown) => {
      logger.warn('SyntaxHighlighter: background init failed', { error: summarizeError(err) });
    });
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
   *
   * @param isStreaming - When true, suppresses background parse scheduling.
   *   The regex tokenizer serves during streaming; tree-sitter is scheduled only
   *   when the block is finalized (isStreaming=false or omitted) to avoid ~50
   *   wasted async parses per streamed block that thrash the FIFO cache.
   */
  highlight(code: string, fenceTag: string, isStreaming = false): HighlightedLine[] | null {
    const langId = this.fenceToLangId(fenceTag);
    if (!langId) return null; // unsupported language

    const key = `${langId}:${hashString(code)}`;
    const cached = this.cache.get(key);
    if (cached) {
      // Colours follow the active theme: re-resolve when the theme changed.
      const styles = syntaxStyles();
      if (cached.resolvedFor !== styles || cached.resolved === undefined) {
        cached.resolved = resolveRoleLines(cached.roles, styles);
        cached.resolvedFor = styles;
      }
      return cached.resolved;
    }

    // Do not schedule background parse while the block is still being streamed.
    // The regex tokenizer serves during streaming (as designed). Schedule parse
    // only when isStreaming=false, i.e., the block has been finalized.
    if (!isStreaming && !this.failed.has(key)) {
      // The caller draws the regex placeholder and a parse result is on its
      // way: whatever it caches must be redrawn when the result lands.
      this._misses++;
      if (!this.pending.has(key)) this.scheduleParse(code, langId, key);
    }

    return null; // not ready yet
  }

  /**
   * Schedule an async parse. Fires and forgets, result lands in cache.
   * Callers will pick it up on the next render cycle.
   */
  private scheduleParse(code: string, langId: string, key: string): void {
    this.pending.add(key);

    // Each parse gets its own virtual path. The service keeps one tree per
    // path and deletes the previous tree when the same path is parsed again,
    // so a shared path let a second parse in flight free this parse's tree
    // before collectSpans walked it: the spans came from freed memory, the
    // wrong colours were cached for good, and which ones depended on what
    // else was being highlighted at the time. The tree is released (the
    // service's invalidate) once this parse has walked it.
    const virtualPath = `__highlight__/${++this.parseSeq}.${langId}`;

    const run = Promise.resolve().then(async () => {
      let landed = false;
      let parsed = false;
      try {
        // Ensure the grammar is loaded
        const language = await this.service.loadLanguage(langId);
        if (!language) {
          logger.debug('SyntaxHighlighter: grammar not available', { langId });
          this.markFailed(key);
          return;
        }

        // Parse the code
        const tree = await this.service.parse(virtualPath, code, langId);
        parsed = true;
        if (!tree) {
          logger.debug('SyntaxHighlighter: parse returned null', { langId });
          this.markFailed(key);
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

        this.cache.set(key, { roles: highlighted });
        this._generation++;
        landed = true;
        logger.debug('SyntaxHighlighter: parsed and cached', { langId, lines: codeLines.length });
      } catch (err) {
        logger.warn('SyntaxHighlighter: parse error', { langId, error: summarizeError(err) });
        this.markFailed(key);
      } finally {
        if (parsed) this.service.invalidate(virtualPath);
        this.pending.delete(key);
      }
      if (landed) for (const listener of this.readyListeners) listener();
    });
    this.inflight.add(run);
    void run.finally(() => { this.inflight.delete(run); });
  }

  private markFailed(key: string): void {
    if (this.failed.size >= MAX_HIGHLIGHT_CACHE) {
      const first = this.failed.values().next().value;
      if (first !== undefined) this.failed.delete(first);
    }
    this.failed.add(key);
  }

  /**
   * Bumped every time a parse result lands (and when the cache is cleared).
   * Anything drawn while a parse was on its way (a miss) is stale once this
   * moves on.
   */
  get generation(): number {
    return this._generation;
  }

  /** Bumped every time highlight() hands back the placeholder while a parse result is on its way. */
  get missCount(): number {
    return this._misses;
  }

  /** Be told when a parse result lands (repaint what drew the placeholder). */
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => { this.readyListeners.delete(listener); };
  }

  /** Resolves once no parse is in flight (tests capture settled frames with it). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** Clear all cached highlights (e.g., on theme change). */
  clearCache(): void {
    this.cache.clear();
    this.failed.clear();
    this._generation++;
  }

  /** Current cache size (for diagnostics). */
  get cacheSize(): number {
    return this.cache.size;
  }
}
