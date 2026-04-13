/**
 * Phased wrapper for the find tool.
 *
 * Delegates to a freshly constructed find tool instance and adds the
 * PhasedTool metadata required by the phased executor.
 */
import { asPhasedTool } from '../../runtime/tools/adapter.ts';
import { createFindTool } from './index.ts';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a phased find tool.
 *
 * Category   : `read` — find operations are non-mutating.
 * Cancellable: `true` — directory walks and content searches can be slow;
 *   the executor will honour an AbortSignal to interrupt long-running queries.
 * skipPhases : `['prehook', 'posthook']` — find needs no before/after hooks
 *   (no write audit trail, no cache invalidation).
 *
 * @returns A PhasedTool that delegates execution to an owned find tool instance.
 */
export function createPhasedFindTool(projectRoot: string) {
  return asPhasedTool(createFindTool(projectRoot), { category: 'read', cancellable: true, skipPhases: ['prehook', 'posthook'] });
}
