import { extname } from 'node:path';
import * as astGrep from '@ast-grep/napi';
import type { OutputOptions, StructuralQuery } from './shared.ts';
import { collectFilesForSearch, makeCountResult, makeFilesResult, makeLocationsResult, readTextFile, validateSearchPath } from './shared.ts';

function getAstGrepLang(
  filePath: string,
  override?: StructuralQuery['lang'],
): { parse: (src: string) => { root(): { findAll(pat: string): Array<{ text(): string; range(): { start: { line: number } } }> } } } | null {
  const lang = override ?? extname(filePath).slice(1).toLowerCase();
  switch (lang) {
    case 'ts': return astGrep.ts;
    case 'tsx': return astGrep.tsx;
    case 'js':
    case 'mjs':
    case 'cjs': return astGrep.js;
    case 'jsx': return astGrep.jsx;
    case 'css': return astGrep.css;
    case 'html': return astGrep.html;
    default: return null;
  }
}

export async function executeStructuralQuery(
  query: StructuralQuery,
  output: OutputOptions,
): Promise<Record<string, unknown>> {
  const projectRoot = process.cwd();
  const validatedPath = validateSearchPath(query.path, projectRoot);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;

  if (!query.pattern) {
    return { error: 'structural mode requires pattern' };
  }

  const format = output.format ?? 'matches';
  const maxPerFile = output.max_per_item ?? 10;
  const maxTotal = output.max_total_matches ?? output.max_results ?? 100;
  const files = await collectFilesForSearch(basePath, query.glob);

  interface StructuralMatch { file: string; line: number; text: string }
  const allMatches: StructuralMatch[] = [];
  const matchedFiles = new Set<string>();
  let totalMatches = 0;

  outer: for (const file of files) {
    if (totalMatches >= maxTotal) break;

    const parser = getAstGrepLang(file, query.lang);
    if (!parser) continue;

    const content = await readTextFile(file);
    if (content === null) continue;

    let root: ReturnType<typeof parser.parse>;
    try {
      root = parser.parse(content);
    } catch {
      continue;
    }

    let matches: ReturnType<ReturnType<typeof parser.parse>['root']>['findAll'] extends (p: string) => infer R ? R : never;
    try {
      matches = root.root().findAll(query.pattern);
    } catch {
      continue;
    }

    let fileMatchCount = 0;
    for (const match of matches) {
      if (fileMatchCount >= maxPerFile) break;
      if (totalMatches >= maxTotal) break outer;
      const text = match.text();
      const line = match.range().start.line + 1;
      allMatches.push({ file, line, text });
      matchedFiles.add(file);
      fileMatchCount++;
      totalMatches++;
    }
  }

  if (format === 'count_only') {
    return makeCountResult(totalMatches, undefined, matchedFiles.size);
  }
  if (format === 'files_only') {
    return makeFilesResult(Array.from(matchedFiles), matchedFiles.size);
  }
  if (format === 'locations') {
    const locations = allMatches.map((m) => ({ file: m.file, line: m.line }));
    return makeLocationsResult(locations, totalMatches);
  }
  return { matches: allMatches, count: totalMatches };
}
