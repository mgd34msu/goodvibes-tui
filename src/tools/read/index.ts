import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { logger } from '../../utils/logger.ts';
import { isNotebookFile } from '../../utils/notebook.ts';
import { FileStateCache } from '../../state/file-cache.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { READ_TOOL_SCHEMA } from './schema.ts';
import type { ReadInput, ReadFileInput, ExtractMode, OutputFormat } from './schema.ts';
import {
  type ImageMode, type ImageMetadata,
  IMAGE_SIZE_LIMIT,
  RESIZE_TARGETS,
  isImageFile as isImageFileByExt, isArchiveFile, getImageMediaType,
  validateMagicBytes, getImageMetadata, isBinaryByContent, humanSize,
  tryLoadSharp, resizeImage, convertToPortableFormat, listArchiveContents,
} from './media.ts';
import { CodeIntelligence } from '../../intelligence/facade.ts';
import type { SymbolInfo } from '../../intelligence/tree-sitter/queries.ts';

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
  /** True when the file is an image returned as base64. */
  image?: boolean;
  /** MIME type for image files (e.g. 'image/png'). */
  mediaType?: string;
  /** Error message if the file could not be read. */
  error?: string;
  cache?: { status: 'miss' | 'unchanged' | 'modified' };
  /** Additional metadata included in verbose format. */
  metadata?: {
    encoding: string;
    sizeBytes: number;
    cacheStatus: string;
  };
  /** Structured image data for multimodal LLM messages. */
  imageData?: { base64: string; mediaType: string };
  /** Image-specific metadata. */
  imageMetadata?: {
    width?: number;
    height?: number;
    format: string;
    fileSize: number;
    resized?: boolean;
    converted?: boolean;
    originalFormat?: string;
    mode?: ImageMode;
  };
  /** True when the file is an archive with listed contents. */
  archive?: boolean;
}

