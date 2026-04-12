import { resolve, relative, join } from 'node:path';
import { stat as statAsync } from 'node:fs/promises';
import { statSync, lstatSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { walkDir, WALK_SKIP_DIRS as SKIP_DIRS } from '../../utils/walk-dir.ts';

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

type CountResult = { count: number; file_count?: number; source?: string };
type FilesResult = { files: string[]; count: number; source?: string };
type LocationsResult<TLocation> = { locations: TLocation[]; count: number; source?: string };

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

export interface ContentMatch {
  file: string;
  line: number;
  text: string;
  startLine?: number;
  endLine?: number;
  context_before?: string[];
  context_after?: string[];
}

export function makeCountResult(count: number, source?: string, fileCount?: number): CountResult {
  return fileCount !== undefined
    ? { count, file_count: fileCount, ...(source ? { source } : {}) }
    : { count, ...(source ? { source } : {}) };
}

export function makeFilesResult(files: string[], count: number, source?: string): FilesResult {
  return { files, count, ...(source ? { source } : {}) };
}

export function makeLocationsResult<TLocation>(locations: TLocation[], count: number, source?: string): LocationsResult<TLocation> {
  return { locations, count, ...(source ? { source } : {}) };
}

export const VALID_SYMBOL_KINDS = new Set(['function', 'class', 'interface', 'type', 'variable', 'constant', 'enum']);
const BINARY_CHECK_BYTES = 8192;

export function isHiddenOrSkippedSegment(segment: string, includeHidden: boolean): boolean {
  return SKIP_DIRS.has(segment) || (!includeHidden && segment.startsWith('.') && segment !== '.');
}

export function shouldSkipRelativePath(relativePath: string, includeHidden: boolean): boolean {
  return relativePath.split('/').some((segment) => isHiddenOrSkippedSegment(segment, includeHidden));
}

export async function isBinary(filePath: string): Promise<boolean> {
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

export async function collectTextFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  for await (const filePath of walkDir(dirPath)) {
    if (!(await isBinary(filePath))) {
      files.push(filePath);
    }
  }
  return files;
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return null;
  }
}

export async function collectGlobFiles(
  basePath: string,
  patterns: string[],
  includeHidden: boolean,
  followSymlinks: boolean,
): Promise<Set<string>> {
  const matchedFiles = new Set<string>();
  const visitedRealPaths = new Set<string>();

  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    try {
      for await (const file of glob.scan({ cwd: basePath, onlyFiles: true, absolute: true, followSymlinks })) {
        if (followSymlinks) {
          try {
            const real = realpathSync(file);
            if (visitedRealPaths.has(real)) continue;
            visitedRealPaths.add(real);
          } catch {
            continue;
          }
        }

        const rel = relative(basePath, file);
        if (shouldSkipRelativePath(rel, includeHidden)) continue;
        matchedFiles.add(file);
      }
    } catch {
      // Pattern scan failure — skip
    }
  }

  return matchedFiles;
}

export function matchesGlob(glob: InstanceType<typeof Bun.Glob>, filePath: string, basePath: string): boolean {
  const rel = relative(basePath, filePath);
  return glob.match(rel) || glob.match(filePath);
}

export function toSymbolKind(kind: string | undefined): SymbolKind {
  const kindMap: Record<string, SymbolKind> = {
    method: 'function',
    property: 'variable',
    namespace: 'variable',
  };
  const mappedKind = kindMap[kind ?? ''] ?? (kind ?? 'variable');
  return VALID_SYMBOL_KINDS.has(mappedKind) ? mappedKind : 'variable';
}

export function matchesSymbolQuery(name: string, queryRegex: RegExp | null): boolean {
  return queryRegex ? queryRegex.test(name) : true;
}

export async function loadFileLines(filePath: string): Promise<string[]> {
  const raw = await readTextFile(filePath);
  return raw === null ? [] : raw.split('\n');
}

export function groupByKey<T extends { file: string; kind: string }>(
  items: T[],
  groupBy: 'file' | 'kind' | 'none',
): Record<string, T[]> | null {
  if (groupBy === 'none') return null;
  const grouped: Record<string, T[]> = {};
  for (const item of items) {
    const key = groupBy === 'file' ? item.file : item.kind;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  }
  return grouped;
}

export function validateSearchPath(
  path: string | undefined,
  projectRoot: string,
): string | { error: string } {
  const resolved = path ? resolve(path) : projectRoot;
  if (!resolved.startsWith(projectRoot + '/') && resolved !== projectRoot) {
    return { error: `Path '${path}' resolves outside the project root.` };
  }
  return resolved;
}

export function buildGitignoreMatcher(gitignorePath: string): ((rel: string) => boolean) | null {
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
    if (pat.endsWith('/')) pat = pat.slice(0, -1);
    if (!pat.includes('/')) pat = `**/${pat}`;
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

export async function collectFilesForSearch(
  basePath: string,
  queryGlob: string | undefined,
): Promise<string[]> {
  if (!queryGlob) {
    return collectTextFiles(basePath);
  }
  return Array.from(await collectGlobFiles(basePath, [queryGlob], false, false));
}

const SEARCH_CACHE_MAX = 50;
const IMPORT_GRAPH_TTL = 30_000;

function makeSearchCacheKey(key: CacheKey): string {
  return JSON.stringify([key.pattern, key.glob, key.path, key.flags]);
}

export interface ImportGraphLike {
  findImports(file: string): string[];
  findDependents(file: string): string[];
}

export class FindRuntimeService {
  private readonly searchCache = new Map<string, { value: CacheValue; accessedAt: number }>();
  private importGraph: ImportGraphLike | null = null;
  private importGraphBuiltAt = 0;

  searchCacheGet(key: CacheKey): CacheValue | null {
    const cacheKey = makeSearchCacheKey(key);
    const entry = this.searchCache.get(cacheKey);
    if (!entry) return null;
    entry.accessedAt = Date.now();
    return entry.value;
  }

  searchCacheSet(key: CacheKey, value: CacheValue): void {
    const cacheKey = makeSearchCacheKey(key);
    if (this.searchCache.size >= SEARCH_CACHE_MAX && !this.searchCache.has(cacheKey)) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [candidateKey, candidateValue] of this.searchCache) {
        if (candidateValue.accessedAt < oldestTime) {
          oldestTime = candidateValue.accessedAt;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey) this.searchCache.delete(oldestKey);
    }
    this.searchCache.set(cacheKey, { value, accessedAt: Date.now() });
  }

  async searchCacheIsValid(cached: CacheValue): Promise<boolean> {
    const entries = Array.from(cached.fileMtimes.entries());
    const stats = await Promise.all(entries.map(([filePath]) => statAsync(filePath).catch(() => null)));
    for (let i = 0; i < entries.length; i++) {
      const stat = stats[i];
      if (!stat || stat.mtimeMs !== entries[i][1]) return false;
    }
    return true;
  }

  async getImportGraph(projectRoot: string): Promise<ImportGraphLike> {
    const now = Date.now();
    if (this.importGraph !== null && now - this.importGraphBuiltAt <= IMPORT_GRAPH_TTL) {
      return this.importGraph;
    }
    const { ImportGraph } = await import('../../intelligence/import-graph.ts');
    const graph = new ImportGraph() as ImportGraphLike & {
      build(projectRoot: string): Promise<void>;
    };
    try {
      await graph.build(projectRoot);
    } catch {
      // Import graph build failure is non-fatal.
    }
    this.importGraph = graph;
    this.importGraphBuiltAt = now;
    return graph;
  }
}
