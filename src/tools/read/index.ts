import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { logger } from '../../utils/logger.ts';
import { FileStateCache } from '../../state/file-cache.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { READ_TOOL_SCHEMA } from './schema.ts';
import type { ReadInput, ReadFileInput, ExtractMode, OutputFormat } from './schema.ts';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface FileReadResult {
  path: string;
  resolvedPath: string;
  /** Content extracted according to the extract mode (not set for count_only / minimal). */
  content?: string;
  lineCount: number;
  byteSize: number;
  tokenEstimate: number;
  extract: ExtractMode;
  /** True when the file was detected as binary and skipped. */
  binary?: boolean;
  /** Error message if the file could not be read. */
  error?: string;
  cache?: { status: 'miss' | 'unchanged' | 'modified' };
  /** Additional metadata included in verbose format. */
  metadata?: {
    encoding: string;
    sizeBytes: number;
    cacheStatus: string;
  };
}

export interface ReadOutput {
  success: boolean;
  error?: string;
  files?: FileReadResult[];
  summary: {
    files_read: number;
    files_binary: number;
    files_errored: number;
    total_lines: number;
    total_tokens: number;
  };
  pagination?: {
    page: number;
    total_pages: number;
    pending_files: string[];
  };
}

// ---------------------------------------------------------------------------
// Outline / symbols extraction helpers
// ---------------------------------------------------------------------------

/** Regex patterns that identify structural signature lines. */
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

/** Patterns that match exported declarations and capture the name. */
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

/**
 * Extract an outline: structural signatures with bodies stripped.
 * Returns the multi-line string ready for output.
 */
