import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { logger } from '../../utils/logger.ts';
import { isNotebookFile } from '../../utils/notebook.ts';
import { FileStateCache } from '../../state/file-cache.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import { CodeIntelligence } from '../../intelligence/facade.ts';
import type { ImageMode } from './media.ts';
import {
  IMAGE_SIZE_LIMIT,
  RESIZE_TARGETS,
  isImageFile as isImageFileByExt,
  isArchiveFile,
  getImageMediaType,
  validateMagicBytes,
  getImageMetadata,
  isBinaryByContent,
  humanSize,
  resizeImage,
  convertToPortableFormat,
  listArchiveContents,
} from './media.ts';
import type { ReadFileInput, ExtractMode, OutputFormat } from './schema.ts';
import { formatContent, extractOutline, extractSymbols, extractAst } from './text.ts';

export interface FileReadResult {
  path: string;
  resolvedPath: string;
  content?: string;
  lineCount: number;
  byteSize: number;
  tokenEstimate: number;
  extract: ExtractMode;
  binary?: boolean;
  image?: boolean;
  mediaType?: string;
  error?: string;
  cache?: { status: 'miss' | 'unchanged' | 'modified' };
  metadata?: {
    encoding: string;
    sizeBytes: number;
    cacheStatus: string;
  };
  imageData?: { base64: string; mediaType: string };
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
  archive?: boolean;
}

export interface ReadOutput {
  success: boolean;
  error?: string;
  files?: FileReadResult[];
  images?: Array<{ path: string; base64: string; mediaType: string; description: string }>;
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

function isPdfFile(ext: string): boolean {
  return ext.toLowerCase() === '.pdf';
}

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
  if (pages) return `[pages: ${pages}]\n${joined}`;
  return joined;
}

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: Array<{ output_type: string; text?: string | string[]; data?: Record<string, string | string[]> }>;
}

interface NotebookJSON {
  cells: NotebookCell[];
}

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

export interface ReadExecutionContext {
  format: OutputFormat;
  includeLineNumbers: boolean;
  maxPerItem?: number;
  fileCache: FileStateCache;
  projectIndex: ProjectIndex;
  globalImageMode?: ImageMode;
  maxImageSize: number;
  codeIntelligence?: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>;
}

export interface ReadTarget {
  fileInput: ReadFileInput;
  resolvedPath: string;
  extract: ExtractMode;
}

function createReadBaseResult(target: ReadTarget, byteSize: number, tokenEstimate: number): FileReadResult {
  return {
    path: target.fileInput.path,
    resolvedPath: target.resolvedPath,
    lineCount: 0,
    byteSize,
    tokenEstimate,
    extract: target.extract,
  };
}

function createReadErrorResult(target: ReadTarget, message: string, byteSize = 0): FileReadResult {
  return {
    ...createReadBaseResult(target, byteSize, 0),
    error: message,
  };
}

function shouldIncludeContent(format: OutputFormat): boolean {
  return format !== 'count_only' && format !== 'minimal';
}

function getImageMode(fileInput: ReadFileInput, context: ReadExecutionContext): ImageMode {
  return fileInput.image_mode ?? context.globalImageMode ?? 'default';
}

