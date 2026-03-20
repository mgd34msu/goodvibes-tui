import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import type { Line } from '../types/grid.ts';

// ── Symbol types ────────────────────────────────────────────────────────────

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'method' | 'namespace';

export interface SymbolEntry {
  kind: SymbolKind;
  name: string;
  line: number;
  /** If set, this symbol is a child of a parent container (class/namespace). */
  parentName?: string;
}

// ── Rendering constants ──────────────────────────────────────────────────────

/** ANSI 256-color fg codes per symbol kind. */
const KIND_COLORS: Record<SymbolKind, string> = {
  function:  '87',   // cyan
  method:    '87',   // cyan
  class:     '141',  // purple
  namespace: '141',  // purple
  interface: '219',  // pink
  type:      '228',  // yellow
  const:     '245',  // grey
};

/** Short type indicator labels. */
const KIND_LABELS: Record<SymbolKind, string> = {
  function:  'fn ',
  method:    'fn ',
  class:     'cls',
  namespace: 'ns ',
  interface: 'int',
  type:      'typ',
  const:     'cst',
};

/** Regex patterns to extract symbols. Each produces named groups: kind, name, line. */
const SYMBOL_PATTERNS: Array<{ re: RegExp; kind: SymbolKind; isContainer?: boolean }> = [
  // export class Foo / abstract class Foo
  { re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,          kind: 'class',     isContainer: true },
  // export namespace Foo
  { re: /^(?:export\s+)?namespace\s+(\w+)/,                       kind: 'namespace', isContainer: true },
  // export interface Foo
  { re: /^(?:export\s+)?interface\s+(\w+)/,                       kind: 'interface' },
  // export type Foo =
  { re: /^(?:export\s+)?type\s+(\w+)\s*[=<{]/,                   kind: 'type' },
  // export function foo / export async function foo
  { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,          kind: 'function' },
  // export const foo = ... (function expressions / arrow fns / values)
  { re: /^(?:export\s+)?const\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function|\(|\w+\s*=>)/, kind: 'function' },
  // export const foo = <non-function>
  { re: /^(?:export\s+)?const\s+(\w+)\s*(?::[^=]*)?=/,            kind: 'const' },
  // methods inside class: indented  methodName(...)
  { re: /^\s{2,}(?:(?:public|private|protected|static|async|override|readonly|abstract)\s+)*(\w+)\s*\(/, kind: 'method' },
];

// ── Panel ────────────────────────────────────────────────────────────────────

/**
 * SymbolOutlinePanel — renders a hierarchical symbol outline of the current
 * file. Symbols are parsed from source text using lightweight regex heuristics
 * (no tree-sitter or LSP required).
 */
export class SymbolOutlinePanel extends BasePanel {
  /** Flat list of parsed symbols (methods nested after their parent class). */
  private symbols: SymbolEntry[] = [];

  /** Index of the currently highlighted row in the visible flat list. */
  private selectedIndex: number = 0;

  /** Set of container names (class/namespace) that are collapsed. */
  private collapsed: Set<string> = new Set();

  /** Scroll offset (top-visible row index in the flat rendered list). */
  private scrollOffset: number = 0;

  /** Path of the file currently loaded. */
  private currentPath: string = '';

  constructor() {
    super('symbols', 'Symbols', 'S', 'development');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load and parse symbols from the given file source text.
   * Call this when the active file changes in the file-preview panel.
   */
  loadFile(path: string, source: string): void {
    this.currentPath = path;
    this.symbols = parseSymbols(source);
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.collapsed.clear();
    this.markDirty();
  }

  /**
   * Returns the { path, line } for the currently selected symbol so the
   * caller can jump to it in the file-preview panel.
   */
  getSelectedLocation(): { path: string; line: number } | null {
    const visible = this._visibleRows();
    const row = visible[this.selectedIndex];
    if (!row || row.kind === 'header') return null;
    return { path: this.currentPath, line: row.symbol.line };
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  handleInput(key: string): boolean {
    const visible = this._visibleRows();

    if (key === 'up' || key === 'k') {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this._clampScroll(visible.length);
        this.markDirty();
      }
      return true;
    }

    if (key === 'down' || key === 'j') {
      if (this.selectedIndex < visible.length - 1) {
        this.selectedIndex++;
        this._clampScroll(visible.length);
        this.markDirty();
      }
      return true;
    }

    if (key === 'return' || key === 'enter') {
      // Caller should call getSelectedLocation() after this returns true.
      return true;
    }

    if (key === 'space' || key === 'right' || key === 'left') {
      const row = visible[this.selectedIndex];
      if (row?.kind === 'header') {
        const name = row.name;
        if (this.collapsed.has(name)) {
          this.collapsed.delete(name);
        } else {
          this.collapsed.add(name);
        }
        // Clamp selection so it doesn't point into a now-hidden row
        const newVisible = this._visibleRows();
        if (this.selectedIndex >= newVisible.length) {
          this.selectedIndex = Math.max(0, newVisible.length - 1);
        }
        this._clampScroll(newVisible.length);
        this.markDirty();
      }
      return true;
    }

    return false;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];

    if (this.symbols.length === 0) {
      // Empty state
      const emptyLine = createEmptyLine(width);
      const msg = this.currentPath ? ' No symbols found' : ' No file loaded';
      _writeText(emptyLine, 1, msg, '245', '');
      lines.push(emptyLine);
      // Pad to height
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const visible = this._visibleRows();

    // Clamp scroll: bottom edge
    if (this.selectedIndex >= this.scrollOffset + height) {
      this.scrollOffset = this.selectedIndex - height + 1;
    }

    // Render rows from scrollOffset up to height
    for (let i = 0; i < height; i++) {
      const rowIdx = this.scrollOffset + i;
      const row = visible[rowIdx];
      const line = createEmptyLine(width);

      if (!row) {
        lines.push(line);
        continue;
      }

      const isSelected = rowIdx === this.selectedIndex;
      const bgColor = isSelected ? '236' : '';

      if (row.kind === 'header') {
        _renderHeader(line, width, row, isSelected, bgColor, this.collapsed);
      } else {
        _renderSymbol(line, width, row, isSelected, bgColor);
      }

      lines.push(line);
    }

    return lines;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _clampScroll(totalRows: number): void {
    // Ensure selected is within scroll view (assumes last known height ~ 20)
    // We keep a conservative viewport window; render() uses this.scrollOffset.
    const GUARD = 3;
    if (this.selectedIndex < this.scrollOffset + GUARD) {
      this.scrollOffset = Math.max(0, this.selectedIndex - GUARD);
    }
    // We don't know height here, so we defer bottom-clamp to render().
  }

  private _visibleRows(): VisibleRow[] {
    return buildVisibleRows(this.symbols, this.collapsed);
  }
}

// ── Row types for rendering ──────────────────────────────────────────────────

type VisibleRow =
  | { kind: 'header'; name: string; symbolKind: SymbolKind; line: number; hasChildren: boolean }
  | { kind: 'symbol'; symbol: SymbolEntry; depth: number };

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Parse symbols from source text. Returns a flat list ordered by line number.
 * Methods are tagged with their parent class name so the renderer can group them.
 */
function parseSymbols(source: string): SymbolEntry[] {
  const lines = source.split('\n');
  const result: SymbolEntry[] = [];
  let currentContainer: string | undefined;
  let containerKind: SymbolKind | undefined;
  let containerBraceDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    const lineNo = i + 1; // 1-based

    // Strip string literals before counting braces to avoid false positives
    const rawNoBraceStrings = raw.replace(/("|\'|\`)(?:(?!\1|\\).|\\[\s\S])*\1/g, '');

    // Track brace depth for container scoping
    for (const ch of rawNoBraceStrings) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (currentContainer !== undefined && braceDepth <= containerBraceDepth) {
          currentContainer = undefined;
          containerKind = undefined;
          containerBraceDepth = 0;
        }
      }
    }

    // Skip comment lines and blank lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed === '') continue;

    // Check container-level patterns first (class/namespace)
    let matched = false;
    for (const { re, kind, isContainer } of SYMBOL_PATTERNS) {
      const m = trimmed.match(re);
      if (!m) continue;
      const name = m[1];
      if (!name) continue;

      const entry: SymbolEntry = { kind, name, line: lineNo };

      if (currentContainer && kind === 'method') {
        entry.parentName = currentContainer;
      }

      // Don't add methods as top-level if they're inside a container
      if (kind === 'method' && !currentContainer) {
        // standalone function-like at wrong indent — skip
        matched = true;
        break;
      }

      result.push(entry);

      if (isContainer) {
        currentContainer = name;
        containerKind = kind;
        // Opening brace may be on this line or a subsequent line — track from current depth
        containerBraceDepth = braceDepth - (raw.includes('{') ? 1 : 0);
      }

      matched = true;
      break;
    }
  }

  return result;
}

/**
 * Build the flat list of rows to render, respecting collapse state.
 * Container symbols become header rows; their children are indented below.
 */
function buildVisibleRows(symbols: SymbolEntry[], collapsed: Set<string>): VisibleRow[] {
  const rows: VisibleRow[] = [];

  // Pre-compute children map to avoid O(n^2) scans inside the loop
  const childrenByParent = new Map<string, SymbolEntry[]>();
  for (const sym of symbols) {
    if (sym.parentName) {
      const arr = childrenByParent.get(sym.parentName);
      if (arr) arr.push(sym);
      else childrenByParent.set(sym.parentName, [sym]);
    }
  }

  for (const sym of symbols) {
    if (sym.kind === 'class' || sym.kind === 'namespace') {
      const children = childrenByParent.get(sym.name) ?? [];
      const hasChildren = children.length > 0;
      rows.push({ kind: 'header', name: sym.name, symbolKind: sym.kind, line: sym.line, hasChildren });
      // If collapsed, skip children
      if (collapsed.has(sym.name)) continue;
      // Add children immediately after header
      for (const child of children) {
        rows.push({ kind: 'symbol', symbol: child, depth: 1 });
      }
    } else if (!sym.parentName) {
      // Top-level non-container symbol
      rows.push({ kind: 'symbol', symbol: sym, depth: 0 });
    }
    // Children with parentName are rendered under their header above
  }

  return rows;
}

/**
 * Write a string into a Line starting at column x, applying fg/bg/style.
 */
function _writeText(
  line: Line,
  x: number,
  text: string,
  fg: string,
  bg: string,
  opts: { bold?: boolean; dim?: boolean } = {},
): number {
  let col = x;
  for (const char of text) {
    if (col >= line.length) break;
    line[col] = createStyledCell(char, { fg, bg, bold: opts.bold ?? false, dim: opts.dim ?? false });
    col++;
  }
  return col;
}

/** Fill an entire line with a background color. */
function _fillBg(line: Line, bg: string): void {
  for (let i = 0; i < line.length; i++) {
    line[i].bg = bg;
  }
}

/** Render a container header row (class / namespace). */
function _renderHeader(
  line: Line,
  width: number,
  row: Extract<VisibleRow, { kind: 'header' }>,
  isSelected: boolean,
  bgColor: string,
  collapsed: Set<string>,
): void {
  if (bgColor) _fillBg(line, bgColor);

  let col = 1;

  // Collapse indicator
  const isCollapsed = collapsed.has(row.name);
  const chevron = row.hasChildren ? (isCollapsed ? '▶ ' : '▼ ') : '  ';
  col = _writeText(line, col, chevron, '245', bgColor);

  // Kind label
  const kindLabel = KIND_LABELS[row.symbolKind];
  col = _writeText(line, col, kindLabel, KIND_COLORS[row.symbolKind], bgColor, { bold: true });
  col = _writeText(line, col, ' ', '', bgColor);

  // Name
  col = _writeText(line, col, row.name, isSelected ? '255' : '252', bgColor, { bold: isSelected });

  // Line number (right-aligned)
  const lineNumStr = `:${row.line}`;
  const lineNumStart = width - lineNumStr.length - 1;
  if (lineNumStart > col) {
    _writeText(line, lineNumStart, lineNumStr, '240', bgColor);
  }
}

/** Render a regular symbol row. */
function _renderSymbol(
  line: Line,
  width: number,
  row: Extract<VisibleRow, { kind: 'symbol' }>,
  isSelected: boolean,
  bgColor: string,
): void {
  if (bgColor) _fillBg(line, bgColor);

  const { symbol, depth } = row;
  const indent = depth === 0 ? 1 : 3; // children indented by 3 (chevron + space)
  let col = indent;

  // Kind label
  const kindLabel = KIND_LABELS[symbol.kind];
  col = _writeText(line, col, kindLabel, KIND_COLORS[symbol.kind], bgColor);
  col = _writeText(line, col, ' ', '', bgColor);

  // Name
  col = _writeText(line, col, symbol.name, isSelected ? '255' : '251', bgColor, { bold: isSelected });

  // Line number (right-aligned)
  const lineNumStr = `:${symbol.line}`;
  const lineNumStart = width - lineNumStr.length - 1;
  if (lineNumStart > col) {
    _writeText(line, lineNumStart, lineNumStr, '240', bgColor);
  }
}
