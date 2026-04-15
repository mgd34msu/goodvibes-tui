import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Tool, ToolDefinition } from '@pellux/goodvibes-sdk/platform/types/tools';
import { WRITE_SCHEMA, type WriteInput, type WriteFileInput, type WriteMode } from '@pellux/goodvibes-sdk/platform/tools/write/schema';
import { runValidators, formatValidatorFailure, type ValidatorName } from '@pellux/goodvibes-sdk/platform/tools/shared/validators';
import { FileStateCache } from '@pellux/goodvibes-sdk/platform/state/file-cache';
import { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state/project-index';
import { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state/file-undo';
import type { ConfigManager } from '../../config/manager.ts';
import type { ToolLLM } from '../../config/tool-llm.ts';
import { AutoHealer } from '../shared/auto-heal.ts';
import { isNotebookFile } from '@pellux/goodvibes-sdk/platform/utils/notebook';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions/change-tracker';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

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

function nearestExistingPath(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.includes('/..') && !rel.startsWith('/'));
}

function resolveAndValidatePath(inputPath: string, projectRoot: string): string {
  const root = realpathSync(resolve(projectRoot));
  const resolved = resolve(root, inputPath);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || rel.includes('/..')) {
    throw new Error(`Path '${inputPath}' is outside the project root`);
  }
  const existingPath = nearestExistingPath(resolved);
  const realExistingPath = realpathSync(existingPath);
  if (!isInsideRoot(root, realExistingPath)) {
    throw new Error(`Path '${inputPath}' is outside the project root`);
  }
  if (existsSync(resolved)) {
    const realTargetPath = realpathSync(resolved);
    if (!isInsideRoot(root, realTargetPath)) {
      throw new Error(`Path '${inputPath}' is outside the project root`);
    }
  }
  return resolved;
}

/** Module-level constant — avoids re-allocating the Set on every validation call. */
const VALID_CELL_TYPES = new Set(['code', 'markdown', 'raw']);

/**
 * Validate that a string contains well-formed Jupyter notebook JSON.
 * Checks required top-level fields and per-cell structure.
 * On success, returns the parsed notebook object to avoid a redundant JSON.parse at the call site.
 */
