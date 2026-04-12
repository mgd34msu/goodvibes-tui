import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { logger } from '../../utils/logger.ts';
import type { SessionChangeTracker } from '../../sessions/change-tracker.ts';
import { FileUndoManager } from '../../state/file-undo.ts';
import { FileStateCache, unifiedDiff } from '../../state/file-cache.ts';
import type { ConfigManager } from '../../config/manager.ts';
import type { ToolLLM } from '../../config/tool-llm.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { editSchema } from './schema.ts';
import { AutoHealer } from '../shared/auto-heal.ts';
import { ImportGraph } from '../../intelligence/index.ts';
import {
  buildFailedEditResult,
  classifyEditFailure,
  computeAstEdit,
  computeAstPatternEdit,
  computeSingleEdit,
} from './match.ts';
import type {
  EditInput,
  EditItem,
  EditResult,
  EditResultStatus,
  ValidatorName,
} from './types.ts';
import { executeNotebookEdit } from './notebook.ts';

const DIFF_TRUNCATE_THRESHOLD = 5000;
const DIFF_PREVIEW_LENGTH = 500;
const VALIDATOR_COMMANDS: Record<ValidatorName, string[]> = {
  typecheck: ['npx', 'tsc', '--noEmit'],
  lint: ['npx', 'eslint', '--no-error-on-unmatched-pattern'],
  test: ['bun', 'test'],
  build: ['bun', 'run', 'build'],
};

interface ValidatorResult {
  validator: ValidatorName;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runValidator(name: ValidatorName, cwd: string): Promise<ValidatorResult> {
  const cmd = VALIDATOR_COMMANDS[name];
  const TIMEOUT_MS = 30_000;
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);

  const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timeoutHandle);

  if (timedOut) {
    return {
      validator: name,
      passed: false,
      stdout: '',
      stderr: `Validator '${name}' timed out after ${TIMEOUT_MS}ms`,
      exitCode: -1,
    };
  }

  return { validator: name, passed: exitCode === 0, stdout: stdoutBuf, stderr: stderrBuf, exitCode };
}

async function runValidators(validators: ValidatorName[], cwd: string): Promise<ValidatorResult | null> {
  for (const name of validators) {
    const result = await runValidator(name, cwd);
    if (!result.passed) return result;
  }
  return null;
}

function formatValidatorFailure(result: ValidatorResult): string {
  const parts = [`Validator '${result.validator}' failed (exit ${result.exitCode}):`];
  if (result.stderr.trim()) parts.push(result.stderr.trim());
  if (result.stdout.trim()) parts.push(result.stdout.trim());
  return parts.join('\n');
}

interface EditExecutionContext {
  fileCache: FileStateCache;
  cwd: string;
  fileUndoManager?: FileUndoManager;
  configManager?: Pick<ConfigManager, 'get'>;
  toolLLM?: Pick<ToolLLM, 'chat'>;
  changeTracker?: Pick<SessionChangeTracker, 'recordChange'>;
}

interface ResolvedTextEditInput {
  resolvedPaths: Map<string, string>;
  fileContents: Map<string, string>;
  fileReadErrors: Map<string, string>;
  workingContents: Map<string, string>;
}

interface PostValidationRepairResult {
  healed: boolean;
}

