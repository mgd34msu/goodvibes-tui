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
 * client directly against the known routes — exactly what the SDK's own
 * `MemoryTransport` doc comment describes as the expected consumer shape.
 *
 * FULL DETACH (SDK 1.2.0). Beyond the five 1.1.0 CORE routes (add, search,
 * get, review, delete) this now implements the full 1.2.0 EXTENDED catalog
 * (list, search-semantic, update, links.list, links.add, export, import,
 * vector, doctor, review-queue) — see
 * docs/decisions/2026-07-06-memory-wire-full-detach.md in the SDK repo. This
 * is what lets `/recall`'s browse/link/queue/export/import subcommands and
 * the per-turn knowledge-injection bulk read fully detach from the local
 * store file when a daemon is adopted: every one of those ops now has a wire
 * equivalent, so this transport implements every EXTENDED verb rather than
 * leaving some optional.
 *
 * HONESTY. Unlike the session mirror (fire-and-forget, folded into a soft
 * 'offline' result), memory reads/writes return data the caller depends on —
 * a transport failure here is NOT swallowed. It propagates as a rejected
 * promise, matching `MemorySpineClient`'s documented contract: a wire client
 * must never silently fall back to a divergent local copy in place of a real
 * failure.
 *
 * A 404 is disambiguated by its RESPONSE CODE (`classifyMemoryWireError`, from
 * the SDK's `platform/runtime/memory-spine` — this transport no longer inlines
 * its own copy of the discriminator), never by the bare status. A record-missing
 * 404 carries `MEMORY_RECORD_NOT_FOUND`: on a nullable verb
 * (`get`/`updateReview`/`update`/`link`) it maps to the documented `null` "not
 * found"; on a non-nullable verb (`linksFor` etc.) it is not representable as
 * null so it propagates as a thrown error. ANY OTHER 404 — a route-not-found
 * from an older daemon that never registered this route, or a bare legacy 404
 * with no code — is treated as "this daemon does not serve this verb" and
 * rejects with a stated reason on EVERY verb, never a silent `null`. That is
 * what lets `/recall` surface an honest degraded message on a version-skewed
 * daemon instead of reporting an existing record as gone.
 */
import { buildUrl, createJsonRequestInit, requestJsonRaw } from '@pellux/goodvibes-sdk/transport-http';
import {
  classifyMemoryWireError,
  memoryVerbUnavailableError,
  type MemoryAccess,
  type MemoryTransport,
  type MemoryUpdatePatch,
} from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type {
  HonestMemorySearchOptions,
  HonestMemorySearchResult,
  MemoryAddOptions,
  MemoryBundle,
  MemoryDoctorReport,
  MemoryLink,
  MemoryRecord,
  MemoryScope,
  MemorySearchFilter,
  MemorySemanticSearchResult,
} from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryVectorStats } from '@pellux/goodvibes-sdk/platform/state';

/** Derived from `MemoryAccess` itself rather than imported by name — `MemoryReviewPatch` is not re-exported from the SDK's public `platform/state` entry point. */
type MemoryReviewPatch = Parameters<MemoryAccess['updateReview']>[1];
/** Same reasoning — `MemoryImportResult` is not re-exported from a public SDK entry point. */
type MemoryImportResult = Awaited<ReturnType<MemoryAccess['importBundle']>>;

/**
 * The 404 discriminator and the "daemon does not serve this verb" rejection are
 * now the SDK's own `classifyMemoryWireError` / `memoryVerbUnavailableError`
 * (`@pellux/goodvibes-sdk/platform/runtime/memory-spine`) rather than a copy
 * inlined in this transport — this surface's SDK pin now ships them as a
 * shared constant/discriminator, so the two thin folds below just delegate.
 */

/** Fold for a NULLABLE record-scoped verb: record-miss → null; version-skew → honest reject; else rethrow. */
function foldNullableMemoryWire404(verb: string, error: unknown): null {
  const kind = classifyMemoryWireError(error);
  if (kind === 'record-missing') return null;
  if (kind === 'method-unavailable') throw memoryVerbUnavailableError(verb, error);
  throw error;
}

/** Fold for a NON-NULLABLE (collection or record-required) verb: version-skew → honest reject; else rethrow. */
function rethrowMemoryWire404(verb: string, error: unknown): never {
  if (classifyMemoryWireError(error) === 'method-unavailable') throw memoryVerbUnavailableError(verb, error);
  throw error;
}

export interface MemorySpineWireOptions {
  readonly baseUrl: string;
  readonly authToken: string | null;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the `MemorySpineClient` wire transport: a thin REST adapter over the
 * adopted daemon's full memory.records.* route catalog (five CORE routes plus
 * the ten 1.2.0 EXTENDED routes). `bootstrap.ts` activates a client built from
 * this the same way it adopts the session spine.
 */
