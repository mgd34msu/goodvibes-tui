import { BasePanel } from './base-panel.ts';
import type { Line } from '../types/grid.ts';
import {
  buildEmptyState,
  buildKeyboardHints,
  buildPanelLine,
  buildTreeRow,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
} from './polish.ts';
import { TreeSitterService } from '@pellux/goodvibes-sdk/platform/intelligence';
import type { Node, Tree, Language } from 'web-tree-sitter';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

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

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  selectedBg: '236',
});

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

/** Single-char type icon for the tree row (kept ASCII for column safety). */
const KIND_ICONS: Record<SymbolKind, string> = {
  function:  'ƒ',
  method:    'ƒ',
  class:     'C',
  namespace: 'N',
  interface: 'I',
  type:      'T',
  const:     'k',
};

// ── Tree-sitter symbol extraction ────────────────────────────────────────────

type LangId = 'typescript' | 'tsx' | 'javascript';

/** Map a file extension to the tree-sitter grammar id used to parse it. */
function detectLangId(filePath: string): LangId | null {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'typescript';
  if (ext === 'tsx') return 'tsx';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx') return 'javascript';
  return null;
}

// Tree-sitter queries capturing the declaration shapes the outline surfaces.
// Class members (methods, getters/setters, decorated members, and
// arrow-function class fields) are captured structurally rather than by
// indentation, so decorators and modifiers never throw off matching.
const TS_QUERY = `
(class_declaration name: (type_identifier) @class.name) @class.def
(abstract_class_declaration name: (type_identifier) @class.name) @class.def
(interface_declaration name: (type_identifier) @interface.name) @interface.def
(type_alias_declaration name: (type_identifier) @type.name) @type.def
(internal_module name: (identifier) @namespace.name) @namespace.def
(function_declaration name: (identifier) @function.name) @function.def
(method_definition name: (property_identifier) @method.name) @method.def
(public_field_definition
  name: (property_identifier) @field.name
  value: (arrow_function)) @field.def
(lexical_declaration
  (variable_declarator name: (identifier) @const.name) @const.declarator) @const.def
`;

const JS_QUERY = `
(class_declaration name: (identifier) @class.name) @class.def
(function_declaration name: (identifier) @function.name) @function.def
(method_definition name: (property_identifier) @method.name) @method.def
(field_definition
  property: (property_identifier) @field.name
  value: (arrow_function)) @field.def
(lexical_declaration
  (variable_declarator name: (identifier) @const.name) @const.declarator) @const.def
`;

const QUERY_BY_LANG: Record<LangId, string> = {
  typescript: TS_QUERY,
  tsx: TS_QUERY,
  javascript: JS_QUERY,
};

const CLASS_NODE_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class_expression']);

/** True when `node` sits directly at module scope (optionally wrapped in `export`). */
function isTopLevelDeclaration(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (parent.type === 'program') return true;
  if (parent.type === 'export_statement') return parent.parent?.type === 'program';
  return false;
}

/**
 * Walk up from a class member to its nearest enclosing class. Returns the
 * class name only when that class is itself a top-level declaration — this
 * keeps the outline to a class + its direct members (no deep nesting), the
 * same depth the previous regex-based parser supported.
 */
