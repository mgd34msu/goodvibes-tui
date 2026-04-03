import { resolve, relative, join, extname } from 'node:path';
import { stat as statAsync } from 'node:fs/promises';
import { statSync, lstatSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { walkDir, WALK_SKIP_DIRS as SKIP_DIRS } from '../../utils/walk-dir.ts';
import type { Tool } from '../../types/tools.ts';
import { findSchema } from './schema.ts';
import { CodeIntelligence, uriToPath } from '../../intelligence/index.ts';
import * as astGrep from '@ast-grep/napi';
import { appendSchemaFingerprint } from '../shared/schema-fingerprint.ts';

// ---------------------------------------------------------------------------
// Import graph module-level cache (avoids rebuilding on every relationships query)
// ---------------------------------------------------------------------------

let _importGraphBuiltAt = 0;
const IMPORT_GRAPH_TTL = 30_000; // 30 seconds

async function getImportGraph(projectRoot: string) {
  const { ImportGraph } = await import('../../intelligence/import-graph.ts');
  const now = Date.now();
  const graph = ImportGraph.getInstance();
  if (now - _importGraphBuiltAt > IMPORT_GRAPH_TTL) {
    try {
      await graph.build(projectRoot);
    } catch {
      // Import graph build failure is non-fatal
    }
    _importGraphBuiltAt = now;
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutputFormat = 'count_only' | 'files_only' | 'locations' | 'matches' | 'context' | 'with_stats' | 'with_preview' | 'signatures' | 'full';
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'enum';

export interface QueryBase {
  id: string;
  mode: 'files' | 'content' | 'symbols' | 'references' | 'structural';
  path?: string;
}

export interface FilesQuery extends QueryBase {
  mode: 'files';
  patterns?: string[];
  exclude?: string[];
  min_size?: number;
  max_size?: number;
  modified_after?: string;
  modified_before?: string;
  respect_gitignore?: boolean;
  sort_by?: 'name' | 'size' | 'modified';
  sort_order?: 'asc' | 'desc';
  has_content?: string;
  is_empty?: boolean;
  follow_symlinks?: boolean;
  include_hidden?: boolean;
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
  ranked?: boolean;
  preview_replace?: string;
  relationships?: boolean;
}

export interface SymbolsQuery extends QueryBase {
  mode: 'symbols';
  query?: string;
  kinds?: SymbolKind[];
  exported_only?: boolean;
  include_private?: boolean;
  group_by?: 'file' | 'kind' | 'none';
}

export interface ReferencesQuery extends QueryBase {
  mode: 'references';
  symbol: string;
  file: string;
  line: number;
  column: number;
}

export interface StructuralQuery extends QueryBase {
  mode: 'structural';
  pattern: string;
  lang?: 'ts' | 'tsx' | 'js' | 'jsx' | 'css' | 'html';
  glob?: string;
}

export type FindQuery = FilesQuery | ContentQuery | SymbolsQuery | ReferencesQuery | StructuralQuery;

export interface OutputOptions {
  format?: OutputFormat;
  context_before?: number;
  context_after?: number;
  expand_to?: 'line' | 'block' | 'function' | 'class';
  max_results?: number;
  max_per_item?: number;
  max_total_matches?: number;
  max_tokens?: number;
  preview_lines?: number;
  max_line_length?: number;
}

export interface FindInput {
  queries: FindQuery[];
  output?: OutputOptions;
  parallel?: boolean;
}

// ---------------------------------------------------------------------------
// Mode: references
// ---------------------------------------------------------------------------

async function executeReferencesQuery(
  query: ReferencesQuery,
  output: OutputOptions,
): Promise<Record<string, unknown>> {
  const projectRoot = process.cwd();
  const maxResults = output.max_results ?? 100;

  interface ReferenceLocation { file: string; line: number; }
  let locations: ReferenceLocation[] = [];

  // Try LSP first
  const ci = CodeIntelligence.getInstance();
  try {
    const lspLocations = await ci.getReferences(query.file, query.line, query.column);
    if (lspLocations.length > 0) {
      for (const loc of lspLocations) {
        if (locations.length >= maxResults) break;
        try {
          const filePath = uriToPath(loc.uri);
          // LSP uses zero-based lines; add 1 for display
          locations.push({ file: filePath, line: loc.range.start.line + 1 });
        } catch {
          // Skip unparseable URIs
        }
      }

      if (output.format === 'count_only') return { count: locations.length };
      if (output.format === 'files_only') {
        const uniqueFiles = [...new Set(locations.map((l) => l.file))];
        return { files: uniqueFiles, count: locations.length };
      }
      return { locations, count: locations.length };
    }
  } catch {
    // LSP unavailable — fall through to grep fallback
  }

  // Grep fallback: search for symbol name across all project text files
  if (!query.symbol) {
    return { locations: [], count: 0, source: 'fallback' };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(`\\b${query.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  } catch {
    return { error: `Invalid symbol name: ${query.symbol}` };
  }

  const files = await collectTextFiles(projectRoot);
  for (const file of files) {
    if (locations.length >= maxResults) break;
    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (locations.length >= maxResults) break;
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        locations.push({ file, line: i + 1 });
      }
    }
  }

  if (output.format === 'count_only') return { count: locations.length, source: 'fallback' };
  if (output.format === 'files_only') {
    const uniqueFiles = [...new Set(locations.map((l) => l.file))];
    return { files: uniqueFiles, count: locations.length, source: 'fallback' };
  }
  return { locations, count: locations.length, source: 'fallback' };
}

// ---------------------------------------------------------------------------
// File walking utilities
// ---------------------------------------------------------------------------

const VALID_SYMBOL_KINDS = new Set(['function', 'class', 'interface', 'type', 'variable', 'constant', 'enum']);
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
// Gitignore support
// ---------------------------------------------------------------------------

/**
 * Parse a .gitignore file and return a predicate that returns true when a
 * relative path should be ignored. Supports:
 *   - blank lines and # comments are skipped
 *   - leading ! negates the pattern (un-ignore)
 *   - trailing / restricts to directories (treated as prefix match)
 *   - ** glob wildcard
 *   - standard * and ? single-segment wildcards
 */
function buildGitignoreMatcher(gitignorePath: string): ((rel: string) => boolean) | null {
  if (!existsSync(gitignorePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(gitignorePath, 'utf8');
  } catch {
    return null;
  }

  interface GitignoreRule { negate: boolean; glob: InstanceType<typeof Bun.Glob> }
  const rules: GitignoreRule[] = [];

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let negate = false;
    let pat = line;
    if (pat.startsWith('!')) {
      negate = true;
      pat = pat.slice(1);
    }
    // Strip trailing slash (we match both files and dirs)
    if (pat.endsWith('/')) pat = pat.slice(0, -1);
    // If no slash in pattern, make it match anywhere in tree
    if (!pat.includes('/')) pat = `**/${pat}`;
    // If starts with /, strip the slash (root-anchored)
    else if (pat.startsWith('/')) pat = pat.slice(1);

    try {
      rules.push({ negate, glob: new Bun.Glob(pat) });
    } catch {
      // Skip malformed patterns
    }
  }

  if (rules.length === 0) return null;

  return (rel: string): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.glob.match(rel)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  };
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
  const includeHidden = query.include_hidden ?? false;
  const followSymlinks = query.follow_symlinks ?? false;
  const respectGitignore = query.respect_gitignore !== false; // default true

  // Parse date filters once
  const modifiedAfterMs = query.modified_after ? new Date(query.modified_after).getTime() : undefined;
  if (modifiedAfterMs !== undefined && Number.isNaN(modifiedAfterMs)) {
    return { error: `Invalid modified_after date: ${query.modified_after}` };
  }
  const modifiedBeforeMs = query.modified_before ? new Date(query.modified_before).getTime() : undefined;
  if (modifiedBeforeMs !== undefined && Number.isNaN(modifiedBeforeMs)) {
    return { error: `Invalid modified_before date: ${query.modified_before}` };
  }

  // Build gitignore matcher
  const gitignoreMatcher = respectGitignore
    ? buildGitignoreMatcher(join(projectRoot, '.gitignore'))
    : null;

  // Validate has_content regex early
  let hasContentRegex: RegExp | undefined;
  if (query.has_content) {
    try {
      hasContentRegex = new RegExp(query.has_content);
    } catch (e) {
      return { error: `Invalid has_content regex: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const matchedFiles = new Set<string>();
  const SCAN_CEILING = 50_000;
  const visitedRealPaths = new Set<string>();

  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    try {
      for await (const file of glob.scan({ cwd: basePath, onlyFiles: true, absolute: true, followSymlinks })) {
        if (matchedFiles.size >= SCAN_CEILING) break;

        // Symlink cycle detection
        if (followSymlinks) {
          try {
            const real = realpathSync(file);
            if (visitedRealPaths.has(real)) continue;
            visitedRealPaths.add(real);
          } catch {
            // realpathSync failure — skip file
            continue;
          }
        }

        // Skip system/hidden directories (same rules as walkDir)
        const rel = relative(basePath, file);
        const segments = rel.split('/');
        const inSkippedDir = segments.some(
          (seg) =>
            SKIP_DIRS.has(seg) ||
            (!includeHidden && seg.startsWith('.') && seg !== '.'),
        );
        if (inSkippedDir) continue;

        // Gitignore check
        if (gitignoreMatcher && gitignoreMatcher(rel)) continue;

        // Check exclusions
        const excluded = compiledExcludes.some((excl) => matchesGlob(excl, file, basePath));
        if (excluded) continue;

        matchedFiles.add(file);
      }
    } catch {
      // Pattern scan failure — skip
    }
  }

  // Collect stats and apply stat-based filters.
  // We stat all candidates in one pass; the result is cached for sorting/output.
  const needStats =
    query.min_size !== undefined ||
    query.max_size !== undefined ||
    query.is_empty !== undefined ||
    modifiedAfterMs !== undefined ||
    modifiedBeforeMs !== undefined ||
    query.sort_by === 'size' ||
    query.sort_by === 'modified' ||
    output.format === 'with_stats' ||
    output.format === 'with_preview';

  interface FileEntry {
    path: string;
    size?: number;
    mtimeMs?: number;
  }

  let entries: FileEntry[] = Array.from(matchedFiles).map((p) => ({ path: p }));

  if (needStats) {
    const withStats: FileEntry[] = [];
    for (const entry of entries) {
      try {
        const s = followSymlinks ? statSync(entry.path) : lstatSync(entry.path);
        entry.size = s.size;
        entry.mtimeMs = s.mtimeMs;
      } catch {
        // If stat fails, keep with no stats — filters requiring stats will drop it
      }

      // Size filters
      if (query.min_size !== undefined && (entry.size ?? 0) < query.min_size) continue;
      if (query.max_size !== undefined && (entry.size ?? 0) > query.max_size) continue;

      // is_empty filter
      if (query.is_empty === true && (entry.size ?? 0) !== 0) continue;
      if (query.is_empty === false && (entry.size ?? 0) === 0) continue;

      // Date filters
      if (modifiedAfterMs !== undefined && (entry.mtimeMs ?? 0) < modifiedAfterMs) continue;
      if (modifiedBeforeMs !== undefined && (entry.mtimeMs ?? 0) >= modifiedBeforeMs) continue;

      withStats.push(entry);
    }
    entries = withStats;
  }

  // Apply maxResults cap after all filters
  entries = entries.slice(0, maxResults);

  // has_content filter — read file and test regex
  if (hasContentRegex) {
    const filtered: FileEntry[] = [];
    for (const entry of entries) {
      try {
        const text = await Bun.file(entry.path).text();
        if (hasContentRegex.test(text)) filtered.push(entry);
      } catch {
        // Unreadable file — skip
      }
    }
    entries = filtered;
  }

  // Sorting
  const sortBy = query.sort_by ?? 'name';
  const sortOrder = query.sort_order ?? 'asc';
  const dir = sortOrder === 'desc' ? -1 : 1;

  entries.sort((a, b) => {
    if (sortBy === 'size') return ((a.size ?? 0) - (b.size ?? 0)) * dir;
    if (sortBy === 'modified') return ((a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)) * dir;
    // name
    return a.path.localeCompare(b.path) * dir;
  });

  const format = output.format ?? 'files_only';

  if (format === 'count_only') {
    return { count: entries.length };
  }

  if (format === 'with_stats') {
    // Ensure we have stats even when not needed for filters/sorting
    const result = entries.map((e) => ({
      file: e.path,
      size: e.size,
      modified: e.mtimeMs !== undefined ? new Date(e.mtimeMs).toISOString() : undefined,
    }));
    return { files: result, count: result.length };
  }

  if (format === 'with_preview') {
    const previewLines = output.preview_lines ?? 3;
    const result: Array<{ file: string; preview: string[] }> = [];
    for (const entry of entries) {
      let preview: string[] = [];
      try {
        const text = await Bun.file(entry.path).text();
        preview = text.split('\n').slice(0, previewLines);
      } catch {
        // Unreadable — empty preview
      }
      result.push({ file: entry.path, preview });
    }
    return { files: result, count: result.length };
  }

  return { files: entries.map((e) => e.path), count: entries.length };
}

// ---------------------------------------------------------------------------
// Search cache (feature: cache)
// ---------------------------------------------------------------------------

interface CacheKey {
  pattern: string;
  glob: string;
  path: string;
  flags: string;
}

interface CacheValue {
  files: string[];
  matchedFiles: Map<string, { content: string; matches: ContentMatch[] }>;
  totalMatches: number;
  fileMtimes: Map<string, number>;
}

const SEARCH_CACHE_MAX = 50;
const searchCache = new Map<string, { value: CacheValue; accessedAt: number }>();

function makeSearchCacheKey(key: CacheKey): string {
  return JSON.stringify([key.pattern, key.glob, key.path, key.flags]);
}

function searchCacheGet(key: CacheKey): CacheValue | null {
  const k = makeSearchCacheKey(key);
  const entry = searchCache.get(k);
  if (!entry) return null;
  entry.accessedAt = Date.now();
  return entry.value;
}

function searchCacheSet(key: CacheKey, value: CacheValue): void {
  const k = makeSearchCacheKey(key);
  // LRU eviction: drop oldest entry when at capacity
  if (searchCache.size >= SEARCH_CACHE_MAX && !searchCache.has(k)) {
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [ck, cv] of searchCache) {
      if (cv.accessedAt < oldestTime) {
        oldestTime = cv.accessedAt;
        oldestKey = ck;
      }
    }
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(k, { value, accessedAt: Date.now() });
}

async function searchCacheIsValid(cached: CacheValue): Promise<boolean> {
  // Validate by checking that none of the searched files have changed mtime
  const entries = Array.from(cached.fileMtimes.entries());
  const stats = await Promise.all(entries.map(([f]) => statAsync(f).catch(() => null)));
  for (let i = 0; i < entries.length; i++) {
    const s = stats[i];
    if (!s || s.mtimeMs !== entries[i][1]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mode: content
// ---------------------------------------------------------------------------

interface ContentMatch {
  file: string;
  line: number;
  text: string;
  startLine?: number;
  endLine?: number;
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

  // signatures/full output format is only valid for symbols mode
  if (format === 'signatures' || format === 'full') {
    return { error: `Output format '${format}' is only valid for symbols mode` };
  }

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

  // Search cache: skip expensive scan if same query repeated and files unchanged
  const cacheKey: CacheKey = { pattern: rawPattern, glob: query.glob ?? '', path: basePath, flags };
  const cachedEntry = searchCacheGet(cacheKey);
  const cacheValid = cachedEntry ? await searchCacheIsValid(cachedEntry) : false;

  // matchedFiles and totalMatches are populated either from cache or from normal matching below
  let matchedFiles: Map<string, { content: string; matches: ContentMatch[] }>;
  let totalMatches: number;

  if (cacheValid && cachedEntry) {
    // Use cached results for ALL output formats — skip expensive file scan
    matchedFiles = cachedEntry.matchedFiles;
    totalMatches = cachedEntry.totalMatches;
  } else {
  // Normal matching
  matchedFiles = new Map<string, { content: string; matches: ContentMatch[] }>();
  totalMatches = 0;

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
        // Store full text here; max_line_length truncation happens at output time (after preview_replace)
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

  } // end: normal matching (else branch of cache valid check)

  // Store results in cache (only when not using ranked/preview_replace/relationships to keep cache simple)
  if (!query.ranked && !query.preview_replace && !query.relationships) {
    // Build mtime map for cache validity checking
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
    searchCacheSet(cacheKey, {
      files,
      matchedFiles: new Map(matchedFiles),
      totalMatches,
      fileMtimes: fileMtimesForCache,
    });
  }

  // ranked: score and sort matches by relevance
  if (query.ranked) {
    // Collect file mtimes for recency scoring
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

    // Score each match
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
    // Rebuild matchedFiles in sorted order, preserving original content for expand_to
    const sortedEntries = scoredEntries.map(({ file, matches }) => {
      const original = matchedFiles.get(file);
      return [file, { content: original?.content ?? '', matches }] as const;
    });
    matchedFiles = new Map(sortedEntries);
  }

  // expand_to: use CodeIntelligence.getEnclosingScope() to expand matches to
  // their enclosing function or class scope. Silently ignored if tree-sitter
  // grammar is unavailable for a file (scope will be null).
  const expandTo = output.expand_to;
  if (expandTo === 'function' || expandTo === 'class') {
    const ci = CodeIntelligence.getInstance();
    for (const [file, { content, matches }] of matchedFiles) {
      for (const m of matches) {
        try {
          const scope = await ci.getEnclosingScope(file, content, m.line);
          if (scope) {
            m.startLine = scope.startLine;
            m.endLine = scope.endLine;
          }
        } catch {
          // Silently ignore failures — tree-sitter may not be available
        }
      }
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
    for (const [file, { matches }] of matchedFiles) {
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
      replaced?: string;
      startLine?: number;
      endLine?: number;
      context_before?: string[];
      context_after?: string[];
    }> = [];
    for (const [, { matches }] of matchedFiles) {
      for (const m of matches) {
        // preview_replace: show what the line would look like after replacement (no write)
        // Run replacement on full text before truncation so the pattern can match the whole line
        let displayText = m.text;
        let replacedText: string | undefined;
        if (query.preview_replace !== undefined) {
          try {
            const replaceRegex = new RegExp(rawPattern, flags);
            replacedText = m.text.replace(replaceRegex, query.preview_replace);
          } catch {
            // Ignore replacement errors
          }
        }
        // Apply max_line_length truncation after replacement
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

    // relationships: for each matched file, include import/export relationships
    if (query.relationships) {
      const importGraph = await getImportGraph(process.cwd());
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

  const ci = CodeIntelligence.getInstance();

  for (const file of files) {
    if (symbols.length >= maxResults) break;

    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    // Try tree-sitter first for richer, more accurate symbol extraction.
    // Falls back to regex patterns if tree-sitter returns empty results
    // (e.g. no grammar loaded for this language).
    let usedTreeSitter = false;
    try {
      const tsSymbols = await ci.getSymbols(file, content);
      if (tsSymbols.length > 0) {
        usedTreeSitter = true;
        for (const sym of tsSymbols) {
          if (symbols.length >= maxResults) break;
          // Map tree-sitter SymbolInfo kinds to our SymbolKind (filter unknowns)
          const kindMap: Record<string, string> = { method: 'function', property: 'variable', namespace: 'variable' };
          const mappedKind = kindMap[sym.kind ?? ''] ?? (sym.kind ?? 'variable');
          const kind: SymbolKind = VALID_SYMBOL_KINDS.has(mappedKind) ? (mappedKind as SymbolKind) : 'variable';

          if (kindFilter && !kindFilter.has(kind)) continue;
          // include_private overrides exported_only — when true, all symbols are included
          if (query.exported_only && !query.include_private && !sym.exported) continue;
          if (queryRegex && !queryRegex.test(sym.name)) continue;

          symbols.push({ name: sym.name, kind, file, line: sym.line, exported: sym.exported });
        }
      }
    } catch {
      // tree-sitter error — fall through to regex
    }

    if (usedTreeSitter) continue;

    // Regex fallback
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (symbols.length >= maxResults) break;

      const line = lines[i].trimStart();

      for (const { kind, regex, exported } of activePatterns) {
        // include_private overrides exported_only — when true, all symbols are included
        if (query.exported_only && !query.include_private && !exported) continue;

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

  // signatures/full: enrich results with signature lines from file content
  if (output.format === 'signatures' || output.format === 'full') {
    const fileContents = new Map<string, string[]>();
    const enriched: Array<Record<string, unknown>> = [];
    for (const sym of symbols) {
      let fileLines = fileContents.get(sym.file);
      if (!fileLines) {
        try {
          const raw = await Bun.file(sym.file).text();
          fileLines = raw.split('\n');
        } catch {
          fileLines = [];
        }
        fileContents.set(sym.file, fileLines);
      }
      const entry: Record<string, unknown> = {
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        line: sym.line,
        exported: sym.exported,
      };
      // Build signature: collect lines from sym.line until we hit '{', ';', or empty for type-only
      const sigLines: string[] = [];
      for (let i = sym.line - 1; i < Math.min(sym.line + 10, fileLines.length); i++) {
        const l = fileLines[i];
        sigLines.push(l.trimEnd());
        if (/[{;]/.test(l)) break;
      }
      entry.signature = sigLines.join('\n');
      if (output.format === 'full') {
        // JSDoc: look backwards from sym.line for /** ... */ block
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
        // Container: scan backwards for class/namespace declaration
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
    // Apply group_by if requested
    const groupBy = query.group_by ?? 'none';
    if (groupBy === 'file') {
      const grouped: Record<string, unknown[]> = {};
      for (const s of enriched) {
        const key = s.file as string;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(s);
      }
      return { symbols: grouped, count: symbols.length };
    }
    if (groupBy === 'kind') {
      const grouped: Record<string, unknown[]> = {};
      for (const s of enriched) {
        const key = s.kind as string;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(s);
      }
      return { symbols: grouped, count: symbols.length };
    }
    return { symbols: enriched, count: symbols.length };
  }

  // group_by post-processing for standard formats
  const groupBy = query.group_by ?? 'none';
  if (groupBy === 'file') {
    const grouped: Record<string, SymbolResult[]> = {};
    for (const s of symbols) {
      if (!grouped[s.file]) grouped[s.file] = [];
      grouped[s.file].push(s);
    }
    return { symbols: grouped, count: symbols.length };
  }
  if (groupBy === 'kind') {
    const grouped: Record<string, SymbolResult[]> = {};
    for (const s of symbols) {
      if (!grouped[s.kind]) grouped[s.kind] = [];
      grouped[s.kind].push(s);
    }
    return { symbols: grouped, count: symbols.length };
  }

  return { symbols, count: symbols.length };
}

// ---------------------------------------------------------------------------
// Mode: structural
// ---------------------------------------------------------------------------

/** Map file extension to ast-grep language parser. Returns null for unsupported extensions. */
function getAstGrepLang(
  filePath: string,
  override?: StructuralQuery['lang'],
): { parse: (src: string) => { root(): { findAll(pat: string): Array<{ text(): string; range(): { start: { line: number } } }> } } } | null {
  const lang = override ?? extname(filePath).slice(1).toLowerCase();
  switch (lang) {
    case 'ts': return astGrep.ts;
    case 'tsx': return astGrep.tsx;
    case 'js': case 'mjs': case 'cjs': return astGrep.js;
    case 'jsx': return astGrep.jsx;
    case 'css': return astGrep.css;
    case 'html': return astGrep.html;
    default: return null;
  }
}

async function executeStructuralQuery(
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

  interface StructuralMatch { file: string; line: number; text: string }
  const allMatches: StructuralMatch[] = [];
  const matchedFiles = new Set<string>();
  let totalMatches = 0;

  outer: for (const file of files) {
    if (totalMatches >= maxTotal) break;

    const parser = getAstGrepLang(file, query.lang);
    if (!parser) continue; // unsupported extension

    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

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
      const line = match.range().start.line + 1; // ast-grep uses 0-indexed lines

      allMatches.push({ file, line, text });
      matchedFiles.add(file);
      fileMatchCount++;
      totalMatches++;
    }
  }

  if (format === 'count_only') {
    return { count: totalMatches, file_count: matchedFiles.size };
  }

  if (format === 'files_only') {
    return { files: Array.from(matchedFiles), count: matchedFiles.size };
  }

  if (format === 'locations') {
    const locations = allMatches.map((m) => ({ file: m.file, line: m.line }));
    return { locations, count: totalMatches };
  }

  // matches / context (context is same as matches for structural — no line-level context available)
  return { matches: allMatches, count: totalMatches };
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
          case 'references':
            result = await executeReferencesQuery(query, output);
            break;
          case 'structural':
            result = await executeStructuralQuery(query, output);
            break;
          default: {
            const exhaustive: never = query;
            result = { error: `Unknown mode: ${(exhaustive as FindQuery).mode}` };
          }
        }

        // Append schema fingerprint to each individual query result
        return [query.id, appendSchemaFingerprint(result, 'find', query.mode)];
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

      // For multi-query results, also fingerprint the envelope using the 'multi' mode
      const finalResults = input.queries.length > 1
        ? appendSchemaFingerprint(results, 'find', 'multi')
        : results;

      return { success: true, output: JSON.stringify(finalResults) };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