function prepareTextEditInput(
  input: EditInput,
  env: EditExecutionContext,
  transactionMode: 'atomic' | 'partial' | 'none',
): ResolvedTextEditInput | { error: string } {
  const resolvedPaths: Map<string, string> = new Map();
  for (const item of input.edits!) {
    if (resolvedPaths.has(item.path)) continue;
    try {
      resolvedPaths.set(item.path, resolveAndValidatePath(item.path));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (transactionMode === 'atomic') {
        return { error: `Path error for '${item.path}': ${msg}` };
      }
    }
  }

  const uniquePaths = new Set(input.edits!.map((e) => resolvedPaths.get(e.path) ?? e.path));
  const fileContents: Map<string, string> = new Map();
  const fileReadErrors: Map<string, string> = new Map();

  for (const resolvedPath of uniquePaths) {
    const cacheResult = env.fileCache.lookup(resolvedPath);
    if (cacheResult.status === 'modified') {
      const msg = `OCC conflict: '${resolvedPath}' was modified externally since last read`;
      if (transactionMode === 'atomic') {
        return { error: msg };
      }
      fileReadErrors.set(resolvedPath, msg);
      continue;
    }

    try {
      const content = readFileSync(resolvedPath, 'utf-8');
      fileContents.set(resolvedPath, content);
    } catch {
      const msg = `File not found or unreadable: '${resolvedPath}'`;
      if (transactionMode === 'atomic') {
        return { error: msg };
      }
      fileReadErrors.set(resolvedPath, msg);
    }
  }

  return {
    resolvedPaths,
    fileContents,
    fileReadErrors,
    workingContents: new Map(fileContents),
  };
}

function writeSuccessfulTextEdits(
  results: EditResult[],
  resolvedPaths: Map<string, string>,
  workingContents: Map<string, string>,
  fileContents: Map<string, string>,
  env: EditExecutionContext,
  writtenPaths: Set<string>,
): void {
  for (const r of results) {
    if (!r.success) continue;
    const resolvedPath = resolvedPaths.get(r.path);
    if (!resolvedPath || writtenPaths.has(resolvedPath)) continue;

    const newContent = workingContents.get(resolvedPath);
    if (newContent === undefined) continue;

    try {
      writeFileSync(resolvedPath, newContent, 'utf-8');
      env.fileCache.update(resolvedPath, newContent);
      writtenPaths.add(resolvedPath);
      if (env.fileUndoManager) {
        try {
          const originalContent = fileContents.get(resolvedPath) ?? null;
          env.fileUndoManager.snapshot({
            path: resolvedPath,
            beforeContent: originalContent,
            afterContent: newContent,
            tool: 'edit',
          });
        } catch {
          // Non-fatal
        }
      }
      env.changeTracker?.recordChange(resolvedPath);
    } catch (err) {
      const msg = `Write failed for '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`;
      for (const res of results) {
        if (res.path === r.path) {
          res.success = false;
          res.error = msg;
        }
      }
    }
  }
}