export interface ReadOutput {
  success: boolean;
  error?: string;
  files?: FileReadResult[];
  /** Image data for multimodal message construction. Present when images were read. */
  images?: Array<{
    path: string;
    base64: string;
    mediaType: string;
    description: string;
  }>;
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
 * Regex-based outline fallback: structural signatures with bodies stripped.
 */
function extractOutlineRegex(lines: string[], includeLineNumbers: boolean): string {
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
 * Regex-based symbols fallback: exported name + kind, one per line.
 */
function extractSymbolsRegex(lines: string[], includeLineNumbers: boolean): string {
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
 * Tree-sitter kind normalization: maps raw tree-sitter kinds to the same
 * display names used by the regex fallback (e.g. 'const' → 'constant').
 */
const TS_KIND_MAP: Record<string, string> = {
  const: 'constant',
  let: 'variable',
  var: 'variable',
};

function normalizeTsKind(kind: string): string {
  return TS_KIND_MAP[kind] ?? kind;
}

/**
 * Format outline entries from tree-sitter into a display string.
 * OutlineEntry.line values are 1-based as returned by tree-sitter.
 */
function formatOutlineEntries(
  entries: Array<{ line: number; signature: string }>,
  includeLineNumbers: boolean,
): string {
  return entries
    .map((e) => {
      const lineNo = e.line; // 1-based from tree-sitter
      return includeLineNumbers ? `${String(lineNo).padStart(5)} | ${e.signature}` : e.signature;
    })
    .join('\n');
}

/**
 * Extract an outline using tree-sitter via CodeIntelligence.
 * Falls back to the regex implementation if tree-sitter returns empty results.
 * Never throws.
 *
 * @param rawContent - passed to tree-sitter (needs raw string, not pre-split lines)
 * @param lines - passed to regex fallback only (pre-split for efficiency)
 */
async function extractOutline(
  filePath: string,
  rawContent: string,
  lines: string[],
  includeLineNumbers: boolean,
): Promise<string> {
  try {
    const ci = CodeIntelligence.getInstance();
    const entries = await ci.getOutline(filePath, rawContent);
    if (entries.length > 0) return formatOutlineEntries(entries, includeLineNumbers);
  } catch (err) {
    logger.debug('read tool: tree-sitter outline failed, using regex fallback', { filePath, error: String(err) });
  }
  // Fallback: regex-based
  return extractOutlineRegex(lines, includeLineNumbers);
}

/**
 * Format symbol entries from tree-sitter into a display string.
 * Mirrors formatOutlineEntries but for SymbolInfo (has kind + name rather than a pre-built signature).
 */
function formatSymbolEntries(
  symbols: SymbolInfo[],
  includeLineNumbers: boolean,
): string {
  return symbols
    .map((s) => {
      const kind = normalizeTsKind(s.kind);
      const entry = `${kind} ${s.name}`;
      return includeLineNumbers ? `${String(s.line).padStart(5)} | ${entry}` : entry;
    })
    .join('\n');
}

/**
 * Extract symbols using tree-sitter via CodeIntelligence.
 * Falls back to the regex implementation if tree-sitter returns empty results.
 * Never throws.
 */
async function extractSymbols(
  filePath: string,
  rawContent: string,
  lines: string[],
  includeLineNumbers: boolean,
): Promise<string> {
  try {
    const ci = CodeIntelligence.getInstance();
    const symbols = await ci.getSymbols(filePath, rawContent);
    // Filter to exported symbols only (matches regex fallback behavior)
    const exported = symbols.filter((s) => s.exported);
    if (exported.length > 0) return formatSymbolEntries(exported, includeLineNumbers);
  } catch (err) {
    logger.debug('read tool: tree-sitter symbols failed, using regex fallback', { filePath, error: String(err) });
  }
  // Fallback: regex-based
  return extractSymbolsRegex(lines, includeLineNumbers);
}

/**
 * Extract AST representation using tree-sitter via CodeIntelligence.
 * Uses the same tree-sitter path as extractOutline (via formatOutlineEntries),
 * but falls back with an explanatory note rather than silently using regex.
 * Never throws.
 */
async function extractAst(
  filePath: string,
  rawContent: string,
  lines: string[],
  includeLineNumbers: boolean,
): Promise<string> {
  try {
    const ci = CodeIntelligence.getInstance();
    const entries = await ci.getOutline(filePath, rawContent);
    if (entries.length > 0) return formatOutlineEntries(entries, includeLineNumbers);
  } catch (err) {
    logger.debug('read tool: tree-sitter ast failed, using outline fallback', { filePath, error: String(err) });
  }
  // Fallback: regex outline with a note indicating tree-sitter was unavailable
  return (
    '# Note: tree-sitter outline unavailable for this file. Falling back to regex.\n'
    + extractOutlineRegex(lines, includeLineNumbers)
  );
}

// ---------------------------------------------------------------------------
// Image / PDF / Notebook helpers
// ---------------------------------------------------------------------------

function isPdfFile(ext: string): boolean {
  return ext.toLowerCase() === '.pdf';
}

/**
 * Extract text from PDF binary content by scanning stream sections.
 * Mirrors the approach used in the fetch tool.
 */
function extractPdfText(body: string, pages?: string): string {
  const texts: string[] = [];

  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(body)) !== null) {
    const chunk = m[1];
    const parenRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let pm: RegExpExecArray | null;
    while ((pm = parenRe.exec(chunk)) !== null) {
      const text = pm[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .trim();
      if (text.length > 1) texts.push(text);
    }
  }

  if (texts.length === 0) {
    return JSON.stringify({
      note: 'PDF text extraction requires a dedicated library for complex PDFs. No readable text streams found.',
      byteSize: Buffer.byteLength(body, 'utf-8'),
      pages: pages ?? 'all',
    });
  }

  const joined = texts.join(' ');
  // Apply page range filter: pages param is informational for raw-text extraction
  // (we can't page-split without a proper PDF library; note it in the result)
  if (pages) {
    return `[pages: ${pages}]\n${joined}`;
  }
  return joined;
}

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: Array<{
    output_type: string;
    text?: string | string[];
    data?: Record<string, string | string[]>;
  }>;
}

interface NotebookJSON {
  cells: NotebookCell[];
}

/**
 * Parse a Jupyter notebook (.ipynb) and format cells as structured text.
 */
function formatNotebook(raw: string): string {
  let nb: NotebookJSON;
  try {
    nb = JSON.parse(raw) as NotebookJSON;
  } catch {
    return `[error: invalid notebook JSON]`;
  }

  if (!Array.isArray(nb.cells)) {
    return '[error: notebook has no cells array]';
  }

  const parts: string[] = [];
  nb.cells.forEach((cell, idx) => {
    const cellType = cell.cell_type ?? 'unknown';
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
    parts.push(`[cell ${idx + 1}] (${cellType}):`);
    parts.push(source);

    if (cellType === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      const outputLines: string[] = [];
      for (const out of cell.outputs) {
        // text/plain in data, or text directly
        const textData = out.data?.['text/plain'] ?? out.data?.['text/html'] ?? out.text;
        if (textData) {
          const text = Array.isArray(textData) ? textData.join('') : String(textData);
          outputLines.push(text.trimEnd());
        }
      }
      if (outputLines.length > 0) {
        parts.push('[output]:');
        parts.push(outputLines.join('\n'));
      }
    }
  });

  return parts.join('\n');
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

async function readOneFile(
  fileInput: ReadFileInput,
  globalExtract: ExtractMode,
  format: OutputFormat,
  includeLineNumbers: boolean,
  maxPerItem: number | undefined,
  fileCache: FileStateCache,
  projectIndex: ProjectIndex,
  globalImageMode?: ImageMode,
  globalMaxImageSize?: number,
): Promise<FileReadResult> {
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

  // Determine file extension for special type handling
  const ext = extname(resolvedPath);

  // Determine image mode: per-file > global > default
  const imageMode: ImageMode = fileInput.image_mode ?? globalImageMode ?? 'default';
  const maxImageSize = globalMaxImageSize ?? IMAGE_SIZE_LIMIT;

  // --- IMAGE FILES ---
  if (isImageFileByExt(ext)) {
    let imgBuffer: Buffer;
    try {
      imgBuffer = readFileSync(resolvedPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path: fileInput.path,
        resolvedPath,
        lineCount: 0,
        byteSize: 0,
        tokenEstimate: 0,
        extract,
        error: `Cannot read image: ${message}`,
      };
    }

    const byteSize = imgBuffer.length;

    // Size limit check
    if (byteSize > maxImageSize) {
      const meta = getImageMetadata(imgBuffer, ext);
      return {
        path: fileInput.path,
        resolvedPath,
        lineCount: 0,
        byteSize,
        tokenEstimate: 0,
        extract,
        image: true,
        mediaType: getImageMediaType(ext) ?? 'application/octet-stream',
        content: `Image exceeds size limit (${byteSize} bytes > ${maxImageSize} bytes). Use max_image_size to increase.`,
        imageMetadata: { ...meta, mode: imageMode },
      };
    }

    // Magic byte validation: capture result and warn on mismatch
    const magicResult = validateMagicBytes(imgBuffer, ext);
    if (!magicResult.valid) {
      logger.debug('[read] image magic bytes mismatch', {
        path: resolvedPath,
        expected: ext,
        detected: magicResult.detectedType ?? 'unknown',
      });
    }

    // Get metadata (always, for all modes)
    const rawMeta = getImageMetadata(imgBuffer, ext);

    // MODE-AWARE SUPPRESSION
    // count_only and minimal: no image data
    if (format === 'count_only' || format === 'minimal') {
      projectIndex.upsertFile(resolvedPath, Math.ceil(byteSize / 4));
      return {
        path: fileInput.path,
        resolvedPath,
        lineCount: 0,
        byteSize,
        tokenEstimate: Math.ceil(byteSize / 4),
        extract,
        image: true,
        mediaType: getImageMediaType(ext) ?? 'application/octet-stream',
        imageMetadata: { ...rawMeta, mode: imageMode },
      };
    }

    // metadata-only mode: return metadata, no image data
    if (imageMode === 'metadata-only') {
      projectIndex.upsertFile(resolvedPath, Math.ceil(byteSize / 4));
      return {
        path: fileInput.path,
        resolvedPath,
        lineCount: 0,
        byteSize,
        tokenEstimate: 0,
        extract,
        image: true,
        mediaType: getImageMediaType(ext) ?? 'application/octet-stream',
        content: `Image: ${rawMeta.width ?? '?'}x${rawMeta.height ?? '?'} ${rawMeta.format}, ${humanSize(byteSize)}`,
        imageMetadata: { ...rawMeta, mode: imageMode },
      };
    }

    // For default/unoptimized/thumbnail-only: process the image
    let processedBuffer = imgBuffer;
    let mediaType = getImageMediaType(ext) ?? 'application/octet-stream';
    let resized = false;
    let converted = false;
    let originalFormat: string | undefined;

    // Convert non-portable formats (bmp, tiff, avif) to PNG
    const convertResult = await convertToPortableFormat(imgBuffer, ext);
    if (convertResult.converted) {
      processedBuffer = convertResult.buffer;
      mediaType = convertResult.mediaType;
      converted = true;
      originalFormat = convertResult.originalFormat;
    }

    // Resize based on mode
    const resizeTarget = RESIZE_TARGETS[imageMode];
    if (resizeTarget !== null) {
      const resizeResult = await resizeImage(processedBuffer, mediaType, resizeTarget);
      if (resizeResult.resized) {
        processedBuffer = resizeResult.buffer;
        resized = true;
        if (resizeResult.width) rawMeta.width = resizeResult.width;
        if (resizeResult.height) rawMeta.height = resizeResult.height;
      }
    }

    // Encode to base64
    const b64 = processedBuffer.toString('base64');
    const tokenEst = Math.ceil(processedBuffer.length / 4);
    projectIndex.upsertFile(resolvedPath, tokenEst);

    // Build text description for content field
    const desc = `Image: ${rawMeta.width ?? '?'}x${rawMeta.height ?? '?'} ${rawMeta.format}, ${humanSize(byteSize)}${resized ? ' (resized)' : ''}${converted ? ` (converted from ${originalFormat})` : ''}`;

    return {
      path: fileInput.path,
      resolvedPath,
      content: desc,
      lineCount: 0,
      byteSize,
      tokenEstimate: tokenEst,
      extract,
      image: true,
      mediaType,
      imageData: { base64: b64, mediaType },
      imageMetadata: { ...rawMeta, resized, converted, originalFormat, mode: imageMode },
    };
  }

  // --- ARCHIVE FILES ---
  if (isArchiveFile(ext)) {
    let archiveBuffer: Buffer;
    try {
      archiveBuffer = readFileSync(resolvedPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path: fileInput.path,
        resolvedPath,
        lineCount: 0,
        byteSize: 0,
        tokenEstimate: 0,
        extract,
        error: `Cannot read archive: ${message}`,
      };
    }
    const listing = listArchiveContents(resolvedPath, archiveBuffer, ext);
    const tokenEst = Math.ceil(listing.length / 4);
    projectIndex.upsertFile(resolvedPath, tokenEst);
    return {
      path: fileInput.path,
      resolvedPath,
      content: listing,
      lineCount: listing.split('\n').length,
      byteSize: archiveBuffer.length,
      tokenEstimate: tokenEst,
      extract,
      archive: true,
    };
  }

  // PDF files: extract text from stream sections
  if (isPdfFile(ext)) {
    let pdfRaw: string;
    let pdfByteSize = 0;
    try {
      const buf = readFileSync(resolvedPath);
      pdfByteSize = buf.length;
      pdfRaw = buf.toString('binary');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path: fileInput.path,
        resolvedPath,
        lineCount: 0,
        byteSize: 0,
        tokenEstimate: 0,
        extract,
        error: `Cannot read PDF: ${message}`,
      };
    }
    const pdfText = extractPdfText(pdfRaw, fileInput.pages);
    const tokenEst = Math.ceil(pdfByteSize / 4);
    projectIndex.upsertFile(resolvedPath, tokenEst);
    const pdfLines = pdfText.split('\n');
    return {
      path: fileInput.path,
      resolvedPath,
      content: format !== 'count_only' && format !== 'minimal' ? pdfText : undefined,
      lineCount: pdfLines.length,
      byteSize: pdfByteSize,
      tokenEstimate: tokenEst,
      extract,
    };
  }

  // Jupyter notebook files: parse and format as structured text
  if (isNotebookFile(resolvedPath)) {
    let nbRaw: string;
    let nbByteSize = 0;
    try {
      nbRaw = readFileSync(resolvedPath, 'utf-8');
      nbByteSize = Buffer.byteLength(nbRaw, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path: fileInput.path,
        resolvedPath,
        lineCount: 0,
        byteSize: 0,
        tokenEstimate: 0,
        extract,
        error: `Cannot read notebook: ${message}`,
      };
    }
    const formatted = formatNotebook(nbRaw);
    const tokenEst = Math.ceil(nbByteSize / 4);
    projectIndex.upsertFile(resolvedPath, tokenEst);
    const nbLines = formatted.split('\n');
    return {
      path: fileInput.path,
      resolvedPath,
      content: format !== 'count_only' && format !== 'minimal' ? formatted : undefined,
      lineCount: nbLines.length,
      byteSize: nbByteSize,
      tokenEstimate: tokenEst,
      extract,
    };
  }

  // Text file path: read file as Buffer once; check binary, then convert to string
  let fullBuf: Buffer;
  try {
    fullBuf = readFileSync(resolvedPath);
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

  if (isBinaryByContent(fullBuf)) {
    logger.debug('read tool: binary file skipped', { path: resolvedPath });
    return {
      path: fileInput.path,
      resolvedPath,
      lineCount: 0,
      byteSize: fullBuf.length,
      tokenEstimate: 0,
      extract,
      binary: true,
    };
  }

  // Convert the already-loaded buffer to string (no second disk read)
  let rawContent: string;
  try {
    rawContent = fullBuf.toString('utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('read tool: utf-8 decode failed', { path: resolvedPath, error: message });
    return {
      path: fileInput.path,
      resolvedPath,
      lineCount: 0,
      byteSize: fullBuf.length,
      tokenEstimate: 0,
      extract,
      error: `Cannot decode file as UTF-8: ${message}`,
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
        extractedContent = await extractOutline(resolvedPath, rawContent, lines, includeLineNumbers);
        break;

      case 'symbols':
        extractedContent = await extractSymbols(resolvedPath, rawContent, lines, includeLineNumbers);
        break;

      case 'ast':
        extractedContent = await extractAst(resolvedPath, rawContent, lines, includeLineNumbers);
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
      return await this._execute(args as unknown as ReadInput);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('read tool: unexpected error', { error: message });
      return { success: false, error: `Unexpected error: ${message}` };
    }
  }

  private async _execute(input: ReadInput): Promise<{ success: boolean; output: string }> {
    const globalExtract: ExtractMode = input.extract ?? 'content';
    const format: OutputFormat = input.output?.format ?? 'standard';
    const includeLineNumbers: boolean = input.output?.include_line_numbers ?? true;
    const maxPerItem: number | undefined = input.output?.max_per_item;
    const maxTokens: number | undefined = input.output?.max_tokens;
    const tokenBudget: number | undefined = input.token_budget;
    const page: number = Math.max(1, input.page ?? 1);
    const globalImageMode: ImageMode | undefined = input.image_mode;
    const globalMaxImageSize: number | undefined = input.max_image_size;

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
    const results: FileReadResult[] = await Promise.all(
      filesToProcess.map((f) =>
        readOneFile(f, globalExtract, format, includeLineNumbers, maxPerItem, this.fileCache, this.projectIndex, globalImageMode, globalMaxImageSize),
      ),
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

    // Collect images for multimodal output using destructuring to avoid mutation
    const images: NonNullable<ReadOutput['images']> = [];
    const fileResults: FileReadResult[] = results.map((r) => {
      if (r.imageData) {
        images.push({
          path: r.path,
          base64: r.imageData.base64,
          mediaType: r.imageData.mediaType,
          description: r.content ?? `Image: ${r.path}`,
        });
        const { imageData: _imageData, ...rest } = r;
        return rest;
      }
      return r;
    });

    // Compute summary
    const filesBinary = fileResults.filter((r) => r.binary === true).length;
    const filesErrored = fileResults.filter((r) => r.error !== undefined && !r.binary).length;
    const filesRead = fileResults.length - filesBinary - filesErrored;
    const totalLines = fileResults.reduce((s, r) => s + r.lineCount, 0);
    const totalTokens = fileResults.reduce((s, r) => s + r.tokenEstimate, 0);

    const output: ReadOutput = {
      success: true,
      summary: {
        files_read: filesRead,
        files_binary: filesBinary,
        files_errored: filesErrored,
        total_lines: totalLines,
        total_tokens: totalTokens,
      },
      ...(images.length > 0 ? { images } : {}),
    };

    if (format === 'count_only') {
      // Summary only — no file data
    } else if (format === 'minimal') {
      output.files = fileResults.map((r) => ({
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
      output.files = fileResults;
    }

    if (paginationInfo) {
      output.pagination = paginationInfo;
    }

    return { success: true, output: JSON.stringify(output) };
  }
}
