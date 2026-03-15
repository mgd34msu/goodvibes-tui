import { existsSync, mkdirSync, renameSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { WRITE_SCHEMA, type WriteInput, type WriteFileInput, type WriteMode } from './schema.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { FileStateCache } from '../../state/file-cache.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import { logger } from '../../utils/logger.ts';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface FileWriteResult {
  path: string;
  resolved_path: string;
  bytes_written: number;
  mode_applied: WriteMode;
  backup_path?: string;
  /** true if this was a dry-run entry */
  would_write?: boolean;
  /** decoded content — used internally to avoid double resolveContent call */
  _content?: string;
}

interface WriteOutput {
  files_written: number;
  bytes_written: number;
  files?: FileWriteResult[];
  dry_run?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode content from either the raw string or base64 field.
 * Returns the decoded string content.
 */
function resolveContent(fileInput: WriteFileInput): string {
  if (fileInput.content_base64 !== undefined) {
    return Buffer.from(fileInput.content_base64, 'base64').toString('utf-8');
  }
  return fileInput.content ?? '';
}

/**
 * Build a backup destination path inside .goodvibes/.backups/.
 * e.g. src/foo.ts -> <projectRoot>/.goodvibes/.backups/src/foo.ts.1700000000000
 */
function buildBackupPath(resolvedPath: string, projectRoot: string): string {
  const rel = relative(projectRoot, resolvedPath);
  return join(projectRoot, '.goodvibes', '.backups', `${rel}.${Date.now()}`);
}

/**
 * Atomically write content to a file.
 * Writes to a temp file first, then renames to the target path.
 */
function atomicWrite(targetPath: string, content: string, encoding: BufferEncoding = 'utf-8'): void {
  const rand = randomBytes(4).toString('hex');
  const tmpPath = `${targetPath}.tmp.${rand}`;
  try {
    writeFileSync(tmpPath, content, { encoding });
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Clean up temp file if rename failed
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core write logic
// ---------------------------------------------------------------------------

/**
 * Process a single file write entry.
 * Returns null if successful (mutates results array) or a string error message.
 */
function processSingleWrite(
  fileInput: WriteFileInput,
  projectRoot: string,
  dryRun: boolean,
): { ok: true; result: FileWriteResult } | { ok: false; error: string } {
  // Resolve and validate path
  let resolvedPath: string;
  try {
    resolvedPath = resolveAndValidatePath(fileInput.path);
  } catch (err) {
    return { ok: false, error: `Path error for '${fileInput.path}': ${err instanceof Error ? err.message : String(err)}` };
  }

  const mode: WriteMode = fileInput.mode ?? 'fail_if_exists';

  // Validate encoding
  const VALID_ENCODINGS = new Set(['utf-8', 'utf8', 'ascii', 'latin1', 'base64', 'hex', 'binary']);
  if (fileInput.encoding && !VALID_ENCODINGS.has(fileInput.encoding)) {
    return {
      ok: false,
      error: `Invalid encoding: '${fileInput.encoding}'. Valid: ${[...VALID_ENCODINGS].join(', ')}`,
    };
  }
  const encoding: BufferEncoding = (fileInput.encoding as BufferEncoding) ?? 'utf-8';

  // Validate base64 input
  if (fileInput.content_base64 !== undefined) {
    const b64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!b64Regex.test(fileInput.content_base64.replace(/\s/g, ''))) {
      return {
        ok: false,
        error: `Invalid base64 content for '${fileInput.path}': content is not valid base64.`,
      };
    }
  }

  const content = resolveContent(fileInput);
  const byteSize = Buffer.byteLength(content, encoding);

  // Check existence
  const alreadyExists = existsSync(resolvedPath);

  if (alreadyExists && mode === 'fail_if_exists') {
    return {
      ok: false,
      error: `File already exists: '${fileInput.path}'. Use mode 'overwrite' or 'backup' to replace it.`,
    };
  }

  const result: FileWriteResult = {
    path: fileInput.path,
    resolved_path: resolvedPath,
    bytes_written: byteSize,
    mode_applied: mode,
    _content: content,
  };

  if (dryRun) {
    result.would_write = true;
    if (alreadyExists && mode === 'backup') {
      result.backup_path = buildBackupPath(resolvedPath, projectRoot);
    }
    return { ok: true, result };
  }

  // Backup if needed
  if (alreadyExists && mode === 'backup') {
    const backupPath = buildBackupPath(resolvedPath, projectRoot);
    try {
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(resolvedPath, backupPath);
      result.backup_path = backupPath;
    } catch (err) {
      return {
        ok: false,
        error: `Backup failed for '${fileInput.path}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Auto-create parent directories
  try {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to create parent directories for '${fileInput.path}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Atomic write
  try {
    atomicWrite(resolvedPath, content, encoding);
  } catch (err) {
    return {
      ok: false,
      error: `Write failed for '${fileInput.path}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Format output
// ---------------------------------------------------------------------------

function formatOutput(
  results: FileWriteResult[],
  errors: string[],
  verbosity: string,
  dryRun: boolean,
): WriteOutput {
  const totalBytes = results.reduce((acc, r) => acc + r.bytes_written, 0);
  const base: WriteOutput = {
    files_written: results.length,
    bytes_written: totalBytes,
  };

  if (dryRun) {
    base.dry_run = true;
  }

  if (verbosity === 'count_only') {
    return base;
  }

  if (verbosity === 'minimal') {
    base.files = results.map(({ _content: _, ...r }) => ({
      path: r.path,
      resolved_path: r.resolved_path,
      bytes_written: r.bytes_written,
      mode_applied: r.mode_applied,
      ...(r.backup_path ? { backup_path: r.backup_path } : {}),
      ...(r.would_write ? { would_write: r.would_write } : {}),
    }));
    return base;
  }

  // standard and verbose both include full results (strip internal _content field)
  base.files = results.map(({ _content: _, ...r }) => r);
  return base;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createWriteTool(options?: {
  fileCache?: FileStateCache;
  projectIndex?: ProjectIndex;
}): Tool {
  const definition: ToolDefinition = {
    name: 'write',
    description:
      'Write one or more files to disk. Supports batch writes, automatic parent directory creation, ' +
      'and three overwrite modes: fail_if_exists (default), overwrite, backup. ' +
      'Use content_base64 for content containing special characters.',
    parameters: WRITE_SCHEMA as Record<string, unknown>,
  };

  return {
    definition,
    async execute(args: Record<string, unknown>) {
      const input = args as WriteInput;
      const verbosity = input.verbosity ?? 'count_only';
      const dryRun = input.dry_run ?? false;
      const projectRoot = resolve(process.cwd());

      if (!input.files || !Array.isArray(input.files) || input.files.length === 0) {
        return {
          success: false,
          error: "Invalid input: 'files' must be a non-empty array.",
        };
      }

      const results: FileWriteResult[] = [];
      const errors: string[] = [];

      for (const fileInput of input.files) {
        if (!fileInput.path || typeof fileInput.path !== 'string') {
          errors.push(`Invalid file entry: missing or invalid 'path' field.`);
          continue;
        }

        const outcome = processSingleWrite(fileInput, projectRoot, dryRun);

        if (!outcome.ok) {
          errors.push(outcome.error);
          logger.debug('write tool: file write failed', { path: fileInput.path, error: outcome.error });
          continue;
        }

        results.push(outcome.result);

        // State integration — only for real writes, not dry runs
        if (!dryRun) {
          const content = outcome.result._content ?? '';
          const byteSize = Buffer.byteLength(content, 'utf-8');
          const tokenEstimate = Math.ceil(byteSize / 4);

          if (options?.fileCache) {
            try {
              options.fileCache.update(outcome.result.resolved_path, content, { tool: 'write' });
            } catch (err) {
              logger.debug('write tool: fileCache.update failed (non-fatal)', {
                path: outcome.result.resolved_path,
                error: String(err),
              });
            }
          }

          if (options?.projectIndex) {
            try {
              options.projectIndex.upsertFile(outcome.result.resolved_path, tokenEstimate);
            } catch (err) {
              logger.debug('write tool: projectIndex.upsertFile failed (non-fatal)', {
                path: outcome.result.resolved_path,
                error: String(err),
              });
            }
          }

          logger.debug('write tool: wrote file', {
            path: outcome.result.resolved_path,
            bytes: byteSize,
            mode: outcome.result.mode_applied,
          });
        }
      }

      if (errors.length > 0 && results.length === 0) {
        return {
          success: false,
          error: errors.join('\n'),
        };
      }

      const output = formatOutput(results, errors, verbosity, dryRun);

      // Attach partial errors to output if some succeeded and some failed
      const finalOutput: Record<string, unknown> = { ...output };
      if (errors.length > 0) {
        finalOutput.errors = errors;
      }

      return {
        success: errors.length === 0,
        output: JSON.stringify(finalOutput),
      };
    },
  };
}
