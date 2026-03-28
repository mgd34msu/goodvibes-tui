/**
 * semantic-diff.ts — Functional change summary after file edits.
 *
 * Compares AST before/after an edit and extracts:
 *   - Added / removed / modified functions, methods, classes, etc.
 *   - Changed import specifiers
 *   - New / removed exports
 *
 * Returns a compact SemanticDiff that can be rendered alongside a regular diff.
 * Gracefully returns null when tree-sitter is unavailable or the language is
 * unsupported — callers should treat null as "no semantic info available".
 */

import { TreeSitterService } from '../intelligence/tree-sitter/service.ts';
import { extractSymbols } from '../intelligence/tree-sitter/queries.ts';
import type { SymbolInfo } from '../intelligence/tree-sitter/queries.ts';
import { detectLanguage } from '../intelligence/tree-sitter/languages.ts';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface SymbolChange {
  kind: ChangeKind;
  symbolKind: SymbolInfo['kind'];
  name: string;
  /** Present for 'modified' — the old signature. */
  oldSignature?: string;
  /** Present for 'added' or 'modified' — the new signature. */
  newSignature?: string;
}

export interface ImportChange {
  kind: ChangeKind;
  specifier: string; // the module path, e.g. './utils'
  /** Specific named imports that changed, if determinable. */
  names?: string[];
}

export interface SemanticDiff {
  symbols: SymbolChange[];
  imports: ImportChange[];
  /** Convenience: total number of changes across all categories. */
  totalChanges: number;
}

// ---------------------------------------------------------------------------
// Import extraction (regex-based — fast, no grammar needed)
// ---------------------------------------------------------------------------

interface ParsedImport {
  specifier: string;
  names: string[];
}

/**
 * Extract import specifiers and named imports from source text using a regex
 * scan. Covers `import ... from '...'` and `import('...')` dynamic imports.
 * Does not require tree-sitter.
 */
function extractImports(source: string): Map<string, ParsedImport> {
  const map = new Map<string, ParsedImport>();

  // Static imports: import { A, B } from './foo'
  //                 import Foo from './foo'
  //                 import * as Foo from './foo'
  //                 import './side-effect'
  const staticRe = /import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;

  while ((m = staticRe.exec(source)) !== null) {
    const clause = (m[1] ?? '').trim();
    const specifier = m[2]!;
    const names = parseNamedImports(clause);
    const existing = map.get(specifier);
    if (existing) {
      for (const n of names) existing.names.push(n);
    } else {
      map.set(specifier, { specifier, names });
    }
  }

  return map;
}

/** Parse `{ A, B as C }` or `* as Ns` or `Default` clauses into name strings. */
function parseNamedImports(clause: string): string[] {
  if (!clause) return [];
  // Namespace import: * as Foo
  if (clause.startsWith('*')) return [clause];
  // Named imports: { A, B as C }
  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch) {
    return braceMatch[1]!
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  // Default import: Foo
  return clause ? [clause] : [];
}

// ---------------------------------------------------------------------------
// Symbol comparison
// ---------------------------------------------------------------------------

