/**
 * Phased wrapper for the fetch tool.
 *
 * Delegates to a freshly constructed fetch tool instance and adds the
 * PhasedTool metadata required by the phased executor.
 */
import { asPhasedTool } from '../../runtime/tools/adapter.ts';
import { createFetchTool } from './index.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default network timeout for the executing phase (30 seconds). */
const NETWORK_EXECUTE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a phased fetch tool.
 *
 * Category      : `network` — routes to the network concurrency pool.
 * Cancellable   : `true` — HTTP requests can be interrupted mid-flight by
 *   closing the underlying socket; the executor passes an AbortSignal.
 * phaseTimeouts : `{ executing: 30000 }` — overrides the default timeout for
 *   the executing phase to allow for slow network responses.
 *
 * @returns A PhasedTool that delegates execution to an owned fetch tool instance.
 */
export function createPhasedFetchTool() {
  return asPhasedTool(createFetchTool(), { category: 'network', cancellable: true, phaseTimeouts: { executing: NETWORK_EXECUTE_TIMEOUT_MS } });
}
