import { resolve, relative, join } from 'node:path';
import { readdir, stat, readFile } from 'node:fs/promises';
import type { Tool } from '../../types/tools.ts';
import { findSchema } from './schema.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutputFormat = 'count_only' | 'files_only' | 'locations' | 'matches' | 'context';
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'enum';

export interface QueryBase {
  id: string;
  mode: 'files' | 'content' | 'symbols';
  path?: string;
}

export interface FilesQuery extends QueryBase {
  mode: 'files';
  patterns?: string[];
  exclude?: string[];
}

export interface ContentQuery extends QueryBase {
  mode: 'content';
  pattern?: string;
  pattern_base64?: string;
  glob?: string;
  case_sensitive?: boolean;
  whole_word?: boolean;
  multiline?: boolean;
  negate?: boolean;
}

export interface SymbolsQuery extends QueryBase {
  mode: 'symbols';
  query?: string;
  kinds?: SymbolKind[];
  exported_only?: boolean;
}

export type FindQuery = FilesQuery | ContentQuery | SymbolsQuery;

export interface OutputOptions {
  format?: OutputFormat;
  context_before?: number;
  context_after?: number;
  expand_to?: 'line' | 'block' | 'function' | 'class';
  max_results?: number;
  max_per_item?: number;
  max_total_matches?: number;
  max_tokens?: number;
}

export interface FindInput {
  queries: FindQuery[];
  output?: OutputOptions;
  parallel?: boolean;
}

// ---------------------------------------------------------------------------
// File walking utilities
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', '.cache', '__pycache__']);
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const BINARY_CHECK_BYTES = 8192;

/** Detect binary files by checking for null bytes in the first 8KB. */
async function isBinary(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return false;
    const chunk = await file.slice(0, BINARY_CHECK_BYTES).arrayBuffer();
    const bytes = new Uint8Array(chunk);
    for (const byte of bytes) {
      if (byte === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Walk a directory tree, yielding all file paths that pass filters. */
async function* walkDir(dirPath: string): AsyncGenerator<string> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip hidden directories and known heavy directories
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      try {
        const info = await stat(fullPath);
        if (info.size > MAX_FILE_SIZE) continue;
      } catch {
        continue;
      }
      yield fullPath;
    }
  }
}

