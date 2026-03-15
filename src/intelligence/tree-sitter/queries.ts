/**
 * Tree-sitter query helpers for symbol extraction, outline generation,
 * and scope detection.
 *
 * Uses TreeCursor traversal rather than query string patterns so that
 * the logic works without requiring pre-built WASM grammar files for queries.
 */
import type { Tree, Language, Node } from 'web-tree-sitter';
import { logger } from '../../utils/logger.ts';

export interface SymbolInfo {
  name: string;
  kind:
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'variable'
    | 'constant'
    | 'enum'
    | 'method'
    | 'property'
    | 'namespace';
  line: number;
  endLine: number;
  column: number;
  exported: boolean;
  signature?: string;
  container?: string;
}

export interface OutlineEntry {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature: string;
  children: OutlineEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first line of a node's text (up to `{` or newline). */
function nodeSignature(node: Node): string {
  const text = node.text ?? '';
  const brace = text.indexOf('{');
  const newline = text.indexOf('\n');
  let end = text.length;
  if (brace !== -1) end = Math.min(end, brace);
  if (newline !== -1) end = Math.min(end, newline);
  return text.slice(0, end).trim();
}

/** Check if a node has an `export` keyword as a direct ancestor or sibling. */
function isExported(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  // export_statement wraps the declaration
  if (parent.type === 'export_statement') return true;
  // Some parsers put export as a child of export_statement
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (child && child.type === 'export') return true;
  }
  return false;
}

/** Get the identifier name child from a declaration node. */
function getNameFromNode(node: Node): string | null {
  // Try 'name' field first
  const nameChild = node.childForFieldName('name');
  if (nameChild) return nameChild.text;

  // Fall back: find first identifier child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'identifier' || child.type === 'type_identifier')) {
      return child.text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript extraction
// ---------------------------------------------------------------------------

const TS_SYMBOL_TYPES = new Set([
  'function_declaration',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'method_definition',
  'lexical_declaration', // const/let
  'variable_declaration', // var
]);

const TS_SCOPE_TYPES = new Set([
  'function_declaration',
  'arrow_function',
  'function_expression',
  'class_declaration',
  'class_expression',
  'method_definition',
]);

function extractTSSymbols(root: Node, container?: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function visitNode(node: Node, currentContainer?: string): void {
    if (!TS_SYMBOL_TYPES.has(node.type)) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) visitNode(child, currentContainer);
      }
      return;
    }

    const type = node.type;
    const exported = isExported(node);

    if (type === 'function_declaration') {
      const name = getNameFromNode(node);
      if (name) {
        symbols.push({
          name,
          kind: 'function',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          exported,
          signature: nodeSignature(node),
          container: currentContainer,
        });
      }
      // Recurse into function body for nested declarations
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === 'statement_block') {
          visitNode(child, name ?? currentContainer);
        }
      }
      return;
    }

    if (type === 'class_declaration') {
      const name = getNameFromNode(node);
      if (name) {
        symbols.push({
          name,
          kind: 'class',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          exported,
          signature: nodeSignature(node),
          container: currentContainer,
        });
        // Recurse into class body for methods
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'class_body') {
            visitNode(child, name);
          }
        }
      }
      return;
    }

    if (type === 'interface_declaration') {
      const name = getNameFromNode(node);
      if (name) {
        symbols.push({
          name,
          kind: 'interface',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          exported,
          signature: nodeSignature(node),
          container: currentContainer,
        });
      }
      return;
    }

    if (type === 'type_alias_declaration') {
      const name = getNameFromNode(node);
      if (name) {
        symbols.push({
          name,
          kind: 'type',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          exported,
          signature: nodeSignature(node),
          container: currentContainer,
        });
      }
      return;
    }

    if (type === 'enum_declaration') {
      const name = getNameFromNode(node);
      if (name) {
        symbols.push({
          name,
          kind: 'enum',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          exported,
          signature: nodeSignature(node),
          container: currentContainer,
        });
      }
      return;
    }

    if (type === 'method_definition') {
      const name = getNameFromNode(node);
      if (name) {
        symbols.push({
          name,
          kind: 'method',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          exported: false, // methods aren't individually exported
          signature: nodeSignature(node),
          container: currentContainer,
        });
      }
      return;
    }

    // const/let/var declarations — look for declarators at top level only
    if (type === 'lexical_declaration' || type === 'variable_declaration') {
      const isConst = node.child(0)?.text === 'const';
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === 'variable_declarator') {
          const name = getNameFromNode(child);
          if (name) {
            symbols.push({
              name,
              kind: isConst ? 'constant' : 'variable',
              line: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              column: node.startPosition.column,
              exported,
              signature: nodeSignature(node),
              container: currentContainer,
            });
          }
        }
      }
      return;
    }

    // Recurse for everything else
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visitNode(child, currentContainer);
    }
  }

  visitNode(root, container);
  return symbols;
}