function findEnclosingClassName(node: Node): string | null {
  let cursor: Node | null = node.parent;
  while (cursor) {
    if (CLASS_NODE_TYPES.has(cursor.type)) {
      if (!isTopLevelDeclaration(cursor)) return null;
      const nameNode = cursor.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    cursor = cursor.parent;
  }
  return null;
}

/**
 * Extract a flat, line-ordered list of symbols from a parsed tree using a
 * tree-sitter query over the real AST (no regex heuristics). Class members
 * (methods, getters/setters, decorated members, arrow-function fields) carry
 * `parentName` so the renderer can group them under their class header.
 */
function extractSymbolsFromTree(tree: Tree, language: Language, langId: LangId, service: TreeSitterService): SymbolEntry[] {
  const query = QUERY_BY_LANG[langId];
  const matches = service.query(tree, language, query);
  const result: SymbolEntry[] = [];

  for (const match of matches) {
    const captures = new Map<string, Node>(match.captures.map((c) => [c.name, c.node]));

    const classDef = captures.get('class.def');
    if (classDef) {
      const nameNode = captures.get('class.name');
      if (nameNode && isTopLevelDeclaration(classDef)) {
        result.push({ kind: 'class', name: nameNode.text, line: classDef.startPosition.row + 1 });
      }
      continue;
    }

    const interfaceDef = captures.get('interface.def');
    if (interfaceDef) {
      const nameNode = captures.get('interface.name');
      if (nameNode && isTopLevelDeclaration(interfaceDef)) {
        result.push({ kind: 'interface', name: nameNode.text, line: interfaceDef.startPosition.row + 1 });
      }
      continue;
    }

    const typeDef = captures.get('type.def');
    if (typeDef) {
      const nameNode = captures.get('type.name');
      if (nameNode && isTopLevelDeclaration(typeDef)) {
        result.push({ kind: 'type', name: nameNode.text, line: typeDef.startPosition.row + 1 });
      }
      continue;
    }

    const namespaceDef = captures.get('namespace.def');
    if (namespaceDef) {
      const nameNode = captures.get('namespace.name');
      if (nameNode && isTopLevelDeclaration(namespaceDef)) {
        result.push({ kind: 'namespace', name: nameNode.text, line: namespaceDef.startPosition.row + 1 });
      }
      continue;
    }

    const functionDef = captures.get('function.def');
    if (functionDef) {
      const nameNode = captures.get('function.name');
      if (nameNode && isTopLevelDeclaration(functionDef)) {
        result.push({ kind: 'function', name: nameNode.text, line: functionDef.startPosition.row + 1 });
      }
      continue;
    }

    // Methods, getters/setters, and constructors — all `method_definition`
    // regardless of decorators (decorators are preceding siblings, not
    // wrappers, so they never block the match).
    const methodDef = captures.get('method.def');
    if (methodDef) {
      const nameNode = captures.get('method.name');
      const parentName = findEnclosingClassName(methodDef);
      if (nameNode && parentName) {
        result.push({ kind: 'method', name: nameNode.text, line: methodDef.startPosition.row + 1, parentName });
      }
      continue;
    }

    // Arrow-function class fields (`onClick = () => {...}`), decorated or not.
    const fieldDef = captures.get('field.def');
    if (fieldDef) {
      const nameNode = captures.get('field.name');
      const parentName = findEnclosingClassName(fieldDef);
      if (nameNode && parentName) {
        result.push({ kind: 'method', name: nameNode.text, line: fieldDef.startPosition.row + 1, parentName });
      }
      continue;
    }

    const constDef = captures.get('const.def');
    if (constDef) {
      const nameNode = captures.get('const.name');
      const declarator = captures.get('const.declarator');
      if (nameNode && isTopLevelDeclaration(constDef)) {
        const valueNode = declarator?.childForFieldName('value') ?? null;
        const isFunctionValued = valueNode?.type === 'arrow_function' || valueNode?.type === 'function_expression';
        result.push({
          kind: isFunctionValued ? 'function' : 'const',
          name: nameNode.text,
          line: constDef.startPosition.row + 1,
        });
      }
      continue;
    }
  }

  result.sort((a, b) => a.line - b.line);
  return result;
}

// ── Panel ────────────────────────────────────────────────────────────────────

/**
 * SymbolOutlinePanel — renders a hierarchical symbol outline of the current
 * file. Symbols are parsed from the real AST via a tree-sitter query (the
 * same parser infrastructure syntax-highlighter.ts uses), not regex
 * heuristics — so class fields assigned arrow functions, getters/setters,
 * and decorated members all appear correctly.
 */
export class SymbolOutlinePanel extends BasePanel {
  /** Flat list of parsed symbols (methods nested after their parent class). */
  private symbols: SymbolEntry[] = [];

  /** Index of the currently highlighted row in the visible flat list. */
  private selectedIndex: number = 0;

  /**
   * The row under the cursor. This panel owns its own selection state
   * (`selectedIndex` navigates the filtered `_visibleRows()` flat list), so
   * every selected-row read routes through this one accessor — indexing the
   * `_visibleRows()` list by the cursor directly is banned by the
   * no-raw-selectedindex-read architecture rule.
   */
  private selectedRow(): VisibleRow | undefined {
    return this._visibleRows().at(this.selectedIndex);
  }

  /** Set of container names (class/namespace) that are collapsed. */
  private collapsed: Set<string> = new Set();

  /** Scroll offset (top-visible row index in the flat rendered list). */
  private scrollOffset: number = 0;

  /** Path of the file currently loaded. */
  private currentPath: string = '';

  /** Shared tree-sitter service for this panel instance (mirrors syntax-highlighter.ts). */
  private readonly treeSitter = new TreeSitterService();

  /** Bumped on every loadFile() call so a superseded async parse is discarded. */
  private parseGeneration: number = 0;

  constructor() {
    super('symbols', 'Symbols', 'S', 'development');
    this.treeSitter.initialize().catch((err: unknown) => {
      logger.warn('SymbolOutlinePanel: tree-sitter init failed', { error: summarizeError(err) });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load and parse symbols from the given file source text via tree-sitter.
   * Call this when the active file changes in the file-preview panel, and
   * again whenever the preview reloads the same file so the outline re-syncs
   * with on-disk edits.
   */
  loadFile(path: string, source: string): void {
    this.currentPath = path;
    this.symbols = [];
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.collapsed.clear();
    this.markDirty();

    const generation = ++this.parseGeneration;
    const langId = detectLangId(path);
    if (!langId) return; // unsupported language — honest "no symbols" empty state

    void this._parseAndSync(path, source, langId, generation);
  }

  /**
   * Returns the { path, line } for the currently selected symbol so the
   * caller can jump to it in the file-preview panel.
   */
  getSelectedLocation(): { path: string; line: number } | null {
    const row = this.selectedRow();
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
      // Only consume Enter when there is a real symbol to jump to — otherwise
      // let the key fall through instead of swallowing it for nothing.
      return this.getSelectedLocation() !== null;
    }

    if (key === 'space' || key === 'right' || key === 'left') {
      const row = this.selectedRow();
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

    if (this.symbols.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Symbols',
        intro: 'Outline the current file into navigable symbols and lightweight parent/child structure.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              this.currentPath ? ' No symbols found' : ' No file loaded',
              this.currentPath
                ? 'The current file did not produce outline entries from the tree-sitter parse.'
                : 'Load a file in the preview panel to populate its outline here.',
              this.currentPath
                ? []
                : [{ command: '/panel open explorer', summary: 'pick a file in the explorer, then Enter to preview and outline it' }],
              C,
            ),
          },
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const visible = this._visibleRows();
    const outlineSection = resolveScrollablePanelSection(width, height, {
      intro: this.currentPath ? this.currentPath : 'Outline the current file into navigable symbols and lightweight parent/child structure.',
      footerLines: [
        buildKeyboardHints(width, [{ keys: '↑/↓', label: 'navigate' }, { keys: 'Space/←/→', label: 'collapse' }, { keys: 'Enter', label: 'jump to source →' }], DEFAULT_PANEL_PALETTE),
      ],
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [
        {
          title: 'Summary',
          lines: [
            buildPanelLine(width, [
              [' Symbols ', DEFAULT_PANEL_PALETTE.label],
              [String(this.symbols.length), DEFAULT_PANEL_PALETTE.value],
              ['   Collapsed ', DEFAULT_PANEL_PALETTE.label],
              [String(this.collapsed.size), this.collapsed.size > 0 ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
            ]),
          ],
        },
      ],
      section: {
        title: 'Outline',
        scrollableLines: visible.map((row, i) => {
          const isSelected = i === this.selectedIndex;
          const bgColor = isSelected ? '236' : '';
          return row.kind === 'header'
            ? _renderHeader(width, row, isSelected, bgColor, this.collapsed)
            : _renderSymbol(width, row, isSelected, bgColor);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        minRows: 8,
      },
      afterSections: [
        {
          title: 'Selected',
          lines: (() => {
            const selected = this.selectedRow();
            return selected
              ? [
                  buildPanelLine(width, [
                    [' Kind ', DEFAULT_PANEL_PALETTE.label],
                    [selected.kind === 'header' ? selected.symbolKind : selected.symbol.kind, DEFAULT_PANEL_PALETTE.info],
                    ['   Line ', DEFAULT_PANEL_PALETTE.label],
                    [String(selected.kind === 'header' ? selected.line : selected.symbol.line), DEFAULT_PANEL_PALETTE.value],
                  ]),
                  buildPanelLine(width, [
                    [' Name ', DEFAULT_PANEL_PALETTE.label],
                    [selected.kind === 'header' ? selected.name : selected.symbol.name, DEFAULT_PANEL_PALETTE.value],
                  ]),
                ]
              : [];
          })(),
        },
      ],
    });
    this.scrollOffset = outlineSection.scrollOffset;

    const selected = this.selectedRow();
    return buildPanelWorkspace(width, height, {
      title: ' Symbols',
      intro: this.currentPath ? this.currentPath : 'Outline the current file into navigable symbols and lightweight parent/child structure.',
      sections: [
        {
          title: 'Summary',
          lines: [
            buildPanelLine(width, [
              [' Symbols ', DEFAULT_PANEL_PALETTE.label],
              [String(this.symbols.length), DEFAULT_PANEL_PALETTE.value],
              ['   Collapsed ', DEFAULT_PANEL_PALETTE.label],
              [String(this.collapsed.size), this.collapsed.size > 0 ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
            ]),
          ],
        },
        outlineSection.section,
        {
          title: 'Selected',
          lines: selected
            ? [
                buildPanelLine(width, [
                  [' Kind ', DEFAULT_PANEL_PALETTE.label],
                  [selected.kind === 'header' ? selected.symbolKind : selected.symbol.kind, DEFAULT_PANEL_PALETTE.info],
                  ['   Line ', DEFAULT_PANEL_PALETTE.label],
                  [String(selected.kind === 'header' ? selected.line : selected.symbol.line), DEFAULT_PANEL_PALETTE.value],
                ]),
                buildPanelLine(width, [
                  [' Name ', DEFAULT_PANEL_PALETTE.label],
                  [selected.kind === 'header' ? selected.name : selected.symbol.name, DEFAULT_PANEL_PALETTE.value],
                ]),
              ]
            : [],
        },
      ],
      footerLines: [
        buildKeyboardHints(width, [{ keys: '↑/↓', label: 'navigate' }, { keys: 'Space/←/→', label: 'collapse' }, { keys: 'Enter', label: 'jump to source →' }], DEFAULT_PANEL_PALETTE),
      ],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _parseAndSync(path: string, source: string, langId: LangId, generation: number): Promise<void> {
    try {
      await this.treeSitter.initialize();
      const language = await this.treeSitter.loadLanguage(langId);
      if (!language) return;
      const tree = await this.treeSitter.parse(path, source, langId);
      if (!tree) return;
      // A newer loadFile() call superseded this one — discard the stale result.
      if (generation !== this.parseGeneration) return;
      this.symbols = extractSymbolsFromTree(tree, language, langId, this.treeSitter);
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.markDirty();
    } catch (err) {
      logger.warn('SymbolOutlinePanel: tree-sitter parse failed', { path, error: summarizeError(err) });
    }
  }

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

/** Render a container header row (class / namespace) via the shared tree row. */
function _renderHeader(
  width: number,
  row: Extract<VisibleRow, { kind: 'header' }>,
  isSelected: boolean,
  bgColor: string,
  collapsed: Set<string>,
): Line {
  const isCollapsed = collapsed.has(row.name);
  return buildTreeRow(width, {
    depth: 0,
    label: row.name,
    icon: KIND_ICONS[row.symbolKind],
    expandable: row.hasChildren,
    expanded: !isCollapsed,
    labelColor: KIND_COLORS[row.symbolKind],
    metadata: [{ text: `:${row.line}`, fg: DEFAULT_PANEL_PALETTE.dim }],
  }, C, { selected: isSelected, selectedBg: bgColor || C.selectedBg });
}

/** Render a regular symbol row via the shared tree row. */
function _renderSymbol(
  width: number,
  row: Extract<VisibleRow, { kind: 'symbol' }>,
  isSelected: boolean,
  bgColor: string,
): Line {
  const { symbol, depth } = row;
  return buildTreeRow(width, {
    depth,
    label: symbol.name,
    icon: KIND_ICONS[symbol.kind],
    labelColor: KIND_COLORS[symbol.kind],
    metadata: [{ text: `:${symbol.line}`, fg: DEFAULT_PANEL_PALETTE.dim }],
  }, C, { selected: isSelected, selectedBg: bgColor || C.selectedBg });
}
