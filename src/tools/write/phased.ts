/**
 * Phased wrapper for the write tool.
 *
 * Delegates entirely to the existing `createWriteTool` implementation and adds
 * the PhasedTool metadata required by the phased executor.
 */
import { asPhasedTool } from '../../runtime/tools/adapter.ts';
import { createWriteTool } from './index.ts';
import type { FileStateCache } from '../../state/file-cache.ts';
import type { ProjectIndex } from '../../state/project-index.ts';
import type { FileUndoManager } from '../../state/file-undo.ts';

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

/** Dependencies forwarded to the underlying write tool factory. */
export interface WriteDeps {
  fileCache?: FileStateCache;
  projectIndex?: ProjectIndex;
  fileUndoManager?: FileUndoManager;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a phased write tool.
 *
 * Category  : `write` — routes to the mutating-filesystem concurrency pool.
 * Cancellable: `false` — write operations are not safe to interrupt mid-flight;
 *   a partial write leaves files in an inconsistent state.
 *
 * @param deps - Optional dependency overrides (shared cache instances, undo manager).
 * @returns A PhasedTool that delegates execution to `createWriteTool`.
 */
export function createPhasedWriteTool(projectRoot: string, deps: WriteDeps = {}) {
  const inner = createWriteTool({ ...deps, projectRoot });
  return asPhasedTool(inner, { category: 'write', cancellable: false });
}
