import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { READ_TOOL_SCHEMA } from './schema.ts';
import type { ReadInput, ReadFileInput, ExtractMode, OutputFormat } from './schema.ts';
import { FileStateCache } from '../../state/file-cache.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import { CodeIntelligence } from '../../intelligence/facade.ts';
import { logger } from '../../utils/logger.ts';
import {
  paginateFiles,
  readOneFile,
  type FileReadResult,
  type ReadOutput,
} from './file-readers.ts';

export type { FileReadResult, ReadOutput } from './file-readers.ts';

export class ReadTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'read',
    description:
      'Read one or more files from disk. Supports extract modes (content, outline, symbols, lines, ast)'
      + ' for token-efficient reading, per-file caching, pagination via token_budget, and batch processing.',
    parameters: READ_TOOL_SCHEMA as unknown as Record<string, unknown>,
    sideEffects: ['read_fs'],
    concurrency: 'parallel',
    supportsProgress: true,
  };

  private readonly fileCache: FileStateCache;
  private readonly projectIndex: ProjectIndex;
  private readonly codeIntelligence: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>;

  constructor(
    projectIndex: ProjectIndex,
    fileCache?: FileStateCache,
    codeIntelligence?: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>,
  ) {
    this.fileCache = fileCache ?? new FileStateCache();
    this.projectIndex = projectIndex;
    this.codeIntelligence = codeIntelligence ?? new CodeIntelligence({});
  }

  async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
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
    const globalImageMode = input.image_mode;
    const globalMaxImageSize = input.max_image_size;

    const allFiles = input.files;
    let filesToProcess: ReadFileInput[] = allFiles;
    let paginationInfo: ReadOutput['pagination'] | undefined;

    if (tokenBudget !== undefined) {
      const pages = paginateFiles(allFiles, tokenBudget, this.projectIndex.baseDir);
      const totalPages = Math.max(1, pages.length);
      const pageIdx = Math.min(page - 1, totalPages - 1);
      const pageIndices = pages[pageIdx] ?? [];

      filesToProcess = pageIndices.map((i) => allFiles[i]);

      const deliveredSet = new Set(pages.slice(0, pageIdx + 1).flat());
      const pendingFiles = allFiles
        .map((f, i) => ({ f, i }))
        .filter(({ i }) => !deliveredSet.has(i))
        .map(({ f }) => f.path);

      paginationInfo = { page, total_pages: totalPages, pending_files: pendingFiles };
    }

    const results: FileReadResult[] = await Promise.all(
      filesToProcess.map((f) =>
        readOneFile(
          f,
          globalExtract,
          format,
          includeLineNumbers,
          maxPerItem,
          this.fileCache,
          this.projectIndex,
          globalImageMode,
          globalMaxImageSize,
          this.codeIntelligence,
        ),
      ),
    );

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
      // summary only
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
    } else if (format === 'standard' || format === 'verbose') {
      output.files = fileResults;
    }

    if (paginationInfo) {
      output.pagination = paginationInfo;
    }

    return { success: true, output: JSON.stringify(output) };
  }
}