function extractOutline(lines: string[], includeLineNumbers: boolean): string {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SIGNATURE_PATTERNS.some((p) => p.test(line))) {
      const lineNo = i + 1; // 1-based
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

/**
 * Extract symbols: exported name + kind, one per line.
 */
function extractSymbols(lines: string[], includeLineNumbers: boolean): string {
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

/**
 * Check for binary content by probing the first 8KB of a file for null bytes.
 * Reads directly via a file descriptor to avoid a full UTF-8 decode on large files.
 */
function isBinaryFile(resolvedPath: string): boolean {
  try {
    const fd = openSync(resolvedPath, 'r');
    const probe = Buffer.alloc(8192);
    const bytesRead = readSync(fd, probe, 0, 8192, 0);
    closeSync(fd);
    return probe.slice(0, bytesRead).includes(0);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content formatting
// ---------------------------------------------------------------------------

function formatContent(
  lines: string[],
  includeLineNumbers: boolean,
  range?: { start: number; end: number },
  maxPerItem?: number,
): string {
  let slice: string[];
  let startLine: number; // 1-based line number of the first element in slice

  if (range) {
    const start = Math.max(0, range.start - 1); // 0-based
    const end = Math.min(lines.length, range.end); // exclusive
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

// ---------------------------------------------------------------------------
// Single-file read
// ---------------------------------------------------------------------------

function readOneFile(
  fileInput: ReadFileInput,
  globalExtract: ExtractMode,
  format: OutputFormat,
  includeLineNumbers: boolean,
  maxPerItem: number | undefined,
  fileCache: FileStateCache,
  projectIndex: ProjectIndex,
): FileReadResult {
  const extract: ExtractMode = fileInput.extract ?? globalExtract;

  // Resolve and validate path
  let resolvedPath: string;
  try {
    resolvedPath = resolveAndValidatePath(fileInput.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('read tool: path validation failed', { path: fileInput.path, error: message });
    return {
      path: fileInput.path,
      resolvedPath: fileInput.path,
      lineCount: 0,
      byteSize: 0,
      tokenEstimate: 0,
      extract,
      error: message,
    };
  }

  // Binary pre-check: probe first 8KB before full UTF-8 read
  if (isBinaryFile(resolvedPath)) {
    logger.debug('read tool: binary file skipped', { path: resolvedPath });
    let binaryByteSize = 0;
    try {
      binaryByteSize = statSync(resolvedPath).size;
    } catch { /* ignore */ }
    return {
      path: fileInput.path,
      resolvedPath,
      lineCount: 0,
      byteSize: binaryByteSize,
      tokenEstimate: 0,
      extract,
      binary: true,
    };
  }

  // Read file content once
  let rawContent: string;
  try {
    rawContent = readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('read tool: file read failed', { path: resolvedPath, error: message });
    return {
      path: fileInput.path,
      resolvedPath,
      lineCount: 0,
      byteSize: 0,
      tokenEstimate: 0,
      extract,
      error: `Cannot read file: ${message}`,
    };
  }

  // Determine cache status by updating with content we already have
  // This avoids lookup() reading the file a second time.
  const cacheResult = fileInput.force ? { status: 'miss' as const } : fileCache.lookup(resolvedPath);
  fileCache.update(resolvedPath, rawContent, { tool: 'read' });

  // Update project index
  const byteSize = Buffer.byteLength(rawContent, 'utf-8');
  const tokenEstimate = Math.ceil(byteSize / 4);
  projectIndex.upsertFile(resolvedPath, tokenEstimate);

  const lines = rawContent.split('\n');
  const lineCount = lines.length;

  // Extract content based on mode (not needed for count_only / minimal)
  let extractedContent: string | undefined;
  if (format !== 'count_only' && format !== 'minimal') {
    switch (extract) {
      case 'content':
      case 'lines':
        extractedContent = formatContent(lines, includeLineNumbers, fileInput.range, maxPerItem);
        break;

      case 'outline':
        extractedContent = extractOutline(lines, includeLineNumbers);
        break;

      case 'symbols':
        extractedContent = extractSymbols(lines, includeLineNumbers);
        break;

      case 'ast':
        // Phase 3 placeholder: fall back to outline with a note
        extractedContent =
          '# Note: ast mode requires tree-sitter (Phase 3). Falling back to outline.\n'
          + extractOutline(lines, includeLineNumbers);
        break;

      default:
        extractedContent = formatContent(lines, includeLineNumbers, fileInput.range, maxPerItem);
    }
  }

  const result: FileReadResult = {
    path: fileInput.path,
    resolvedPath,
    content: extractedContent,
    lineCount,
    byteSize,
    tokenEstimate,
    extract,
    cache: { status: cacheResult.status },
  };

  if (format === 'verbose') {
    result.metadata = {
      encoding: 'utf-8',
      sizeBytes: byteSize,
      cacheStatus: cacheResult.status,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

/**
 * Bin file indices into pages, each fitting within tokenBudget.
 * Uses stat to estimate token counts without reading content.
 */
function paginateFiles(
  files: ReadFileInput[],
  tokenBudget: number,
): Array<number[]> {
  const pages: Array<number[]> = [];
  let currentPage: number[] = [];
  let currentTokens = 0;

  for (let i = 0; i < files.length; i++) {
    let est = 0;
    try {
      const resolved = resolveAndValidatePath(files[i].path);
      est = Math.ceil(statSync(resolved).size / 4);
    } catch {
      est = 0;
    }

    if (est > tokenBudget && currentPage.length === 0) {
      // Single oversized file: put it alone on its own page
      pages.push([i]);
      currentPage = [];
      currentTokens = 0;
      continue;
    }

    if (currentTokens + est > tokenBudget && currentPage.length > 0) {
      pages.push(currentPage);
      currentPage = [i];
      currentTokens = est;
    } else {
      currentPage.push(i);
      currentTokens += est;
    }
  }
  if (currentPage.length > 0) pages.push(currentPage);
  return pages;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

/**
 * ReadTool — implements the `read` tool for the ToolRegistry.
 *
 * Reads files from disk with caching, extract modes, and pagination.
 * Never throws from execute().
 */
export class ReadTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'read',
    description:
      'Read one or more files from disk. Supports extract modes (content, outline, symbols, lines, ast)'
      + ' for token-efficient reading, per-file caching, pagination via token_budget, and batch processing.',
    parameters: READ_TOOL_SCHEMA as unknown as Record<string, unknown>,
  };

  private readonly fileCache: FileStateCache;
  private readonly projectIndex: ProjectIndex;

  constructor(fileCache?: FileStateCache, projectIndex?: ProjectIndex) {
    this.fileCache = fileCache ?? new FileStateCache();
    this.projectIndex = projectIndex ?? ProjectIndex.getInstance();
  }

  async execute(
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    if (!Array.isArray(args.files) || args.files.length === 0) {
      return { success: false, error: 'Missing or empty "files" array' };
    }
    try {
      return this._execute(args as unknown as ReadInput);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('read tool: unexpected error', { error: message });
      return { success: false, error: `Unexpected error: ${message}` };
    }
  }

  private _execute(input: ReadInput): { success: boolean; output: string } {
    const globalExtract: ExtractMode = input.extract ?? 'content';
    const format: OutputFormat = input.output?.format ?? 'standard';
    const includeLineNumbers: boolean = input.output?.include_line_numbers ?? true;
    const maxPerItem: number | undefined = input.output?.max_per_item;
    const maxTokens: number | undefined = input.output?.max_tokens;
    const tokenBudget: number | undefined = input.token_budget;
    const page: number = Math.max(1, input.page ?? 1);

    const allFiles = input.files;

    // Pagination: bin files into pages if token_budget is set
    let filesToProcess: ReadFileInput[] = allFiles;
    let paginationInfo: ReadOutput['pagination'] | undefined;

    if (tokenBudget !== undefined) {
      const pages = paginateFiles(allFiles, tokenBudget);
      const totalPages = Math.max(1, pages.length);
      const pageIdx = Math.min(page - 1, totalPages - 1);
      const pageIndices = pages[pageIdx] ?? [];

      filesToProcess = pageIndices.map((i) => allFiles[i]);

      // Pending: files not yet delivered (after the current page)
      const deliveredSet = new Set(pages.slice(0, pageIdx + 1).flat());
      const pendingFiles = allFiles
        .map((f, i) => ({ f, i }))
        .filter(({ i }) => !deliveredSet.has(i))
        .map(({ f }) => f.path);

      paginationInfo = { page, total_pages: totalPages, pending_files: pendingFiles };
    }

    // Read all files for the current page
    const results: FileReadResult[] = filesToProcess.map((f) =>
      readOneFile(f, globalExtract, format, includeLineNumbers, maxPerItem, this.fileCache, this.projectIndex),
    );

    // Apply max_tokens cap: truncate content so cumulative tokens ≤ max_tokens
    if (maxTokens !== undefined) {
      let usedTokens = 0;
      for (const r of results) {
        if (r.content === undefined) continue;
        const contentTokens = Math.ceil(r.content.length / 4);
        if (usedTokens + contentTokens > maxTokens) {
          const remaining = Math.max(0, maxTokens - usedTokens);
          r.content = r.content.slice(0, remaining * 4);
        }
        usedTokens += Math.ceil((r.content?.length ?? 0) / 4);
      }
    }

    // Compute summary
    const filesBinary = results.filter((r) => r.binary === true).length;
    const filesErrored = results.filter((r) => r.error !== undefined && !r.binary).length;
    const filesRead = results.length - filesBinary - filesErrored;
    const totalLines = results.reduce((s, r) => s + r.lineCount, 0);
    const totalTokens = results.reduce((s, r) => s + r.tokenEstimate, 0);

    const output: ReadOutput = {
      success: true,
      summary: {
        files_read: filesRead,
        files_binary: filesBinary,
        files_errored: filesErrored,
        total_lines: totalLines,
        total_tokens: totalTokens,
      },
    };

    if (format === 'count_only') {
      // Summary only — no file data
    } else if (format === 'minimal') {
      output.files = results.map((r) => ({
        path: r.path,
        resolvedPath: r.resolvedPath,
        lineCount: r.lineCount,
        byteSize: r.byteSize,
        tokenEstimate: r.tokenEstimate,
        extract: r.extract,
        binary: r.binary,
        error: r.error,
        cache: r.cache,
      }));
    } else {
      // standard / verbose: include content and all fields
      output.files = results;
    }

    if (paginationInfo) {
      output.pagination = paginationInfo;
    }

    return { success: true, output: JSON.stringify(output) };
  }
}