// ---------------------------------------------------------------------------
// Python extraction
// ---------------------------------------------------------------------------

function extractPythonSymbols(root: Node): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function visitNode(node: Node, container?: string): void {
    if (node.type === 'function_definition') {
      const name = getNameFromNode(node);
      if (name) {
        symbols.push({
          name,
          kind: 'function',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          exported: !name.startsWith('_'),
          signature: nodeSignature(node),
          container,
        });
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'block') visitNode(child, name);
        }
      }
      return;
    }

    if (node.type === 'class_definition') {
      const name = getNameFromNode(node);
      if (name) {
        symbols.push({
          name,
          kind: 'class',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          exported: !name.startsWith('_'),
          signature: nodeSignature(node),
          container,
        });
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'block') visitNode(child, name);
        }
      }
      return;
    }

    // Module-level assignment
    if (node.type === 'assignment' && node.parent?.type === 'module') {
      const leftChild = node.child(0);
      if (leftChild && leftChild.type === 'identifier') {
        symbols.push({
          name: leftChild.text,
          kind: 'variable',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          exported: !leftChild.text.startsWith('_'),
          signature: nodeSignature(node),
          container,
        });
      }
      return;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visitNode(child, container);
    }
  }

  visitNode(root);
  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all symbols from a parsed tree.
 * Supports TypeScript, TSX, JavaScript, and Python.
 * Returns empty array with a warning for unsupported languages.
 */
export function extractSymbols(
  tree: Tree,
  _language: Language,
  langId: string,
): SymbolInfo[] {
  try {
    const root = tree.rootNode;
    if (langId === 'typescript' || langId === 'tsx' || langId === 'javascript') {
      return extractTSSymbols(root);
    }
    if (langId === 'python') {
      return extractPythonSymbols(root);
    }
    logger.debug('extractSymbols: unsupported language', { langId });
    return [];
  } catch (err) {
    logger.error('extractSymbols: failed', { langId, error: String(err) });
    return [];
  }
}

/**
 * Extract outline (structure without bodies) from a parsed tree.
 * Returns top-level entries with children for nested declarations.
 */
export function extractOutline(
  tree: Tree,
  language: Language,
  langId: string,
): OutlineEntry[] {
  try {
    const symbols = extractSymbols(tree, language, langId);
    // Build a flat list first, then nest by container
    const toplevel: OutlineEntry[] = [];
    const byName: Map<string, OutlineEntry> = new Map();

    for (const sym of symbols) {
      const entry: OutlineEntry = {
        name: sym.name,
        kind: sym.kind,
        line: sym.line,
        endLine: sym.endLine,
        signature: sym.signature ?? sym.name,
        children: [],
      };

      const qualifiedName = sym.container ? `${sym.container}.${sym.name}` : sym.name;
      if (sym.container && byName.has(sym.container)) {
        byName.get(sym.container)?.children.push(entry);
      } else {
        toplevel.push(entry);
      }
      byName.set(qualifiedName, entry);
    }

    return toplevel;
  } catch (err) {
    logger.error('extractOutline: failed', { langId, error: String(err) });
    return [];
  }
}

/**
 * Find the innermost function/class/block enclosing the given (1-based) line.
 * Returns null if no enclosing scope is found or if the language is unsupported.
 */
export function findEnclosingScope(
  tree: Tree,
  _language: Language,
  langId: string,
  line: number,
): { kind: string; name: string; startLine: number; endLine: number } | null {
  const scopeTypes =
    langId === 'typescript' || langId === 'tsx' || langId === 'javascript'
      ? TS_SCOPE_TYPES
      : langId === 'python'
        ? new Set(['function_definition', 'class_definition'])
        : null;

  if (!scopeTypes) {
    logger.debug('findEnclosingScope: unsupported language', { langId });
    return null;
  }

  const targetRow = line - 1; // tree-sitter rows are 0-based
  let best: { kind: string; name: string; startLine: number; endLine: number } | null = null;
  let bestSize = Infinity;

  function visitNode(node: Node): void {
    const start = node.startPosition.row;
    const end = node.endPosition.row;

    if (targetRow < start || targetRow > end) return;

    if (scopeTypes.has(node.type)) {
      const size = end - start;
      if (size < bestSize) {
        bestSize = size;
        const name = getNameFromNode(node) ?? '(anonymous)';
        best = {
          kind: node.type,
          name,
          startLine: start + 1,
          endLine: end + 1,
        };
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visitNode(child);
    }
  }

  visitNode(tree.rootNode);
  return best;
}