function validateNotebookContent(
  content: string,
): { valid: true; notebook: Record<string, unknown> } | { valid: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { valid: false, error: `Invalid JSON: ${summarizeError(err)}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, error: 'Notebook must be a JSON object' };
  }

  const nb = parsed as Record<string, unknown>;

  if (!('nbformat' in nb) || typeof nb['nbformat'] !== 'number') {
    return { valid: false, error: "Notebook must have a numeric 'nbformat' field" };
  }

  if (!('cells' in nb) || !Array.isArray(nb['cells'])) {
    return { valid: false, error: "Notebook must have a 'cells' array" };
  }

  for (let i = 0; i < (nb['cells'] as unknown[]).length; i++) {
    const cell = (nb['cells'] as unknown[])[i];
    if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) {
      return { valid: false, error: `Cell ${i} must be an object` };
    }
    const c = cell as Record<string, unknown>;

    if (!('cell_type' in c) || !VALID_CELL_TYPES.has(c['cell_type'] as string)) {
      return { valid: false, error: `Cell ${i} has missing or invalid 'cell_type' (must be 'code', 'markdown', or 'raw')` };
    }

    if (!('source' in c) || (typeof c['source'] !== 'string' && !Array.isArray(c['source']))) {
      return { valid: false, error: `Cell ${i} must have a 'source' field (string or array)` };
    }

    if (c['cell_type'] === 'code') {
      if ('outputs' in c && !Array.isArray(c['outputs'])) {
        return { valid: false, error: `Cell ${i} 'outputs' must be an array` };
      }
      if ('execution_count' in c && c['execution_count'] !== null && typeof c['execution_count'] !== 'number') {
        return { valid: false, error: `Cell ${i} 'execution_count' must be a number or null` };
      }
    }
  }

  return { valid: true, notebook: nb };
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
    resolvedPath = resolveAndValidatePath(fileInput.path, projectRoot);
  } catch (err) {
    return { ok: false, error: `Path error for '${fileInput.path}': ${summarizeError(err)}` };
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

  let content = resolveContent(fileInput);

  // Notebook validation and normalization
  if (isNotebookFile(resolvedPath)) {
    const validation = validateNotebookContent(content);
    if (!validation.valid) {
      return {
        ok: false,
        error: `Invalid notebook content for '${fileInput.path}': ${validation.error}`,
      };
    }
    // Re-serialize with consistent formatting (1-space indent, trailing newline).
    // Use the already-parsed notebook from the validator to avoid a redundant JSON.parse.
    content = JSON.stringify(validation.notebook, null, 1) + '\n';
  }

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
        error: `Backup failed for '${fileInput.path}': ${summarizeError(err)}`,
      };
    }
  }

  // Auto-create parent directories
  try {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to create parent directories for '${fileInput.path}': ${summarizeError(err)}`,
    };
  }

  // Atomic write
  try {
    atomicWrite(resolvedPath, content, encoding);
  } catch (err) {
    return {
      ok: false,
      error: `Write failed for '${fileInput.path}': ${summarizeError(err)}`,
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
  projectRoot: string;
  fileCache?: FileStateCache;
  projectIndex?: ProjectIndex;
  fileUndoManager?: FileUndoManager;
  configManager?: Pick<ConfigManager, 'get'>;
  toolLLM?: Pick<ToolLLM, 'chat'>;
  changeTracker?: Pick<SessionChangeTracker, 'recordChange'>;
}): Tool {
  if (typeof options?.projectRoot !== 'string' || options.projectRoot.trim().length === 0) {
    throw new Error('createWriteTool requires projectRoot');
  }
  const projectRoot = options.projectRoot;
  const definition: ToolDefinition = {
    name: 'write',
    description:
      'Write one or more files to disk. Supports batch writes, automatic parent directory creation, ' +
      'and three overwrite modes: fail_if_exists (default), overwrite, backup. ' +
      'Use content_base64 for content containing special characters.',
    parameters: WRITE_SCHEMA as Record<string, unknown>,
    sideEffects: ['write_fs'],
    concurrency: 'serial',
    supportsProgress: true,
  };

  return {
    definition,
    async execute(args: Record<string, unknown>) {
      // Runtime validation before cast: ensure required fields exist.
      if (!args['files'] || !Array.isArray(args['files']) || (args['files'] as unknown[]).length === 0) {
        return {
          success: false,
          error: "Invalid input: 'files' must be a non-empty array.",
        };
      }
      const input = args as unknown as WriteInput;
      const verbosity = input.verbosity ?? 'count_only';
      const dryRun = input.dry_run ?? false;

      const results: FileWriteResult[] = [];
      const errors: string[] = [];
      const transactionMode = input.transaction?.mode ?? 'none';
      // Snapshots for atomic rollback: map from resolvedPath -> original content (null = new file)
      const snapshots = new Map<string, string | null>();

      for (const fileInput of input.files) {
        if (!fileInput.path || typeof fileInput.path !== 'string') {
          errors.push(`Invalid file entry: missing or invalid 'path' field.`);
          continue;
        }

        // Capture before-content for undo and atomic transaction snapshots BEFORE the write happens
        let beforeContent: string | null = null;
        if (!dryRun && fileInput.path) {
          let resolvedForUndo: string | undefined;
          try {
            resolvedForUndo = resolveAndValidatePath(fileInput.path, projectRoot);
          } catch {
            resolvedForUndo = undefined;
          }
          if (resolvedForUndo && existsSync(resolvedForUndo)) {
            try {
              beforeContent = readFileSync(resolvedForUndo, 'utf-8');
            } catch {
              beforeContent = null;
            }
          }
          // Store snapshot for atomic transaction rollback
          if (transactionMode === 'atomic' && resolvedForUndo && !snapshots.has(resolvedForUndo)) {
            snapshots.set(resolvedForUndo, beforeContent);
          }
        }

        const outcome = processSingleWrite(fileInput, projectRoot, dryRun);

        if (!outcome.ok) {
          errors.push(outcome.error);
          logger.debug('write tool: file write failed', { path: fileInput.path, error: outcome.error });

          // Atomic transaction: rollback all successfully written files
          if (transactionMode === 'atomic' && results.length > 0) {
            const rolledBack: string[] = [];
            for (const written of results) {
              try {
                const snapshot = snapshots.get(written.resolved_path);
                if (snapshot === null || snapshot === undefined) {
                  // File was new - delete it
                  unlinkSync(written.resolved_path);
                } else {
                  // File existed before - restore original
                  atomicWrite(written.resolved_path, snapshot);
                }
                rolledBack.push(written.path);
              } catch (rollbackErr) {
                logger.debug('write tool: atomic rollback failed (non-fatal)', {
                  path: written.resolved_path,
                  error: String(rollbackErr),
                });
              }
            }
            const failMsg = `Atomic transaction failed on '${fileInput.path}': ${outcome.error}. Rolled back ${rolledBack.length} file(s): ${rolledBack.join(', ')}`;
            return {
              success: false,
              error: failMsg,
            };
          }

          continue;
        }

        results.push(outcome.result);

        // State integration — only for real writes, not dry runs
        if (!dryRun) {
          let content = outcome.result._content ?? '';

          // Auto-heal: if file is JS/TS and auto-heal is enabled, run syntax check
          if (options?.configManager?.get('tools.autoHeal')) {
            const ext = extname(outcome.result.resolved_path).toLowerCase();
            const isJsTs = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext);
            if (isJsTs) {
              try {
                const loader = (ext === '.mjs' || ext === '.cjs') ? 'js' : ext.slice(1) as 'ts' | 'tsx' | 'js' | 'jsx';
                const transpiler = new Bun.Transpiler({ loader });
                transpiler.transformSync(content);
              } catch (syntaxErr) {
                const syntaxErrors = [String(syntaxErr)];
                const healResult = options.toolLLM && options.configManager
                  ? await new AutoHealer(options.configManager, options.toolLLM).heal(outcome.result.resolved_path, content, syntaxErrors)
                  : { healed: false, content };
                if (healResult.healed) {
                  logger.debug('write tool: auto-heal succeeded', {
                    path: outcome.result.resolved_path,
                    method: healResult.method,
                  });
                  content = healResult.content;
                  // Rewrite file with healed content
                  try {
                    atomicWrite(outcome.result.resolved_path, content);
                  } catch (writeErr) {
                    logger.debug('write tool: auto-heal rewrite failed (non-fatal)', {
                      path: outcome.result.resolved_path,
                      error: String(writeErr),
                    });
                  }
                }
              }
            }
          }

          const byteSize = Buffer.byteLength(content, 'utf-8');
          const tokenEstimate = Math.ceil(byteSize / 4);

          if (options?.fileCache) {
            try {
              options.fileCache.update(outcome.result.resolved_path, content, { tool: 'write' });
            } catch (err) {
              logger.debug('write tool: fileCache.update failed (non-fatal)', {
                path: outcome.result.resolved_path,
                error: summarizeError(err),
              });
            }
          }

          if (options?.projectIndex) {
            try {
              options.projectIndex.upsertFile(outcome.result.resolved_path, tokenEstimate);
            } catch (err) {
              logger.debug('write tool: projectIndex.upsertFile failed (non-fatal)', {
                path: outcome.result.resolved_path,
                error: summarizeError(err),
              });
            }
          }

          // Snapshot for /undo file support
          if (options?.fileUndoManager) {
            try {
              options.fileUndoManager.snapshot({
                path: outcome.result.resolved_path,
                beforeContent,
                afterContent: content,
                tool: 'write',
              });
            } catch (err) {
              logger.debug('write tool: fileUndoManager.snapshot failed (non-fatal)', {
                path: outcome.result.resolved_path,
                error: summarizeError(err),
              });
            }
          }

          logger.debug('write tool: wrote file', {
            path: outcome.result.resolved_path,
            bytes: byteSize,
            mode: outcome.result.mode_applied,
          });
          // Track for /diff session change view
          options?.changeTracker?.recordChange(outcome.result.resolved_path);
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

      // Post-write validation — run after all files are written, even if partial errors occurred
      if (!dryRun && results.length > 0 && input.validate?.after && input.validate.after.length > 0) {
        const validatorNames = input.validate.after as ValidatorName[];
        logger.debug('write tool: running post-write validators', { validators: validatorNames });
        try {
          const failures = await runValidators(validatorNames, projectRoot);
          if (failures.length > 0) {
            finalOutput.validation_failures = failures.map((f) => ({
              validator: f.validator,
              passed: false,
              exit_code: f.exitCode,
              stdout: f.stdout.trim(),
              stderr: f.stderr.trim(),
              message: formatValidatorFailure(f),
            }));
            logger.debug('write tool: post-write validators failed', {
              count: failures.length,
              validators: failures.map((f) => f.validator),
            });
          } else {
            finalOutput.validation_passed = true;
          }
        } catch (validationErr) {
          logger.debug('write tool: validator execution error (non-fatal)', { error: String(validationErr) });
          finalOutput.validation_error = String(validationErr);
        }
      }

      return {
        success: errors.length === 0,
        output: JSON.stringify(finalOutput),
      };
    },
  };
}