export function createTuiMemorySpineTransport(options: MemorySpineWireOptions): MemoryTransport {
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
        return foldNullableMemoryWire404('get', error);
      }
    },
    updateReview: async (id: string, patch: MemoryReviewPatch): Promise<MemoryRecord | null> => {
      try {
        const response = await requestJsonRaw<{ record: MemoryRecord }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}/review`), createJsonRequestInit(token, patch, 'POST'),
        );
        return response.record;
      } catch (error) {
        return foldNullableMemoryWire404('updateReview', error);
      }
    },
    delete: async (id: string): Promise<boolean> => {
      const response = await requestJsonRaw<{ id: string; deleted: boolean }>(
        fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}`), createJsonRequestInit(token, undefined, 'DELETE'),
      );
      return response.deleted;
    },

    // ── Extended verbs (1.2.0 full-detach) ──────────────────────────────────

    list: async (filter?: MemorySearchFilter): Promise<readonly MemoryRecord[]> => {
      try {
        const response = await requestJsonRaw<{ records: readonly MemoryRecord[] }>(
          fetchImpl, url('/api/memory/records/list'), createJsonRequestInit(token, filter ?? {}, 'POST'),
        );
        return response.records;
      } catch (error) {
        return rethrowMemoryWire404('list', error);
      }
    },
    searchSemantic: async (filter?: MemorySearchFilter): Promise<readonly MemorySemanticSearchResult[]> => {
      try {
        const response = await requestJsonRaw<{ results: readonly MemorySemanticSearchResult[] }>(
          fetchImpl, url('/api/memory/records/search-semantic'), createJsonRequestInit(token, filter ?? {}, 'POST'),
        );
        return response.results;
      } catch (error) {
        return rethrowMemoryWire404('searchSemantic', error);
      }
    },
    update: async (id: string, patch: MemoryUpdatePatch): Promise<MemoryRecord | null> => {
      try {
        const response = await requestJsonRaw<{ record: MemoryRecord }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}/update`), createJsonRequestInit(token, patch, 'POST'),
        );
        return response.record;
      } catch (error) {
        return foldNullableMemoryWire404('update', error);
      }
    },
    link: async (fromId: string, toId: string, relation: string): Promise<MemoryLink | null> => {
      try {
        const response = await requestJsonRaw<{ link: MemoryLink }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(fromId)}/links`), createJsonRequestInit(token, { toId, relation }, 'POST'),
        );
        return response.link;
      } catch (error) {
        return foldNullableMemoryWire404('link', error);
      }
    },
    linksFor: async (id: string): Promise<readonly MemoryLink[]> => {
      try {
        const response = await requestJsonRaw<{ links: readonly MemoryLink[] }>(
          fetchImpl, url(`/api/memory/records/${encodeURIComponent(id)}/links`), createJsonRequestInit(token),
        );
        return response.links;
      } catch (error) {
        return rethrowMemoryWire404('linksFor', error);
      }
    },
    reviewQueue: async (limit?: number, scope?: MemoryScope): Promise<readonly MemoryRecord[]> => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      if (scope !== undefined) params.set('scope', scope);
      const query = params.toString();
      try {
        const response = await requestJsonRaw<{ records: readonly MemoryRecord[] }>(
          fetchImpl, url(`/api/memory/review-queue${query ? `?${query}` : ''}`), createJsonRequestInit(token),
        );
        return response.records;
      } catch (error) {
        return rethrowMemoryWire404('reviewQueue', error);
      }
    },
    exportBundle: async (filter?: MemorySearchFilter): Promise<MemoryBundle> => {
      try {
        const response = await requestJsonRaw<{ bundle: MemoryBundle }>(
          fetchImpl, url('/api/memory/records/export'), createJsonRequestInit(token, filter ?? {}, 'POST'),
        );
        return response.bundle;
      } catch (error) {
        return rethrowMemoryWire404('exportBundle', error);
      }
    },
    importBundle: async (bundle: MemoryBundle): Promise<MemoryImportResult> => {
      try {
        const response = await requestJsonRaw<{ result: MemoryImportResult }>(
          fetchImpl, url('/api/memory/records/import'), createJsonRequestInit(token, { bundle }, 'POST'),
        );
        return response.result;
      } catch (error) {
        return rethrowMemoryWire404('importBundle', error);
      }
    },
    vectorStats: async (): Promise<MemoryVectorStats> => {
      try {
        const response = await requestJsonRaw<{ vector: MemoryVectorStats }>(
          fetchImpl, url('/api/memory/vector'), createJsonRequestInit(token),
        );
        return response.vector;
      } catch (error) {
        return rethrowMemoryWire404('vectorStats', error);
      }
    },
    doctor: async (): Promise<MemoryDoctorReport> => {
      try {
        return await requestJsonRaw<MemoryDoctorReport>(
          fetchImpl, url('/api/memory/doctor'), createJsonRequestInit(token),
        );
      } catch (error) {
        return rethrowMemoryWire404('doctor', error);
      }
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
  memorySpine: { activate: (transport: MemoryTransport) => void; deactivate: (reason: string) => void },
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
