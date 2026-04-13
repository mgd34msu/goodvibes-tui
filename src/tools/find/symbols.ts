import { CodeIntelligence } from '../../intelligence/index.ts';
import type { OutputOptions, SymbolsQuery, SymbolKind } from './shared.ts';
import {
  collectTextFiles,
  groupByKey,
  loadFileLines,
  matchesSymbolQuery,
  makeCountResult,
  makeFilesResult,
  toSymbolKind,
  validateSearchPath,
  readTextFile,
} from './shared.ts';

interface SymbolResult {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  exported: boolean;
}

export async function executeSymbolsQuery(
  query: SymbolsQuery,
  output: OutputOptions,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const validatedPath = validateSearchPath(query.path, projectRoot);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;
  const maxResults = output.max_results ?? 100;
  const kindFilter = query.kinds ? new Set(query.kinds) : null;

  const linePatterns: Array<{
    kind: SymbolKind;
    regex: RegExp;
    exported: boolean;
  }> = [
    { kind: 'function', regex: /^export\s+(?:async\s+)?function\s+(\w+)/, exported: true },
    { kind: 'class', regex: /^export\s+(?:abstract\s+)?class\s+(\w+)/, exported: true },
    { kind: 'interface', regex: /^export\s+interface\s+(\w+)/, exported: true },
    { kind: 'type', regex: /^export\s+type\s+(\w+)\s*[=<{]/, exported: true },
    { kind: 'enum', regex: /^export\s+enum\s+(\w+)/, exported: true },
    { kind: 'constant', regex: /^export\s+const\s+(\w+)/, exported: true },
    { kind: 'variable', regex: /^export\s+(?:let|var)\s+(\w+)/, exported: true },
    { kind: 'function', regex: /^(?:async\s+)?function\s+(\w+)/, exported: false },
    { kind: 'class', regex: /^(?:abstract\s+)?class\s+(\w+)/, exported: false },
  ];

  const activePatterns = kindFilter ? linePatterns.filter((p) => kindFilter.has(p.kind)) : linePatterns;
  const files = await collectTextFiles(basePath);
  const symbols: SymbolResult[] = [];

  let queryRegex: RegExp | null = null;
  if (query.query) {
    try {
      queryRegex = new RegExp(query.query, 'i');
    } catch {
      return { error: `Invalid symbol query pattern: ${query.query}` };
    }
  }

  const ci = new CodeIntelligence({});

  for (const file of files) {
    if (symbols.length >= maxResults) break;

    const content = await readTextFile(file);
    if (content === null) continue;

    let usedTreeSitter = false;
    try {
      const tsSymbols = await ci.getSymbols(file, content);
      if (tsSymbols.length > 0) {
        usedTreeSitter = true;
        for (const sym of tsSymbols) {
          if (symbols.length >= maxResults) break;
          const kind = toSymbolKind(sym.kind);
          if (kindFilter && !kindFilter.has(kind)) continue;
          if (query.exported_only && !query.include_private && !sym.exported) continue;
          if (!matchesSymbolQuery(sym.name, queryRegex)) continue;
          symbols.push({ name: sym.name, kind, file, line: sym.line, exported: sym.exported });
        }
      }
    } catch {
      // fall back to regex
    }

    if (usedTreeSitter) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (symbols.length >= maxResults) break;
      const line = lines[i].trimStart();
      for (const { kind, regex, exported } of activePatterns) {
        if (query.exported_only && !query.include_private && !exported) continue;
        const match = line.match(regex);
        if (match) {
          const name = match[1];
          if (!name) continue;
          if (!matchesSymbolQuery(name, queryRegex)) continue;
          symbols.push({ name, kind, file, line: i + 1, exported });
          break;
        }
      }
    }
  }

  if (output.format === 'count_only') {
    return makeCountResult(symbols.length);
  }
  if (output.format === 'files_only') {
    const uniqueFiles = [...new Set(symbols.map((s) => s.file))];
    return makeFilesResult(uniqueFiles, symbols.length);
  }

  if (output.format === 'signatures' || output.format === 'full') {
    const fileContents = new Map<string, string[]>();
    const enriched: Array<Record<string, unknown>> = [];
    for (const sym of symbols) {
      let fileLines = fileContents.get(sym.file);
      if (!fileLines) {
        fileLines = await loadFileLines(sym.file);
        fileContents.set(sym.file, fileLines);
      }
      const entry: Record<string, unknown> = {
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        line: sym.line,
        exported: sym.exported,
      };
      const sigLines: string[] = [];
      for (let i = sym.line - 1; i < Math.min(sym.line + 10, fileLines.length); i++) {
        const l = fileLines[i];
        sigLines.push(l.trimEnd());
        if (/[{;]/.test(l)) break;
      }
      entry.signature = sigLines.join('\n');
      if (output.format === 'full') {
        let jsdoc = '';
        let j = sym.line - 2;
        if (j >= 0 && fileLines[j]?.trimStart().startsWith('*/')) {
          const docLines: string[] = [];
          while (j >= 0 && !fileLines[j].trimStart().startsWith('/**')) {
            docLines.unshift(fileLines[j]);
            j--;
          }
          if (j >= 0) docLines.unshift(fileLines[j]);
          jsdoc = docLines.join('\n');
        }
        if (jsdoc) entry.jsdoc = jsdoc;
        let container = '';
        for (let k = sym.line - 2; k >= Math.max(0, sym.line - 50); k--) {
          const cl = fileLines[k]?.trimStart() ?? '';
          if (/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/.test(cl)) {
            const m = cl.match(/class\s+(\w+)/);
            if (m) { container = m[1]; break; }
          }
          if (/^(?:export\s+)?(?:namespace|module)\s+(\w+)/.test(cl)) {
            const m = cl.match(/(?:namespace|module)\s+(\w+)/);
            if (m) { container = m[1]; break; }
          }
        }
        if (container) entry.container = container;
      }
      enriched.push(entry);
    }
    const groupBy = query.group_by ?? 'none';
    const grouped = groupByKey(enriched as Array<{ file: string; kind: string }>, groupBy);
    if (grouped) {
      return { symbols: grouped, count: symbols.length };
    }
    return { symbols: enriched, count: symbols.length };
  }

  const groupBy = query.group_by ?? 'none';
  const grouped = groupByKey(symbols, groupBy);
  if (grouped) {
    return { symbols: grouped, count: symbols.length };
  }

  return { symbols, count: symbols.length };
}