async function buildImportGraphWarning(cwd: string, writtenPaths: Set<string>): Promise<string | undefined> {
  try {
    const graph = new ImportGraph();
    graph.markDirty();
    await graph.build(cwd);

    const editedAbsPaths = [...writtenPaths];
    const affectedSet = new Set<string>();
    for (const edited of editedAbsPaths) {
      for (const dep of graph.findTransitiveDependents(edited)) {
        affectedSet.add(dep);
      }
    }
    for (const edited of editedAbsPaths) {
      affectedSet.delete(edited);
    }

    if (affectedSet.size === 0) return undefined;

    const affectedList = Array.from(affectedSet);
    const proc = Bun.spawn(['/bin/sh', '-c', `npx tsc --noEmit ${affectedList.join(' ')}`], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0) return undefined;

    const relAffected = affectedList.map((f) => relative(cwd, f));
    const outputLines = (stderrText + '\n' + stdoutText)
      .split('\n')
      .filter((line) => relAffected.some((rel) => line.includes(rel)));
    if (outputLines.length > 0) {
      return `\n⚠ Import graph: ${affectedSet.size} transitive dependent(s) affected by this edit — type errors detected in downstream files:\n${outputLines.join('\n')}`;
    }
    return `\n⚠ Import graph: ${affectedSet.size} transitive dependent(s) affected. tsc reported errors outside the affected set — check unrelated files.`;
  } catch (err) {
    logger.warn('[import-graph] Import graph tracing failed', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

function restoreOriginalContents(fileContents: Map<string, string>, env: EditExecutionContext): void {
  for (const [resolvedPath, originalContent] of fileContents) {
    try {
      writeFileSync(resolvedPath, originalContent, 'utf-8');
      env.fileCache.update(resolvedPath, originalContent);
    } catch {
      // Best-effort rollback
    }
  }
}

async function repairAfterValidationFailure(
  fileContents: Map<string, string>,
  workingContents: Map<string, string>,
  failureMessages: string[],
  env: EditExecutionContext,
): Promise<PostValidationRepairResult> {
  let healed = false;
  for (const [resolvedPath, originalContent] of fileContents) {
    const newContent = workingContents.get(resolvedPath);
    if (newContent === undefined || newContent === originalContent) continue;
    const healResult = env.configManager && env.toolLLM
      ? await new AutoHealer(env.configManager, env.toolLLM).heal(resolvedPath, newContent, failureMessages)
      : { healed: false, content: newContent };
    if (healResult.healed) {
      try {
        writeFileSync(resolvedPath, healResult.content, 'utf-8');
        env.fileCache.update(resolvedPath, healResult.content);
        healed = true;
      } catch {
        // Best-effort heal write
      }
    }
  }
  return { healed };
}

async function validateAfterTextEdits(
  validators: ValidatorName[],
  cwd: string,
  transactionMode: 'atomic' | 'partial' | 'none',
  fileContents: Map<string, string>,
  workingContents: Map<string, string>,
  env: EditExecutionContext,
): Promise<{ error?: string }> {
  const failure = await runValidators(validators, cwd);
  if (!failure) return {};

  const failureMessages = [formatValidatorFailure(failure)];
  const repair = await repairAfterValidationFailure(fileContents, workingContents, failureMessages, env);
  if (repair.healed) {
    const healFailure = await runValidators(validators, cwd);
    if (!healFailure) {
      return {};
    }
  }

  if (transactionMode === 'atomic') {
    restoreOriginalContents(fileContents, env);
  }
  return {
    error: `Post-edit validation failed${transactionMode === 'atomic' ? ' — edits rolled back' : ''}. ${formatValidatorFailure(failure)}`,
  };
}

function formatOutput(results: EditResult[], format: 'count_only' | 'minimal' | 'with_diff' | 'verbose', dryRun: boolean): string {
  const totalApplied = results.filter((r) => r.success).length;
  const totalFailed = results.filter((r) => !r.success).length;
  const dryTag = dryRun ? ' (dry run)' : '';

  if (format === 'count_only') {
    return JSON.stringify({ applied: totalApplied, failed: totalFailed, dry_run: dryRun });
  }

  const lines: string[] = [];
  lines.push(`Edits applied: ${totalApplied}, failed: ${totalFailed}${dryTag}`);

  if (format === 'minimal') {
    for (const r of results) {
      if (r.success) {
        const id = r.id ? ` [${r.id}]` : '';
        const statusTag = r.status ? ` [${r.status}]` : '';
        lines.push(`  OK${statusTag}${id}: ${r.path} (${r.occurrencesReplaced} replacement(s))`);
        if (r.warning) {
          lines.push(`    WARN: ${r.warning}`);
        }
      } else {
        const id = r.id ? ` [${r.id}]` : '';
        const statusTag = r.status ? ` [${r.status}]` : '';
        lines.push(`  FAIL${statusTag}${id}: ${r.path} — ${r.error}`);
        if (r.hint) {
          lines.push(`    HINT: ${r.hint}`);
        }
      }
    }
    return lines.join('\n');
  }

  for (const r of results) {
    const id = r.id ? ` [${r.id}]` : '';
    if (r.success) {
      const statusTag = r.status ? ` [${r.status}]` : '';
      lines.push(`\n--- ${r.path}${id}${statusTag} (${r.occurrencesReplaced} replacement(s))${dryTag} ---`);
      if (r.diff) {
        if (r.diff_truncated) {
          lines.push(`[diff truncated — showing first ${DIFF_PREVIEW_LENGTH} chars]`);
          lines.push(r.diff_preview ?? r.diff.slice(0, DIFF_PREVIEW_LENGTH));
        } else {
          lines.push(r.diff);
        }
      }
      if (r.warning) {
        lines.push(`  WARN: ${r.warning}`);
      }
    } else {
      const statusTag = r.status ? ` [${r.status}]` : '';
      lines.push(`\n--- ${r.path}${id}${statusTag} FAILED ---`);
      lines.push(`  Error: ${r.error}`);
      if (r.hint) {
        lines.push(`  Hint: ${r.hint}`);
      }
    }
  }
  return lines.join('\n');
}

async function executeTextEdits(
  input: EditInput,
  env: EditExecutionContext,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const matchMode = input.match?.mode ?? 'exact';
  const caseSensitive = input.match?.case_sensitive ?? true;
  const whitespaceSensitive = input.match?.whitespace_sensitive ?? true;
  const multiline = input.match?.multiline ?? false;
  const transactionMode = input.transaction?.mode ?? 'atomic';
  const outputFormat = input.output?.format ?? 'minimal';
  const diffContext = input.output?.diff_context ?? 3;
  const dryRun = input.dry_run ?? false;
  const validateBefore = input.validate?.before ?? [];
  const validateAfter = input.validate?.after ?? [];
  const cwd = env.cwd;

  if (!dryRun && validateBefore.length > 0) {
    const failure = await runValidators(validateBefore, cwd);
    if (failure) {
      return { success: false, error: `Pre-edit validation failed. ${formatValidatorFailure(failure)}` };
    }
  }

  const prepResult = prepareTextEditInput(input, env, transactionMode);
  if ('error' in prepResult) {
    return { success: false, error: prepResult.error };
  }

  const { resolvedPaths, fileContents, fileReadErrors, workingContents } = prepResult;
  const results: EditResult[] = [];
  let atomicFailed = false;
  let atomicFailError = '';

  for (const item of input.edits!) {
    const resolvedPath = resolvedPaths.get(item.path);

    if (!resolvedPath) {
      results.push(buildFailedEditResult(item, `Path resolution failed for '${item.path}'`, 'failed'));
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = `Path resolution failed for '${item.path}'`;
        break;
      }
      continue;
    }

    if (fileReadErrors.has(resolvedPath)) {
      const readErrMsg = fileReadErrors.get(resolvedPath)!;
      results.push(buildFailedEditResult(item, readErrMsg, classifyEditFailure(readErrMsg)));
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = readErrMsg;
        break;
      }
      continue;
    }

    const currentContent = workingContents.get(resolvedPath);
    if (currentContent === undefined) {
      results.push(buildFailedEditResult(item, `No content available for '${resolvedPath}'`, 'failed'));
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = `No content available for '${resolvedPath}'`;
        break;
      }
      continue;
    }

    let editResult: { newContent: string; occurrencesReplaced: number; warning?: string } | { error: string; hint?: string };
    if (matchMode === 'ast_pattern') {
      editResult = computeAstPatternEdit(currentContent, item, resolvedPath);
    } else if (matchMode === 'ast') {
      editResult = await computeAstEdit(currentContent, item, resolvedPath);
    } else {
      editResult = computeSingleEdit(currentContent, item, matchMode, caseSensitive, whitespaceSensitive, multiline);
    }

    if ('error' in editResult) {
      const errMsg = editResult.error;
      results.push({
        ...buildFailedEditResult(item, errMsg, classifyEditFailure(errMsg)),
        hint: 'hint' in editResult ? editResult.hint : undefined,
      });
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = errMsg;
        break;
      }
      continue;
    }

    const oldContent = currentContent;
    workingContents.set(resolvedPath, editResult.newContent);

    let diff: string | undefined;
    let diffTruncated: boolean | undefined;
    let diffPreview: string | undefined;
    if (outputFormat === 'with_diff' || outputFormat === 'verbose' || dryRun) {
      const rawDiff = unifiedDiff(oldContent, editResult.newContent, resolvedPath, diffContext);
      if (rawDiff.length > DIFF_TRUNCATE_THRESHOLD) {
        diffTruncated = true;
        diffPreview = rawDiff.slice(0, DIFF_PREVIEW_LENGTH);
        diff = diffPreview;
      } else {
        diff = rawDiff;
      }
    }
    results.push({
      id: item.id,
      path: item.path,
      success: true,
      status: 'applied',
      occurrencesReplaced: editResult.occurrencesReplaced,
      diff,
      diff_truncated: diffTruncated,
      diff_preview: diffPreview,
      warning: editResult.warning,
    });
  }

  if (transactionMode === 'atomic' && atomicFailed) {
    const atomicResults: EditResult[] = input.edits!.map((item, idx) => {
      const r = results[idx];
      if (r && !r.success) return r;
      return {
        id: item.id,
        path: item.path,
        success: false,
        status: 'failed',
        error: r?.success ? 'Rolled back due to atomic transaction failure' : (r?.error ?? atomicFailError),
      };
    });
    return {
      success: false,
      error: `Atomic transaction failed: ${atomicFailError}`,
      output: formatOutput(atomicResults, outputFormat, dryRun),
    };
  }

  const writtenPaths = new Set<string>();
  if (!dryRun) {
    writeSuccessfulTextEdits(results, resolvedPaths, workingContents, fileContents, env, writtenPaths);
  }

  const anySuccess = results.some((r) => r.success);

  let importGraphWarning: string | undefined;
  if (!dryRun && anySuccess) {
    importGraphWarning = await buildImportGraphWarning(cwd, writtenPaths);
  }

  if (!dryRun && anySuccess && validateAfter.length > 0) {
    const validationResult = await validateAfterTextEdits(
      validateAfter,
      cwd,
      transactionMode,
      fileContents,
      workingContents,
      env,
    );
    if (validationResult.error) {
      return { success: false, error: validationResult.error };
    }
  }

  return {
    success: anySuccess,
    output: formatOutput(results, outputFormat, dryRun) + (importGraphWarning ?? ''),
  };
}