/** Collect all walkable text files in a directory. Binary files are excluded. */
async function collectTextFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  for await (const filePath of walkDir(dirPath)) {
    if (!(await isBinary(filePath))) {
      files.push(filePath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Glob file matching (matches a single glob against a file path)
// ---------------------------------------------------------------------------

/** Test a single file path against a pre-compiled glob pattern. */
function matchesGlob(glob: InstanceType<typeof Bun.Glob>, filePath: string, basePath: string): boolean {
  const rel = relative(basePath, filePath);
  return glob.match(rel) || glob.match(filePath);
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validates that a path (relative or absolute) resolves within the project root.
 * Returns the resolved path if valid, or an error object if not.
 */
function validateSearchPath(
  path: string | undefined,
  projectRoot: string,
): string | { error: string } {
  const resolved = path ? resolve(path) : projectRoot;
  if (!resolved.startsWith(projectRoot + '/') && resolved !== projectRoot) {
    return { error: `Path '${path}' resolves outside the project root.` };
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Mode: files
// ---------------------------------------------------------------------------

async function executeFilesQuery(
  query: FilesQuery,
  output: OutputOptions,
): Promise<Record<string, unknown>> {
  const projectRoot = process.cwd();
  const validatedPath = validateSearchPath(query.path, projectRoot);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;
  const patterns = query.patterns ?? ['**/*'];
  const excludePatterns = query.exclude ?? [];
  const compiledExcludes = excludePatterns.map((p) => new Bun.Glob(p));
  const maxResults = output.max_results ?? 100;

  const matchedFiles = new Set<string>();

  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    try {
      for await (const file of glob.scan({ cwd: basePath, onlyFiles: true, absolute: true })) {
        if (matchedFiles.size >= maxResults) break;

        // Skip system/hidden directories (same rules as walkDir)
        const rel = relative(basePath, file);
        const segments = rel.split('/');
        const inSkippedDir = segments.some(
          (seg) => SKIP_DIRS.has(seg) || (seg.startsWith('.') && seg !== '.'),
        );
        if (inSkippedDir) continue;

        // Check exclusions
        const excluded = compiledExcludes.some((excl) => matchesGlob(excl, file, basePath));
        if (!excluded) {
          matchedFiles.add(file);
        }
      }
    } catch {
      // Pattern scan failure — skip
    }
  }

  const sorted = Array.from(matchedFiles).sort();

  const format = output.format ?? 'files_only';

  if (format === 'count_only') {
    return { count: sorted.length };
  }

  return { files: sorted, count: sorted.length };
}

// ---------------------------------------------------------------------------
// Mode: content
// ---------------------------------------------------------------------------

interface ContentMatch {
  file: string;
  line: number;
  text: string;
  context_before?: string[];
  context_after?: string[];
}

async function executeContentQuery(
  query: ContentQuery,
  output: OutputOptions,
): Promise<Record<string, unknown>> {
  const projectRoot = process.cwd();
  const validatedPath = validateSearchPath(query.path, projectRoot);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;
  const format = output.format ?? 'matches';
  const maxPerFile = output.max_per_item ?? 10;
  const maxTotal = output.max_total_matches ?? output.max_results ?? 100;
  const ctxBefore = output.context_before ?? 0;
  const ctxAfter = output.context_after ?? 0;

  // Resolve pattern
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

  // Collect files to search
  let files: string[];
  if (query.glob) {
    const glob = new Bun.Glob(query.glob);
    files = [];
    try {
      for await (const file of glob.scan({ cwd: basePath, onlyFiles: true, absolute: true })) {
        const rel = relative(basePath, file);
        const segments = rel.split('/');
        const inSkippedDir = segments.some(
          (seg) => SKIP_DIRS.has(seg) || (seg.startsWith('.') && seg !== '.'),
        );
        if (!inSkippedDir) files.push(file);
      }
    } catch {
      files = [];
    }
  } else {
    files = await collectTextFiles(basePath);
  }

  if (query.negate) {
    // Return files that do NOT contain the pattern
    const nonMatchingFiles: string[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await Bun.file(file).text();
      } catch {
        continue;
      }
      regex.lastIndex = 0;
      if (!regex.test(content)) {
        nonMatchingFiles.push(file);
        if (nonMatchingFiles.length >= maxTotal) break;
      }
    }
    if (format === 'count_only') return { count: nonMatchingFiles.length };
    return { files: nonMatchingFiles, count: nonMatchingFiles.length };
  }

  // Normal matching
  const matchedFiles = new Map<string, ContentMatch[]>();
  let totalMatches = 0;

  outer: for (const file of files) {
    if (totalMatches >= maxTotal) break;

    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    // Check binary again (in case glob included binary files)
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
      matchedFiles.set(file, fileMatches);
    }
  }

  if (format === 'count_only') {
    return { count: totalMatches, file_count: matchedFiles.size };
  }

  if (format === 'files_only') {
    return { files: Array.from(matchedFiles.keys()), count: matchedFiles.size };
  }

  if (format === 'locations') {
    const locations: Array<{ file: string; line: number }> = [];
    for (const [file, matches] of matchedFiles) {
      for (const m of matches) {
        locations.push({ file, line: m.line });
      }
    }
    return { locations, count: totalMatches };
  }

  if (format === 'matches' || format === 'context') {
    const results: Array<{
      file: string;
      line: number;
      text: string;
      context_before?: string[];
      context_after?: string[];
    }> = [];
    for (const [, matches] of matchedFiles) {
      for (const m of matches) {
        const entry: (typeof results)[number] = { file: m.file, line: m.line, text: m.text };
        if (format === 'context') {
          entry.context_before = m.context_before;
          entry.context_after = m.context_after;
        }
        results.push(entry);
      }
    }
    return { matches: results, count: totalMatches };
  }

  return { count: totalMatches };
}

// ---------------------------------------------------------------------------
// Mode: symbols
// ---------------------------------------------------------------------------

interface SymbolResult {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  exported: boolean;
}

async function executeSymbolsQuery(
  query: SymbolsQuery,
  output: OutputOptions,
): Promise<Record<string, unknown>> {
  const projectRoot = process.cwd();
  const validatedPath = validateSearchPath(query.path, projectRoot);
  if (typeof validatedPath === 'object') return validatedPath;
  const basePath = validatedPath;
  const maxResults = output.max_results ?? 100;
  const kindFilter = query.kinds ? new Set(query.kinds) : null;

  // Build per-line patterns for each symbol type
  const linePatterns: Array<{
    kind: SymbolKind;
    regex: RegExp;
    exported: boolean;
  }> = [
    // Exported
    { kind: 'function', regex: /^export\s+(?:async\s+)?function\s+(\w+)/, exported: true },
    { kind: 'class', regex: /^export\s+(?:abstract\s+)?class\s+(\w+)/, exported: true },
    { kind: 'interface', regex: /^export\s+interface\s+(\w+)/, exported: true },
    { kind: 'type', regex: /^export\s+type\s+(\w+)\s*[=<{]/, exported: true },
    { kind: 'enum', regex: /^export\s+enum\s+(\w+)/, exported: true },
    { kind: 'constant', regex: /^export\s+const\s+(\w+)/, exported: true },
    { kind: 'variable', regex: /^export\s+(?:let|var)\s+(\w+)/, exported: true },
    // Non-exported
    { kind: 'function', regex: /^(?:async\s+)?function\s+(\w+)/, exported: false },
    { kind: 'class', regex: /^(?:abstract\s+)?class\s+(\w+)/, exported: false },
  ];

  // Filter by kind if requested
  const activePatterns = kindFilter
    ? linePatterns.filter((p) => kindFilter.has(p.kind))
    : linePatterns;

  const files = await collectTextFiles(basePath);
  const symbols: SymbolResult[] = [];

  // Build query filter regex if provided
  let queryRegex: RegExp | null = null;
  if (query.query) {
    try {
      queryRegex = new RegExp(query.query, 'i');
    } catch {
      return { error: `Invalid symbol query pattern: ${query.query}` };
    }
  }

  for (const file of files) {
    if (symbols.length >= maxResults) break;

    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (symbols.length >= maxResults) break;

      const line = lines[i].trimStart();

      for (const { kind, regex, exported } of activePatterns) {
        if (query.exported_only && !exported) continue;

        const match = line.match(regex);
        if (match) {
          const name = match[1];
          if (!name) continue;

          // Apply query filter
          if (queryRegex && !queryRegex.test(name)) continue;

          symbols.push({ name, kind, file, line: i + 1, exported });
          // Only match the first matching pattern per line to avoid duplicates
          break;
        }
      }
    }
  }

  if (output.format === 'count_only') {
    return { count: symbols.length };
  }

  if (output.format === 'files_only') {
    const uniqueFiles = [...new Set(symbols.map((s) => s.file))];
    return { files: uniqueFiles, count: symbols.length };
  }

  return { symbols, count: symbols.length };
}

// ---------------------------------------------------------------------------
// Main tool
// ---------------------------------------------------------------------------

export const findTool: Tool = {
  definition: findSchema,

  async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      if (!Array.isArray(args.queries) || (args.queries as unknown[]).length === 0) {
        return { success: false, error: 'Missing or empty "queries" array' };
      }

      const input = args as unknown as FindInput;

      const output: OutputOptions = input.output ?? {};
      const parallel = input.parallel !== false; // default true

      const runQuery = async (query: FindQuery): Promise<[string, Record<string, unknown>]> => {
        let result: Record<string, unknown>;

        switch (query.mode) {
          case 'files':
            result = await executeFilesQuery(query, output);
            break;
          case 'content':
            result = await executeContentQuery(query, output);
            break;
          case 'symbols':
            result = await executeSymbolsQuery(query, output);
            break;
          default: {
            const exhaustive: never = query;
            result = { error: `Unknown mode: ${(exhaustive as FindQuery).mode}` };
          }
        }

        return [query.id, result];
      };

      let pairs: Array<[string, Record<string, unknown>]>;

      if (parallel) {
        pairs = await Promise.all(input.queries.map(runQuery));
      } else {
        pairs = [];
        for (const query of input.queries) {
          pairs.push(await runQuery(query));
        }
      }

      const results: Record<string, unknown> = {};
      for (const [id, result] of pairs) {
        results[id] = result;
      }

      return { success: true, output: JSON.stringify(results) };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
