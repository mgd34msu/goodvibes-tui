import { stat as statAsync } from 'node:fs/promises';
import type { ContentQuery, OutputOptions, ContentMatch } from './shared.ts';
import {
  collectFilesForSearch,
  isBinary,
  makeCountResult,
  makeFilesResult,
  makeLocationsResult,
  readTextFile,
  FindRuntimeService,
  validateSearchPath,
} from './shared.ts';

interface CacheKey {
  pattern: string;
  glob: string;
  path: string;
  flags: string;
}

async function executeContentQuery(
  query: ContentQuery,
  output: OutputOptions,
  runtime: FindRuntimeService,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const validatedPath = validateSearchPath(query.path, projectRoot);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;
  const format = output.format ?? 'matches';
  const maxPerFile = output.max_per_item ?? 10;
  const maxTotal = output.max_total_matches ?? output.max_results ?? 100;
  const ctxBefore = output.context_before ?? 0;
  const ctxAfter = output.context_after ?? 0;

  if (format === 'signatures' || format === 'full') {
    return { error: `Output format '${format}' is only valid for symbols mode` };
  }

  let rawPattern: string;
  if (query.pattern_base64) {
    rawPattern = Buffer.from(query.pattern_base64, 'base64').toString('utf8');
  } else if (query.pattern) {
    rawPattern = query.pattern;
  } else {
    return { error: 'content mode requires pattern or pattern_base64' };
  }

  if (query.whole_word) {
    rawPattern = `\\b(?:${rawPattern})\\b`;
  }

  const flags = [
    query.case_sensitive === false ? 'i' : '',
    query.multiline ? 'm' : '',
    'g',
  ].join('');

  let regex: RegExp;
  try {
    regex = new RegExp(rawPattern, flags);
  } catch (e) {
    return { error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` };
  }

  const files = await collectFilesForSearch(basePath, query.glob);

  if (query.negate) {
    const nonMatchingFiles: string[] = [];
    for (const file of files) {
      const content = await readTextFile(file);
      if (content === null) continue;
      regex.lastIndex = 0;
      if (!regex.test(content)) {
        nonMatchingFiles.push(file);
        if (nonMatchingFiles.length >= maxTotal) break;
      }
    }
    if (format === 'count_only') return makeCountResult(nonMatchingFiles.length);
    return makeFilesResult(nonMatchingFiles, nonMatchingFiles.length);
  }

  const cacheKey: CacheKey = { pattern: rawPattern, glob: query.glob ?? '', path: basePath, flags };
  const cachedEntry = runtime.searchCacheGet(cacheKey);
  const cacheValid = cachedEntry ? await runtime.searchCacheIsValid(cachedEntry) : false;

  let matchedFiles: Map<string, { content: string; matches: ContentMatch[] }>;
  let totalMatches: number;

  if (cacheValid && cachedEntry) {
    matchedFiles = cachedEntry.matchedFiles;
    totalMatches = cachedEntry.totalMatches;
  } else {
    matchedFiles = new Map<string, { content: string; matches: ContentMatch[] }>();
    totalMatches = 0;

    outer: for (const file of files) {
      if (totalMatches >= maxTotal) break;

      const content = await readTextFile(file);
      if (content === null) continue;
      if (await isBinary(file)) continue;

      const lines = content.split('\n');
      const fileMatches: ContentMatch[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (fileMatches.length >= maxPerFile) break;
        if (totalMatches >= maxTotal) break outer;

        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          const match: ContentMatch = { file, line: i + 1, text: lines[i] };
          if (format === 'context') {
            match.context_before = lines.slice(Math.max(0, i - ctxBefore), i);
            match.context_after = lines.slice(i + 1, i + 1 + ctxAfter);
          }
          fileMatches.push(match);
          totalMatches++;
        }
      }

      if (fileMatches.length > 0) {
        matchedFiles.set(file, { content, matches: fileMatches });
      }
    }
  }

  if (!query.ranked && !query.preview_replace && !query.relationships) {
    const fileMtimesForCache = new Map<string, number>();
    await Promise.all(
      Array.from(matchedFiles.keys()).map(async (f) => {
        try {
          const s = await statAsync(f);
          fileMtimesForCache.set(f, s.mtimeMs);
        } catch {
          fileMtimesForCache.set(f, 0);
        }
      }),
    );
    runtime.searchCacheSet(cacheKey, {
      files,
      matchedFiles: new Map(matchedFiles),
      totalMatches,
      fileMtimes: fileMtimesForCache,
    });
  }

  if (query.ranked) {
    const fileMtimes = new Map<string, number>();
    await Promise.all(
      Array.from(matchedFiles.keys()).map(async (f) => {
        try {
          const s = await statAsync(f);
          fileMtimes.set(f, s.mtimeMs);
        } catch {
          fileMtimes.set(f, 0);
        }
      }),
    );
    const mostRecentMtime = Math.max(...Array.from(fileMtimes.values()), 0);
    const exactPattern = query.pattern_base64
      ? Buffer.from(query.pattern_base64, 'base64').toString('utf8')
      : (query.pattern ?? '');

    const scoredEntries: Array<{ file: string; matches: ContentMatch[]; score: number }> = [];
    for (const [file, { matches }] of matchedFiles) {
      let fileScore = 0;
      const mtime = fileMtimes.get(file) ?? 0;
      if (mostRecentMtime > 0 && mtime >= mostRecentMtime * 0.95) fileScore += 3;
      for (const m of matches) {
        if (m.text.includes(exactPattern)) fileScore += 10;
        if (/^export\s/.test(m.text.trimStart())) fileScore += 5;
      }
      scoredEntries.push({ file, matches, score: fileScore });
    }
    scoredEntries.sort((a, b) => b.score - a.score);
    const sortedEntries = scoredEntries.map(({ file, matches }) => {
      const original = matchedFiles.get(file);
      return [file, { content: original?.content ?? '', matches }] as const;
    });
    matchedFiles = new Map(sortedEntries);
  }

  const expandTo = output.expand_to;
  if (expandTo === 'function' || expandTo === 'class') {
    const ci = new (await import('../../intelligence/index.ts')).CodeIntelligence({});
    for (const [file, { content, matches }] of matchedFiles) {
      for (const m of matches) {
        try {
          const scope = await ci.getEnclosingScope(file, content, m.line);
          if (scope) {
            m.startLine = scope.startLine;
            m.endLine = scope.endLine;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  if (format === 'count_only') {
    return makeCountResult(totalMatches, undefined, matchedFiles.size);
  }
  if (format === 'files_only') {
    return makeFilesResult(Array.from(matchedFiles.keys()), matchedFiles.size);
  }
  if (format === 'locations') {
    const locations: Array<{ file: string; line: number }> = [];
    for (const [file, { matches }] of matchedFiles) {
      for (const m of matches) {
        locations.push({ file, line: m.line });
      }
    }
    return makeLocationsResult(locations, totalMatches);
  }

  if (format === 'matches' || format === 'context') {
    const results: Array<{
      file: string;
      line: number;
      text: string;
      replaced?: string;
      startLine?: number;
      endLine?: number;
      context_before?: string[];
      context_after?: string[];
    }> = [];
    for (const [, { matches }] of matchedFiles) {
      for (const m of matches) {
        let displayText = m.text;
        let replacedText: string | undefined;
        if (query.preview_replace !== undefined) {
          try {
            const replaceRegex = new RegExp(rawPattern, flags);
            replacedText = m.text.replace(replaceRegex, query.preview_replace);
          } catch {
            // ignore
          }
        }
        if (output.max_line_length && displayText.length > output.max_line_length) {
          displayText = displayText.slice(0, output.max_line_length) + '...';
        }
        if (replacedText !== undefined && output.max_line_length && replacedText.length > output.max_line_length) {
          replacedText = replacedText.slice(0, output.max_line_length) + '...';
        }
        const entry: (typeof results)[number] = { file: m.file, line: m.line, text: displayText };
        if (replacedText !== undefined) entry.replaced = replacedText;
        if (m.startLine !== undefined) entry.startLine = m.startLine;
        if (m.endLine !== undefined) entry.endLine = m.endLine;
        if (format === 'context') {
          entry.context_before = m.context_before;
          entry.context_after = m.context_after;
        }
        results.push(entry);
      }
    }

    if (query.relationships) {
      const importGraph = await runtime.getImportGraph(projectRoot);
      const relMap: Record<string, { imports: string[]; importedBy: string[] }> = {};
      for (const file of matchedFiles.keys()) {
        relMap[file] = {
          imports: importGraph.findImports(file),
          importedBy: importGraph.findDependents(file),
        };
      }
      return { matches: results, count: totalMatches, relationships: relMap };
    }

    return { matches: results, count: totalMatches };
  }

  return makeCountResult(totalMatches);
}

export { executeContentQuery };