function diffSymbols(
  before: SymbolInfo[],
  after: SymbolInfo[],
): SymbolChange[] {
  const changes: SymbolChange[] = [];

  // Key by qualified name (container.name or name)
  const key = (s: SymbolInfo): string =>
    s.container ? `${s.container}.${s.name}` : s.name;

  const beforeMap = new Map<string, SymbolInfo>();
  const afterMap = new Map<string, SymbolInfo>();

  for (const s of before) beforeMap.set(key(s), s);
  for (const s of after) afterMap.set(key(s), s);

  // Removed or modified
  for (const [k, bSym] of beforeMap) {
    const aSym = afterMap.get(k);
    if (!aSym) {
      changes.push({
        kind: 'removed',
        symbolKind: bSym.kind,
        name: k,
        oldSignature: bSym.signature,
      });
    } else if (
      bSym.signature !== aSym.signature ||
      bSym.exported !== aSym.exported
    ) {
      changes.push({
        kind: 'modified',
        symbolKind: aSym.kind,
        name: k,
        oldSignature: bSym.signature,
        newSignature: aSym.signature,
      });
    }
  }

  // Added
  for (const [k, aSym] of afterMap) {
    if (!beforeMap.has(k)) {
      changes.push({
        kind: 'added',
        symbolKind: aSym.kind,
        name: k,
        newSignature: aSym.signature,
      });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Import comparison
// ---------------------------------------------------------------------------

function diffImports(
  before: Map<string, ParsedImport>,
  after: Map<string, ParsedImport>,
): ImportChange[] {
  const changes: ImportChange[] = [];

  // Removed or modified
  for (const [spec, bImp] of before) {
    const aImp = after.get(spec);
    if (!aImp) {
      changes.push({ kind: 'removed', specifier: spec, names: bImp.names });
    } else {
      // Check if named imports changed
      const bSet = new Set(bImp.names);
      const aSet = new Set(aImp.names);
      const added = aImp.names.filter(n => !bSet.has(n));
      const removed = bImp.names.filter(n => !aSet.has(n));
      if (added.length > 0 || removed.length > 0) {
        const names: string[] = [
          ...added.map(n => `+${n}`),
          ...removed.map(n => `-${n}`),
        ];
        changes.push({ kind: 'modified', specifier: spec, names });
      }
    }
  }

  // Added
  for (const [spec, aImp] of after) {
    if (!before.has(spec)) {
      changes.push({ kind: 'added', specifier: spec, names: aImp.names });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare `beforeContent` and `afterContent` for the given `filePath` and
 * return a SemanticDiff describing functional changes.
 *
 * Returns null when:
 *   - The language is not supported by tree-sitter
 *   - Tree-sitter is not initialized
 *   - Parsing fails
 *
 * Import changes are always returned (regex-based, no grammar required).
 */
export async function computeSemanticDiff(
  filePath: string,
  beforeContent: string,
  afterContent: string,
): Promise<SemanticDiff | null> {
  // Import diff is always available (regex-based)
  const beforeImports = extractImports(beforeContent);
  const afterImports = extractImports(afterContent);
  const imports = diffImports(beforeImports, afterImports);

  const langId = detectLanguage(filePath);
  if (!langId) {
    // No language support — return import changes only if any
    if (imports.length === 0) return null;
    return { symbols: [], imports, totalChanges: imports.length };
  }

  const svc = TreeSitterService.getInstance();

  try {
    await svc.initialize();
  } catch {
    logger.debug('computeSemanticDiff: tree-sitter init failed', { filePath });
    if (imports.length === 0) return null;
    return { symbols: [], imports, totalChanges: imports.length };
  }

  // Use a temporary key so we don't pollute the service cache with diff content.
  // Include a nonce so concurrent calls for the same filePath don't collide.
  const nonce = Math.random().toString(36).slice(2);
  const beforeKey = `__semantic_diff_before__${nonce}_${filePath}`;
  const afterKey = `__semantic_diff_after__${nonce}_${filePath}`;

  try {
    const [beforeTree, afterTree] = await Promise.all([
      svc.parse(beforeKey, beforeContent, langId),
      svc.parse(afterKey, afterContent, langId),
    ]);

    if (!beforeTree || !afterTree) {
      if (imports.length === 0) return null;
      return { symbols: [], imports, totalChanges: imports.length };
    }

    // loadLanguage returns from cache since parse() already loaded it
    const lang = await svc.loadLanguage(langId);
    if (!lang) {
      if (imports.length === 0) return null;
      return { symbols: [], imports, totalChanges: imports.length };
    }

    const beforeSymbols = extractSymbols(beforeTree, lang, langId);
    const afterSymbols = extractSymbols(afterTree, lang, langId);
    const symbols = diffSymbols(beforeSymbols, afterSymbols);

    // Clean up temporary cache entries
    svc.invalidate(beforeKey);
    svc.invalidate(afterKey);

    const totalChanges = symbols.length + imports.length;
    if (totalChanges === 0) return null;

    return { symbols, imports, totalChanges };
  } catch (err) {
    logger.error('computeSemanticDiff: comparison failed', {
      filePath,
      error: String(err),
    });
    svc.invalidate(beforeKey);
    svc.invalidate(afterKey);
    if (imports.length === 0) return null;
    return { symbols: [], imports, totalChanges: imports.length };
  }
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

const KIND_ICON: Record<SymbolInfo['kind'], string> = {
  function:  'fn',
  method:    'method',
  class:     'class',
  interface: 'iface',
  type:      'type',
  variable:  'var',
  constant:  'const',
  enum:      'enum',
  property:  'prop',
  namespace: 'ns',
};

const CHANGE_GLYPH: Record<ChangeKind, string> = {
  added:    '+',
  removed:  '-',
  modified: '~',
};

/**
 * Render a SemanticDiff as an array of compact summary strings, one change
 * per line. Suitable for display in the diff panel status area or a tooltip.
 *
 * Format examples:
 *   +  fn  renderDiffView
 *   ~  method  DiffPanel.showDiff  (signature changed)
 *   -  class  OldWidget
 *   +  import  ./utils  { A, B }
 *   ~  import  ./types  (+NewType, -OldType)
 */
export function formatSemanticDiff(diff: SemanticDiff): string[] {
  const lines: string[] = [];

  // Symbol changes first
  for (const sc of diff.symbols) {
    const glyph = CHANGE_GLYPH[sc.kind];
    const icon = KIND_ICON[sc.symbolKind];
    let line = `${glyph}  ${icon}  ${sc.name}`;
    if (sc.kind === 'modified') {
      line += '  (signature changed)';
    }
    lines.push(line);
  }

  // Import changes
  for (const ic of diff.imports) {
    const glyph = CHANGE_GLYPH[ic.kind];
    let line = `${glyph}  import  ${ic.specifier}`;
    if (ic.names && ic.names.length > 0) {
      const nameList = ic.names.slice(0, 4).join(', ');
      const overflow = ic.names.length > 4 ? ` +${ic.names.length - 4} more` : '';
      line += `  { ${nameList}${overflow} }`;
    }
    lines.push(line);
  }

  return lines;
}

/**
 * Render a one-line summary suitable for a status bar.
 * Example: "3 changes: +fn renderX  ~method Foo.bar  -import ./old"
 */
export function formatSemanticDiffSummary(diff: SemanticDiff): string {
  if (diff.totalChanges === 0) return '';
  const parts = formatSemanticDiff(diff).slice(0, 3);
  const overflow = diff.totalChanges > 3 ? `  +${diff.totalChanges - 3} more` : '';
  return `${diff.totalChanges} semantic change${diff.totalChanges !== 1 ? 's' : ''}: ${parts.join('  ')}${overflow}`;
}
