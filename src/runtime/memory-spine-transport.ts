/**
 * memory-spine-transport.ts
 *
 * The TUI memory-spine cutover: the thin wire adapter that lets the TUI's
 * bootstrap activate the SDK's
 * `@pellux/goodvibes-sdk/platform/runtime/memory-spine` `MemorySpineClient`
 * over the daemon's memory.records.* HTTP routes, mirroring
 * session-spine-transport.ts's pattern for the session spine.
 *
 * The SDK does not (yet) ship a typed operator client for these routes (unlike
 * `HttpTransport.operator.sessions`), so this adapter builds a small REST
 * client directly against the five known routes — exactly what the SDK's own
 * `MemoryTransport` doc comment describes as the expected consumer shape:
 * POST /api/memory/records, POST /api/memory/records/search,
 * GET/DELETE /api/memory/records/{id}, POST /api/memory/records/{id}/review.
 *
 * HONESTY. Unlike the session mirror (fire-and-forget, folded into a soft
 * 'offline' result), memory reads/writes return data the caller depends on —
 * a transport failure here is NOT swallowed. It propagates as a rejected
 * promise, matching `MemorySpineClient`'s documented contract: a wire client
 * must never silently fall back to a divergent local copy in place of a real
 * failure.
 */
import { buildUrl, createJsonRequestInit, requestJsonRaw } from '@pellux/goodvibes-sdk/transport-http';
import type { MemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { HonestMemorySearchOptions, HonestMemorySearchResult, MemoryAddOptions, MemoryRecord, MemorySearchFilter } from '@pellux/goodvibes-sdk/platform/state';

/** Derived from `MemoryAccess` itself rather than imported by name — `MemoryReviewPatch` is not re-exported from the SDK's public `platform/state` entry point. */
type MemoryReviewPatch = Parameters<MemoryAccess['updateReview']>[1];

function isNotFoundWireError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'transport' in error
    && typeof (error as { transport?: { status?: unknown } }).transport?.status === 'number'
    && (error as { transport: { status: number } }).transport.status === 404;
}

export interface MemorySpineWireOptions {
  readonly baseUrl: string;
  readonly authToken: string | null;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the `MemorySpineClient` wire transport: a thin REST adapter over the
 * adopted daemon's five memory.records.* routes. `bootstrap.ts` activates a
 * client built from this the same way it adopts the session spine.
 */
export function createTuiMemorySpineTransport(options: MemorySpineWireOptions): MemoryAccess {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.authToken;
  const url = (path: string): string => buildUrl(options.baseUrl, path);
  return {
    add: async (opts: MemoryAddOptions): Promise<MemoryRecord> => {
      const response = await requestJsonRaw<{ record: MemoryRecord }>(
        fetchImpl, url('/api/memory/records'), createJsonRequestInit(token, opts, 'POST'),
      );
      return response.record;
    },
    honestSearch: async (filter?: MemorySearchFilter, searchOptions?: HonestMemorySearchOptions): Promise<HonestMemorySearchResult> => {
      const body = { ...(filter ?? {}), ...(searchOptions?.recall !== undefined ? { recall: searchOptions.recall } : {}) };
      return await requestJsonRaw<HonestMemorySearchResult>(
        fetchImpl, url('/api/memory/records/search'), createJsonRequestInit(token, body, 'POST'),
      );
    },
    get: async (id: string): Promise<MemoryRecord | null> => {
      try {
        const response = await requestJsonRaw<{ record: MemoryRecord }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}`), createJsonRequestInit(token),
        );
        return response.record;
      } catch (error) {
        if (isNotFoundWireError(error)) return null;
        throw error;
      }
    },
    updateReview: async (id: string, patch: MemoryReviewPatch): Promise<MemoryRecord | null> => {
      try {
        const response = await requestJsonRaw<{ record: MemoryRecord }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}/review`), createJsonRequestInit(token, patch, 'POST'),
        );
        return response.record;
      } catch (error) {
        if (isNotFoundWireError(error)) return null;
        throw error;
      }
    },
    delete: async (id: string): Promise<boolean> => {
      const response = await requestJsonRaw<{ id: string; deleted: boolean }>(
        fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}`), createJsonRequestInit(token, undefined, 'DELETE'),
      );
      return response.deleted;
    },
  };
}

/** Mutable one-slot ref tracking which adopted daemon's baseUrl the memory spine is currently wired to (mirrors bootstrap.ts's `spineActiveForBaseUrl`). */
export interface MemorySpineActiveRef { value: string | null }

/**
 * Sync the memory spine to the current daemon-adoption status — the SAME
 * signal bootstrap.ts's `syncSessionSpineToHostStatus` uses. 'external' (an
 * adopted, separately-running daemon) activates the wire transport; every
 * other mode ('embedded' — this process IS the daemon host, so its own store
 * is already canonical — plus 'disabled'/'blocked'/'incompatible'/'unavailable')
 * deactivates back to local access.
 */
export function syncMemorySpineToHostStatus(
  memorySpine: { activate: (transport: MemoryAccess) => void; deactivate: (reason: string) => void },
  daemonMode: string,
  daemonBaseUrl: string,
  sharedDaemonToken: string,
  activeRef: MemorySpineActiveRef,
  log: { info: (message: string) => void },
): void {
  if (daemonMode !== 'external') {
    if (activeRef.value !== null) {
      memorySpine.deactivate(`daemon mode changed to '${daemonMode}'`);
      activeRef.value = null;
    }
    return;
  }
  if (activeRef.value === daemonBaseUrl) return; // already wired to this exact adopted daemon
  memorySpine.activate(createTuiMemorySpineTransport({ baseUrl: daemonBaseUrl, authToken: sharedDaemonToken }));
  activeRef.value = daemonBaseUrl;
  log.info(`[bootstrap] memory spine: adopted external daemon at ${daemonBaseUrl} — routing memory ops over the wire`);
}