export interface EditToolOptions {
  cwd?: string;
  fileUndoManager?: FileUndoManager;
  configManager?: Pick<ConfigManager, 'get'>;
  toolLLM?: Pick<ToolLLM, 'chat'>;
  changeTracker?: Pick<SessionChangeTracker, 'recordChange'>;
}

export function createEditTool(fileCache: FileStateCache, options?: EditToolOptions): Tool {
  const definition: ToolDefinition = {
    name: 'edit',
    description:
      'Edit files by finding and replacing text. Supports exact, fuzzy, and regex matching. ' +
      'Handles multiple edits in one call with atomic or partial transaction semantics. ' +
      'Detects OCC conflicts when files have been modified externally. ' +
      'Also supports Jupyter notebook (.ipynb) cell operations via notebook_operations field.',
    parameters: editSchema as unknown as Record<string, unknown>,
    sideEffects: ['write_fs'],
    concurrency: 'serial',
    supportsProgress: true,
  };

  async function execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const input = args as EditInput;
      if (!input.edits && !input.notebook_operations) {
        return { success: false, error: 'Either edits or notebook_operations must be provided' };
      }
      if (input.edits && input.notebook_operations) {
        return { success: false, error: 'Provide either edits or notebook_operations, not both' };
      }

      const env: EditExecutionContext = {
        fileCache,
        cwd: options?.cwd ?? process.cwd(),
        fileUndoManager: options?.fileUndoManager,
        configManager: options?.configManager,
        toolLLM: options?.toolLLM,
        changeTracker: options?.changeTracker,
      };

      if (input.notebook_operations) {
        return await executeNotebookEdit(input, env);
      }
      return await executeTextEdits(input, env);
    } catch (err) {
      return { success: false, error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { definition, execute };
}
