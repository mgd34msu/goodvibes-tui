import { readFileSync, writeFileSync } from 'node:fs';
import { isNotebookFile } from '../../utils/notebook.ts';
import { unifiedDiff, FileStateCache } from '../../state/file-cache.ts';
import { FileUndoManager } from '../../state/file-undo.ts';
import { logger } from '../../utils/logger.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import type { EditInput, JupyterNotebook, NotebookCell, NotebookOperation, NotebookOperationsInput, EditResult } from './types.ts';

export function normalizeSource(source: string | string[]): string[] {
  if (Array.isArray(source)) return source;
  const lines = source.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line));
}

export function validateNotebook(parsed: unknown): parsed is JupyterNotebook {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const nb = parsed as Record<string, unknown>;
  if (typeof nb['nbformat'] !== 'number') return false;
  if (!Array.isArray(nb['cells'])) return false;
  for (const cell of nb['cells'] as unknown[]) {
    if (!cell || typeof cell !== 'object') return false;
    const c = cell as Record<string, unknown>;
    if (!c['cell_type'] || typeof c['cell_type'] !== 'string') return false;
    if (c['source'] === undefined) return false;
  }
  return true;
}

export function resolveCellId(cells: NotebookCell[], cellId: string): number {
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.id === cellId) return i;
    if (cell.metadata && (cell.metadata as Record<string, unknown>)['id'] === cellId) return i;
  }
  return -1;
}

export function generateCellId(existingCells?: NotebookCell[]): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const existingIds = new Set(existingCells?.map((c) => c.id).filter(Boolean) ?? []);
  let id: string;
  do {
    id = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (existingIds.has(id));
  return id;
}

