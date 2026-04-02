/**
 * Phased wrapper for the fetch tool.
 *
 * Delegates entirely to the existing `fetchTool` singleton and adds the
 * PhasedTool metadata required by the phased executor.
 */
import { asPhasedTool } from '../../runtime/tools/adapter.ts';
import { fetchTool } from './index.ts';

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
 * @returns A PhasedTool that delegates execution to `fetchTool`.
 */
export function createPhasedFetchTool() {
  return asPhasedTool(fetchTool, { category: 'network', cancellable: true, phaseTimeouts: { executing: NETWORK_EXECUTE_TIMEOUT_MS } });
}