async function readImageFile(
  target: ReadTarget,
  context: ReadExecutionContext,
  imageMode: ImageMode,
  maxImageSize: number,
): Promise<FileReadResult> {
  let imgBuffer: Buffer;
  try {
    imgBuffer = readFileSync(target.resolvedPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createReadErrorResult(target, `Cannot read image: ${message}`);
  }

  const byteSize = imgBuffer.length;
  if (byteSize > maxImageSize) {
    const meta = getImageMetadata(imgBuffer, extname(target.resolvedPath));
    return {
      ...createReadBaseResult(target, byteSize, 0),
      image: true,
      mediaType: getImageMediaType(extname(target.resolvedPath)) ?? 'application/octet-stream',
      content: `Image exceeds size limit (${byteSize} bytes > ${maxImageSize} bytes). Use max_image_size to increase.`,
      imageMetadata: { ...meta, mode: imageMode },
    };
  }

  const magicResult = validateMagicBytes(imgBuffer, extname(target.resolvedPath));
  if (!magicResult.valid) {
    logger.debug('[read] image magic bytes mismatch', {
      path: target.resolvedPath,
      expected: extname(target.resolvedPath),
      detected: magicResult.detectedType ?? 'unknown',
    });
  }

  const rawMeta = getImageMetadata(imgBuffer, extname(target.resolvedPath));
  if (!shouldIncludeContent(context.format)) {
    context.projectIndex.upsertFile(target.resolvedPath, Math.ceil(byteSize / 4));
    return {
      ...createReadBaseResult(target, byteSize, Math.ceil(byteSize / 4)),
      image: true,
      mediaType: getImageMediaType(extname(target.resolvedPath)) ?? 'application/octet-stream',
      imageMetadata: { ...rawMeta, mode: imageMode },
    };
  }

  if (imageMode === 'metadata-only') {
    context.projectIndex.upsertFile(target.resolvedPath, Math.ceil(byteSize / 4));
    return {
      ...createReadBaseResult(target, byteSize, 0),
      image: true,
      mediaType: getImageMediaType(extname(target.resolvedPath)) ?? 'application/octet-stream',
      content: `Image: ${rawMeta.width ?? '?'}x${rawMeta.height ?? '?'} ${rawMeta.format}, ${humanSize(byteSize)}`,
      imageMetadata: { ...rawMeta, mode: imageMode },
    };
  }

  let processedBuffer = imgBuffer;
  let mediaType = getImageMediaType(extname(target.resolvedPath)) ?? 'application/octet-stream';
  let resized = false;
  let converted = false;
  let originalFormat: string | undefined;

  const convertResult = await convertToPortableFormat(imgBuffer, extname(target.resolvedPath));
  if (convertResult.converted) {
    processedBuffer = convertResult.buffer;
    mediaType = convertResult.mediaType;
    converted = true;
    originalFormat = convertResult.originalFormat;
  }

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

  const b64 = processedBuffer.toString('base64');
  const tokenEst = Math.ceil(processedBuffer.length / 4);
  context.projectIndex.upsertFile(target.resolvedPath, tokenEst);

  const desc = `Image: ${rawMeta.width ?? '?'}x${rawMeta.height ?? '?'} ${rawMeta.format}, ${humanSize(byteSize)}${resized ? ' (resized)' : ''}${converted ? ` (converted from ${originalFormat})` : ''}`;
  return {
    ...createReadBaseResult(target, byteSize, tokenEst),
    content: desc,
    image: true,
    mediaType,
    imageData: { base64: b64, mediaType },
    imageMetadata: { ...rawMeta, resized, converted, originalFormat, mode: imageMode },
  };
}

function readArchiveFile(target: ReadTarget, context: ReadExecutionContext): FileReadResult {
  let archiveBuffer: Buffer;
  try {
    archiveBuffer = readFileSync(target.resolvedPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createReadErrorResult(target, `Cannot read archive: ${message}`);
  }

  const listing = listArchiveContents(target.resolvedPath, archiveBuffer, extname(target.resolvedPath));
  const tokenEst = Math.ceil(listing.length / 4);
  context.projectIndex.upsertFile(target.resolvedPath, tokenEst);
  return { ...createReadBaseResult(target, archiveBuffer.length, tokenEst), content: listing, lineCount: listing.split('\n').length, archive: true };
}

function readPdfFile(target: ReadTarget, context: ReadExecutionContext, fileInput: ReadFileInput): FileReadResult {
  let pdfRaw: string;
  let pdfByteSize = 0;
  try {
    const buf = readFileSync(target.resolvedPath);
    pdfByteSize = buf.length;
    pdfRaw = buf.toString('binary');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createReadErrorResult(target, `Cannot read PDF: ${message}`);
  }

  const pdfText = extractPdfText(pdfRaw, fileInput.pages);
  const tokenEst = Math.ceil(pdfByteSize / 4);
  context.projectIndex.upsertFile(target.resolvedPath, tokenEst);
  const pdfLines = pdfText.split('\n');
  return { ...createReadBaseResult(target, pdfByteSize, tokenEst), content: shouldIncludeContent(context.format) ? pdfText : undefined, lineCount: pdfLines.length };
}

function readNotebookFile(target: ReadTarget, context: ReadExecutionContext): FileReadResult {
  let nbRaw: string;
  let nbByteSize = 0;
  try {
    nbRaw = readFileSync(target.resolvedPath, 'utf-8');
    nbByteSize = Buffer.byteLength(nbRaw, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createReadErrorResult(target, `Cannot read notebook: ${message}`);
  }

  const formatted = formatNotebook(nbRaw);
  const tokenEst = Math.ceil(nbByteSize / 4);
  context.projectIndex.upsertFile(target.resolvedPath, tokenEst);
  const nbLines = formatted.split('\n');
  return { ...createReadBaseResult(target, nbByteSize, tokenEst), content: shouldIncludeContent(context.format) ? formatted : undefined, lineCount: nbLines.length };
}

async function readTextFile(target: ReadTarget, context: ReadExecutionContext, fileInput: ReadFileInput): Promise<FileReadResult> {
  let fullBuf: Buffer;
  try {
    fullBuf = readFileSync(target.resolvedPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('read tool: file read failed', { path: target.resolvedPath, error: message });
    return createReadErrorResult(target, `Cannot read file: ${message}`);
  }

  if (isBinaryByContent(fullBuf)) {
    logger.debug('read tool: binary file skipped', { path: target.resolvedPath });
    return { ...createReadBaseResult(target, fullBuf.length, 0), binary: true };
  }

  let rawContent: string;
  try {
    rawContent = fullBuf.toString('utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('read tool: utf-8 decode failed', { path: target.resolvedPath, error: message });
    return createReadErrorResult(target, `Cannot decode file as UTF-8: ${message}`, fullBuf.length);
  }

  const cacheResult = fileInput.force ? { status: 'miss' as const } : context.fileCache.lookup(target.resolvedPath);
  context.fileCache.update(target.resolvedPath, rawContent, { tool: 'read' });

  const byteSize = Buffer.byteLength(rawContent, 'utf-8');
  const tokenEstimate = Math.ceil(byteSize / 4);
  context.projectIndex.upsertFile(target.resolvedPath, tokenEstimate);

  const lines = rawContent.split('\n');
  const lineCount = lines.length;

  let extractedContent: string | undefined;
  if (shouldIncludeContent(context.format)) {
    switch (target.extract) {
      case 'content':
      case 'lines':
        extractedContent = formatContent(lines, context.includeLineNumbers, fileInput.range, context.maxPerItem);
        break;
      case 'outline':
        extractedContent = await extractOutline(target.resolvedPath, rawContent, lines, context.includeLineNumbers, context.codeIntelligence);
        break;
      case 'symbols':
        extractedContent = await extractSymbols(target.resolvedPath, rawContent, lines, context.includeLineNumbers, context.codeIntelligence);
        break;
      case 'ast':
        extractedContent = await extractAst(target.resolvedPath, rawContent, lines, context.includeLineNumbers, context.codeIntelligence);
        break;
      default:
        extractedContent = formatContent(lines, context.includeLineNumbers, fileInput.range, context.maxPerItem);
    }
  }

  const result: FileReadResult = {
    ...createReadBaseResult(target, byteSize, tokenEstimate),
    content: extractedContent,
    lineCount,
    cache: { status: cacheResult.status },
  };

  if (context.format === 'verbose') {
    result.metadata = { encoding: 'utf-8', sizeBytes: byteSize, cacheStatus: cacheResult.status };
  }

  return result;
}

export async function readOneFile(
  fileInput: ReadFileInput,
  globalExtract: ExtractMode,
  format: OutputFormat,
  includeLineNumbers: boolean,
  maxPerItem: number | undefined,
  fileCache: FileStateCache,
  projectIndex: ProjectIndex,
  globalImageMode?: ImageMode,
  globalMaxImageSize?: number,
  codeIntelligence?: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>,
): Promise<FileReadResult> {
  const extract: ExtractMode = fileInput.extract ?? globalExtract;

  let resolvedPath: string;
  try {
    resolvedPath = resolveAndValidatePath(fileInput.path, projectIndex.baseDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('read tool: path validation failed', { path: fileInput.path, error: message });
    return createReadErrorResult({ fileInput, resolvedPath: fileInput.path, extract }, message);
  }

  const target: ReadTarget = { fileInput, resolvedPath, extract };
  const context: ReadExecutionContext = {
    format,
    includeLineNumbers,
    maxPerItem,
    fileCache,
    projectIndex,
    globalImageMode,
    maxImageSize: globalMaxImageSize ?? IMAGE_SIZE_LIMIT,
    codeIntelligence,
  };

  const ext = extname(resolvedPath);
  const imageMode = getImageMode(fileInput, context);

  if (isImageFileByExt(ext)) return readImageFile(target, context, imageMode, context.maxImageSize);
  if (isArchiveFile(ext)) return readArchiveFile(target, context);
  if (isPdfFile(ext)) return readPdfFile(target, context, fileInput);
  if (isNotebookFile(resolvedPath)) return readNotebookFile(target, context);
  return readTextFile(target, context, fileInput);
}

export function paginateFiles(files: ReadFileInput[], tokenBudget: number, projectRoot: string): Array<number[]> {
  const pages: Array<number[]> = [];
  let currentPage: number[] = [];
  let currentTokens = 0;

  for (let i = 0; i < files.length; i++) {
    let est = 0;
    try {
      const resolved = resolveAndValidatePath(files[i].path, projectRoot);
      est = Math.ceil(statSync(resolved).size / 4);
    } catch {
      est = 0;
    }

    if (est > tokenBudget && currentPage.length === 0) {
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