export function readNotebookFile(
  resolvedPath: string,
  fileCache: FileStateCache,
): { notebook: JupyterNotebook; rawContent: string } | { error: string } {
  const cacheResult = fileCache.lookup(resolvedPath);
  if (cacheResult.status === 'modified') {
    return { error: `OCC conflict: '${resolvedPath}' was modified externally since last read` };
  }

  let rawContent: string;
  try {
    rawContent = readFileSync(resolvedPath, 'utf-8');
  } catch {
    return { error: `File not found or unreadable: '${resolvedPath}'` };
  }

  try {
    const parsed: unknown = JSON.parse(rawContent);
    if (!validateNotebook(parsed)) {
      return { error: 'Not a valid Jupyter notebook: missing nbformat or cells array' };
    }
    return { notebook: parsed, rawContent };
  } catch (err) {
    return { error: `Failed to parse notebook JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function applyNotebookOperations(
  notebook: JupyterNotebook,
  operations: NotebookOperation[],
): { success: boolean; applied: number; summary: string; error?: string } {
  const needsCellIds = notebook.nbformat > 4 ||
    (notebook.nbformat === 4 && (notebook.nbformat_minor ?? 0) >= 5);

  let indexOffset = 0;
  let applied = 0;
  const summaryLines: string[] = [];

  for (const op of operations) {
    if (op.op === 'replace') {
      let idx: number;
      if (op.cell_id !== undefined) {
        idx = resolveCellId(notebook.cells, op.cell_id);
        if (idx === -1) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `replace: cell_id '${op.cell_id}' not found` };
        }
      } else if (op.cell !== undefined) {
        idx = op.cell + indexOffset;
        if (idx < 0 || idx >= notebook.cells.length) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `replace: cell index ${op.cell} out of range (notebook has ${notebook.cells.length} cells)` };
        }
      } else {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'replace: requires cell or cell_id' };
      }

      if (op.source === undefined) {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'replace: source is required' };
      }

      const cell = notebook.cells[idx];
      cell.source = normalizeSource(op.source);
      if (op.cell_type !== undefined && op.cell_type !== cell.cell_type) {
        cell.cell_type = op.cell_type;
        if (op.cell_type === 'code') {
          if (cell.execution_count === undefined) cell.execution_count = null;
          if (cell.outputs === undefined) cell.outputs = [];
        } else {
          delete cell.execution_count;
          delete cell.outputs;
        }
      }

      if (op.clear_outputs && cell.cell_type === 'code') {
        cell.outputs = [];
        cell.execution_count = null;
      }

      summaryLines.push(`  OK: replace cell[${idx}]`);
      applied++;
    } else if (op.op === 'insert') {
      if (op.source === undefined) {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'insert: source is required' };
      }
      if (op.cell_type === undefined) {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'insert: cell_type is required' };
      }

      const newCell: NotebookCell = {
        cell_type: op.cell_type,
        source: normalizeSource(op.source),
        metadata: {},
      };
      if (op.cell_type === 'code') {
        newCell.execution_count = null;
        newCell.outputs = [];
      }
      if (needsCellIds) {
        newCell.id = generateCellId(notebook.cells);
      }

      let insertAt: number;
      if (op.cell_id !== undefined) {
        const refIdx = resolveCellId(notebook.cells, op.cell_id);
        if (refIdx === -1) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `insert: cell_id '${op.cell_id}' not found` };
        }
        insertAt = refIdx + 1;
      } else if (op.after !== undefined) {
        if (op.after === -1) {
          insertAt = 0;
        } else {
          const adjustedAfter = op.after + indexOffset;
          if (adjustedAfter < -1 || adjustedAfter >= notebook.cells.length) {
            return { success: false, applied, summary: summaryLines.join('\n'), error: `insert: after index ${op.after} out of bounds (-1 to ${notebook.cells.length - 1})` };
          }
          insertAt = adjustedAfter + 1;
        }
      } else {
        insertAt = notebook.cells.length;
      }

      notebook.cells.splice(insertAt, 0, newCell);
      indexOffset++;
      summaryLines.push(`  OK: insert cell at[${insertAt}]`);
      applied++;
    } else if (op.op === 'delete') {
      let idx: number;
      if (op.cell_id !== undefined) {
        idx = resolveCellId(notebook.cells, op.cell_id);
        if (idx === -1) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `delete: cell_id '${op.cell_id}' not found` };
        }
      } else if (op.cell !== undefined) {
        idx = op.cell + indexOffset;
        if (idx < 0 || idx >= notebook.cells.length) {
          return { success: false, applied, summary: summaryLines.join('\n'), error: `delete: cell index ${op.cell} out of range (notebook has ${notebook.cells.length} cells)` };
        }
      } else {
        return { success: false, applied, summary: summaryLines.join('\n'), error: 'delete: requires cell or cell_id' };
      }

      notebook.cells.splice(idx, 1);
      indexOffset--;
      summaryLines.push(`  OK: delete cell[${idx}]`);
      applied++;
    }
  }

  return { success: true, applied, summary: summaryLines.join('\n') };
}

export function formatNotebookOutput(
  opsResult: { applied: number; summary: string },
  outputFormat: 'count_only' | 'minimal' | 'with_diff' | 'verbose',
  dryRun: boolean,
  rawContent: string,
  newContent: string,
  resolvedPath: string,
  diffContext: number,
): string {
  if (outputFormat === 'count_only') {
    return JSON.stringify({ applied: opsResult.applied, failed: 0, dry_run: dryRun });
  }
  if (outputFormat === 'minimal') {
    return `Notebook operations applied: ${opsResult.applied}, failed: 0${dryRun ? ' (dry run)' : ''}\n${opsResult.summary}`;
  }
  const diff = unifiedDiff(rawContent, newContent, resolvedPath, diffContext);
  return `Notebook operations applied: ${opsResult.applied}, failed: 0${dryRun ? ' (dry run)' : ''}\n${opsResult.summary}\n${diff}`;
}

export function executeNotebookEdit(
  input: EditInput,
  env: { fileCache: FileStateCache; cwd: string; fileUndoManager?: FileUndoManager },
): Promise<{ success: boolean; output?: string; error?: string }> {
  const nbOps = input.notebook_operations!;
  const outputFormat = input.output?.format ?? 'minimal';
  const diffContext = input.output?.diff_context ?? 3;
  const dryRun = input.dry_run ?? false;

  if (!nbOps.path || typeof nbOps.path !== 'string') {
    return Promise.resolve({ success: false, error: 'notebook_operations.path is required and must be a string' });
  }
  if (!Array.isArray(nbOps.operations)) {
    return Promise.resolve({ success: false, error: 'notebook_operations.operations must be an array' });
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveAndValidatePath(nbOps.path);
  } catch (err) {
    return Promise.resolve({ success: false, error: `Path error: ${err instanceof Error ? err.message : String(err)}` });
  }

  if (!isNotebookFile(resolvedPath)) {
    return Promise.resolve({ success: false, error: `notebook_operations requires a .ipynb file, got: ${nbOps.path}` });
  }

  const notebookRead = readNotebookFile(resolvedPath, env.fileCache);
  if ('error' in notebookRead) {
    return Promise.resolve({ success: false, error: notebookRead.error });
  }

  const notebook = notebookRead.notebook;
  const rawContent = notebookRead.rawContent;
  const opsResult = applyNotebookOperations(notebook, nbOps.operations);
  if (!opsResult.success) {
    return Promise.resolve({ success: false, error: opsResult.error });
  }

  const newContent = JSON.stringify(notebook, null, 1) + '\n';
  if (dryRun) {
    return Promise.resolve({ success: true, output: formatNotebookOutput(opsResult, outputFormat, true, rawContent, newContent, resolvedPath, diffContext) });
  }

  try {
    writeFileSync(resolvedPath, newContent, 'utf-8');
  } catch (err) {
    return Promise.resolve({ success: false, error: `Write failed for '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}` });
  }

  env.fileCache.update(resolvedPath, newContent);
  if (env.fileUndoManager) {
    try {
      env.fileUndoManager.snapshot({
        path: resolvedPath,
        beforeContent: rawContent,
        afterContent: newContent,
        tool: 'edit',
      });
    } catch {
      // Non-fatal
    }
  }

  return Promise.resolve({
    success: true,
    output: formatNotebookOutput(opsResult, outputFormat, false, rawContent, newContent, resolvedPath, diffContext),
  });
}
