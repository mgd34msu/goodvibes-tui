import { logger } from '../../utils/logger.ts';
import { CodeIntelligence } from '../../intelligence/facade.ts';
import type { SymbolInfo } from '../../intelligence/tree-sitter/queries.ts';

const SIGNATURE_PATTERNS: RegExp[] = [
  /^\s*export\s+(async\s+)?function\s+/,
  /^\s*export\s+(abstract\s+)?class\s+/,
  /^\s*export\s+interface\s+/,
  /^\s*export\s+type\s+\w+/,
  /^\s*export\s+enum\s+/,
  /^\s*export\s+const\s+/,
  /^\s*export\s+let\s+/,
  /^\s*export\s+var\s+/,
  /^\s*export\s+default\s+/,
  /^(async\s+)?function\s+\w+/,
  /^(abstract\s+)?class\s+\w+/,
];

const EXPORT_DECLARATION_RE =
  /^\s*export\s+(?:async\s+)?(?:abstract\s+)?(function|class|interface|type|enum|const|let|var)\s+(\w+)/;

const KIND_MAP: Record<string, string> = {
  function: 'function',
  class: 'class',
  interface: 'interface',
  type: 'type',
  enum: 'enum',
  const: 'constant',
  let: 'variable',
  var: 'variable',
};

const TS_KIND_MAP: Record<string, string> = {
  const: 'constant',
  let: 'variable',
  var: 'variable',
};

export function extractOutlineRegex(lines: string[], includeLineNumbers: boolean): string {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SIGNATURE_PATTERNS.some((p) => p.test(line))) {
      const lineNo = i + 1;
      let sig = line.trimEnd();
      const braceIdx = sig.indexOf('{');
      if (braceIdx !== -1) {
        sig = sig.slice(0, braceIdx).trimEnd();
      }
      result.push(includeLineNumbers ? `${String(lineNo).padStart(5)} | ${sig}` : sig);
    }
  }
  return result.join('\n');
}

export function extractSymbolsRegex(lines: string[], includeLineNumbers: boolean): string {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(EXPORT_DECLARATION_RE);
    if (m) {
      const kw = m[1];
      const name = m[2];
      const kind = KIND_MAP[kw] ?? 'export';
      const lineNo = i + 1;
      const entry = `${kind} ${name}`;
      result.push(includeLineNumbers ? `${String(lineNo).padStart(5)} | ${entry}` : entry);
    }
  }
  return result.join('\n');
}

function normalizeTsKind(kind: string): string {
  return TS_KIND_MAP[kind] ?? kind;
}

function formatOutlineEntries(
  entries: Array<{ line: number; signature: string }>,
  includeLineNumbers: boolean,
): string {
  return entries.map((e) => includeLineNumbers ? `${String(e.line).padStart(5)} | ${e.signature}` : e.signature).join('\n');
}

function formatSymbolEntries(symbols: SymbolInfo[], includeLineNumbers: boolean): string {
  return symbols
    .map((s) => {
      const kind = normalizeTsKind(s.kind);
      const entry = `${kind} ${s.name}`;
      return includeLineNumbers ? `${String(s.line).padStart(5)} | ${entry}` : entry;
    })
    .join('\n');
}

export async function extractOutline(
  filePath: string,
  rawContent: string,
  lines: string[],
  includeLineNumbers: boolean,
  codeIntelligence?: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>,
): Promise<string> {
  try {
    const ci = codeIntelligence ?? new CodeIntelligence();
    const entries = await ci.getOutline(filePath, rawContent);
    if (entries.length > 0) return formatOutlineEntries(entries, includeLineNumbers);
  } catch (err) {
    logger.debug('read tool: tree-sitter outline failed, using regex fallback', { filePath, error: String(err) });
  }
  return extractOutlineRegex(lines, includeLineNumbers);
}

export async function extractSymbols(
  filePath: string,
  rawContent: string,
  lines: string[],
  includeLineNumbers: boolean,
  codeIntelligence?: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>,
): Promise<string> {
  try {
    const ci = codeIntelligence ?? new CodeIntelligence();
    const symbols = await ci.getSymbols(filePath, rawContent);
    const exported = symbols.filter((s) => s.exported);
    if (exported.length > 0) return formatSymbolEntries(exported, includeLineNumbers);
  } catch (err) {
    logger.debug('read tool: tree-sitter symbols failed, using regex fallback', { filePath, error: String(err) });
  }
  return extractSymbolsRegex(lines, includeLineNumbers);
}

export async function extractAst(
  filePath: string,
  rawContent: string,
  lines: string[],
  includeLineNumbers: boolean,
  codeIntelligence?: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>,
): Promise<string> {
  try {
    const ci = codeIntelligence ?? new CodeIntelligence();
    const entries = await ci.getOutline(filePath, rawContent);
    if (entries.length > 0) return formatOutlineEntries(entries, includeLineNumbers);
  } catch (err) {
    logger.debug('read tool: tree-sitter ast failed, using outline fallback', { filePath, error: String(err) });
  }
  return (
    '# Note: tree-sitter outline unavailable for this file. Falling back to regex.\n'
    + extractOutlineRegex(lines, includeLineNumbers)
  );
}

export function formatContent(
  lines: string[],
  includeLineNumbers: boolean,
  range?: { start: number; end: number },
  maxPerItem?: number,
): string {
  let slice: string[];
  let startLine: number;

  if (range) {
    const start = Math.max(0, range.start - 1);
    const end = Math.min(lines.length, range.end);
    slice = lines.slice(start, end);
    startLine = range.start;
  } else {
    slice = lines;
    startLine = 1;
  }

  if (maxPerItem !== undefined) {
    slice = slice.slice(0, maxPerItem);
  }

  if (includeLineNumbers) {
    return slice.map((l, idx) => `${String(startLine + idx).padStart(5)} | ${l}`).join('\n');
  }
  return slice.join('\n');
}
