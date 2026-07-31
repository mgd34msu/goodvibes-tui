/**
 * memory-spine-transport.ts
 *
 * The TUI memory-spine cutover: a thin wrapper over the SDK's own canonical
 * memory-spine REST transport
 * (`createMemorySpineRestTransport` from
 * `@pellux/goodvibes-sdk/platform/runtime/memory-spine`).
 *
 * ── Hoist provenance (2026-07-30 daemon/TUI split) ──────────────────────────
 *
 * This file used to carry a full parallel implementation of the memory wire
 * protocol (285 lines, 16 raw `requestJsonRaw` call sites): the five CORE
 * routes (add, search, get, review, delete) plus the ten 1.2.0 EXTENDED
 * routes (list, search-semantic, update, links.list, links.add, export,
 * import, review-queue, vector, doctor), the 404 discriminator
 * (`classifyMemoryWireError`/`memoryVerbUnavailableError`), and the honesty
 * rule that a transport failure propagates rather than silently falling back
 * to a divergent local copy.
 *
 * The SDK's `rest-transport.ts` (`platform/runtime/memory-spine`) adopted
 * this file's version as the superset during the split hoist — same routes,
 * same discriminator functions, same honesty contract, same transport-http
 * primitives — so this file now just delegates. `MemorySpineWireOptions`
 * (`{baseUrl, authToken, fetchImpl?}`) is the same shape the SDK's
 * `MemorySpineRestTransportOptions` takes, so there is nothing to adapt: this
 * export is a direct pass-through, kept as this file's own named symbol only
 * because `spine-adoption.ts` and this surface's tests already import it from
 * here.
 *
 * Retired in the same hoist: `syncMemorySpineToHostStatus` and
 * `MemorySpineActiveRef`. Memory-spine activation is now folded into the
 * SDK's `createSpineAdoptionSync` (see `src/runtime/client/spine-adoption.ts`)
 * — `spine-adoption.ts` supplies `memoryTransport` in the connect bundle
 * instead of calling a separate sync function on the daemon-status signal.
 * Confirmed zero non-test callers remained (only
 * `src/test/runtime/memory-spine-daemon-integration.test.ts` still exercised
 * them) before deleting both.
 */
import {
  createMemorySpineRestTransport as createSdkMemorySpineRestTransport,
  type MemoryTransport,
} from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';

export interface MemorySpineWireOptions {
  readonly baseUrl: string;
  readonly authToken: string | null;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the `MemorySpineClient` wire transport: a direct delegate to the
 * SDK's canonical `createMemorySpineRestTransport`, which implements the full
 * memory.records.* route catalog (five CORE routes plus the ten 1.2.0
 * EXTENDED routes). `spine-adoption.ts` builds a client from this the same
 * way it adopts the session spine.
 */
export function createTuiMemorySpineTransport(options: MemorySpineWireOptions): MemoryTransport {
  return createSdkMemorySpineRestTransport(options);
}
