/**
 * Central phased tool registry.
 *
 * Builds a `Map<string, PhasedTool>` from an existing ToolRegistry by wrapping
 * each built-in tool with its phased metadata.  Plugin tools registered after
 * bootstrap are wrapped generically with sensible defaults.
 *
 * Usage:
 * ```ts
 * const phasedTools = registerPhasedTools(legacyRegistry, deps);
 * const executor = new PhasedExecutor(phasedTools);
 * ```
 */
import type { PhasedTool } from './adapter.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { FileStateCache } from '../../state/file-cache.ts';
import type { ProjectIndex } from '../../state/project-index.ts';
import type { FileUndoManager } from '../../state/file-undo.ts';
import { createPhasedWriteTool } from '../../tools/write/phased.ts';
import { createPhasedEditTool } from '../../tools/edit/phased.ts';
import { createPhasedFindTool } from '../../tools/find/phased.ts';
import { createPhasedFetchTool } from '../../tools/fetch/phased.ts';
import { createPhasedExecTool } from '../../tools/exec/phased.ts';
import { createPhasedReadTool } from '../../tools/read/phased.ts';

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

/** Shared state dependencies required to construct the write and edit wrappers. */
export interface PhasedRegistryDeps {
  fileCache: FileStateCache;
  projectIndex: ProjectIndex;
  fileUndoManager: FileUndoManager;
}

// ---------------------------------------------------------------------------
// Well-known tool names (avoids stringly-typed comparisons at the call sites)
// ---------------------------------------------------------------------------

const TOOL_WRITE = 'write';
const TOOL_EDIT = 'edit';
const TOOL_FIND = 'find';
const TOOL_FETCH = 'fetch';
const TOOL_EXEC = 'exec';
const TOOL_READ = 'read';

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

/**
 * Build a `Map<string, PhasedTool>` from the given legacy ToolRegistry.
 *
 * The six core tools (write, edit, find, fetch, exec, read) are wrapped with
 * their dedicated phased factories so they carry precise category and lifecycle
 * metadata.  All other tools registered in the legacy registry (built-ins
 * not yet migrated, plugin tools) are wrapped with a generic `read` +
 * cancellable default — safe because the executor only uses category and
 * cancellable for routing and queuing; the underlying execute() is unchanged.
 *
 * @param legacyRegistry - The existing ToolRegistry populated by `registerAllTools`.
 * @param deps           - Shared state instances used by write and edit wrappers.
 * @returns A map of tool name → PhasedTool covering every registered tool.
 */
export function registerPhasedTools(
  legacyRegistry: ToolRegistry,
  deps: PhasedRegistryDeps,
): Map<string, PhasedTool> {
  const { fileCache, projectIndex, fileUndoManager } = deps;
  const result = new Map<string, PhasedTool>();

  // Pre-build the six migrated wrappers keyed by tool name.
  const migrated: Map<string, PhasedTool> = new Map([
    [TOOL_WRITE, createPhasedWriteTool({ fileCache, projectIndex, fileUndoManager })],
    [TOOL_EDIT, createPhasedEditTool(fileCache, { fileUndoManager })],
    [TOOL_FIND, createPhasedFindTool()],
    [TOOL_FETCH, createPhasedFetchTool()],
    [TOOL_EXEC, createPhasedExecTool()],
    [TOOL_READ, createPhasedReadTool(fileCache, projectIndex)],
  ]);

  for (const tool of legacyRegistry.list()) {
    const name = tool.definition.name;

    if (migrated.has(name)) {
      // Use the dedicated phased wrapper.
      result.set(name, migrated.get(name) as PhasedTool);
    } else {
      // Generic fallback: treat as a read operation, cancellable.
      // This is intentionally conservative — callers can override by calling
      // result.set(name, customWrapper) after this function returns.
      const generic: PhasedTool = {
        ...tool,
        category: 'read',
        cancellable: true,
      };
      result.set(name, generic);
    }
  }

  return result;
}
