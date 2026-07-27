/**
 * memory-spine-daemon-integration.test.ts
 *
 * Acceptance evidence for the memory-spine adoption wiring (WO memory-adopt):
 * drives MemorySpineClient against a REAL bootDaemon instance (isolated home,
 * ephemeral port) over the TUI's createTuiMemorySpineTransport — no mocked
 * wire for the adoption proof. Proves:
 *   - local/offline mode never reaches the daemon (writes stay on the local store);
 *   - activate() on an adopted daemon routes add/get/search/review/delete through
 *     the wire to the DAEMON's own canonical registry (`daemon.memory`), not a
 *     detached copy — the one-writer invariant, proven, not asserted;
 *   - a recall-honesty degraded reason (indexUnavailableReason) survives the
 *     wire transport to the caller unchanged (a spy transport, since forcing a
 *     real sqlite-vec unavailability is not a deterministic condition to boot);
 *   - deactivation on daemon loss reverts the spine to local access, logging the
 *     SDK's own honest note, and further writes land on the local store again.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '@pellux/goodvibes-sdk/platform/daemon';
import { MemorySpineClient } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { MemoryAccess, MemoryTransport } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { MemoryLink, MemoryRecord } from '@pellux/goodvibes-sdk/platform/state';
import { createTuiMemorySpineTransport, syncMemorySpineToHostStatus, type MemorySpineActiveRef } from '../../runtime/memory-spine-transport.ts';

const TOKEN = 'memory-spine-integration-token';

/**
 * Per-test budget for this file.
 *
 * A ceiling, not a target. Every test here boots a REAL daemon on a real socket
 * and then makes several real HTTP round trips to it; on a fast host that is
 * tens of milliseconds and the ceiling costs nothing, because nothing in the
 * file waits out a fixed delay. bun's implicit 5 s default was an idle
 * machine's number: on a loaded host these failed with "this test timed out
 * after 5000ms" while the daemon was still coming up normally — the file as a
 * whole takes far longer than 5 s there.
 */
const TEST_BUDGET_MS = 120_000;

/**
 * A minimal, isolated in-memory MemoryAccess standing in for the TUI's own
 * local registry — the offline/host backend. Exposes its record map so tests
 * can assert a write never reached it (or did). Implements the full 1.2.0
 * MemoryAccess (core + extended) with simple in-memory behavior — this fake
 * is never exercised through its extended methods by the tests below (they
 * only assert core-verb local/wire routing), so the extended stubs just need
 * to satisfy the type honestly, not model every edge case the real registry
 * covers.
 */
function createFakeLocalAccess(): { access: MemoryAccess; records: Map<string, MemoryRecord> } {
  const records = new Map<string, MemoryRecord>();
  const links: MemoryLink[] = [];
  let seq = 0;
  const access: MemoryAccess = {
    add: async (opts) => {
      const record: MemoryRecord = {
        id: `local-${++seq}`,
        scope: opts.scope ?? 'project',
        cls: opts.cls,
        summary: opts.summary,
        detail: opts.detail,
        tags: opts.tags ?? [],
        provenance: opts.provenance ?? [],
        reviewState: opts.review?.state ?? 'fresh',
        confidence: opts.review?.confidence ?? 60,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      records.set(record.id, record);
      return record;
    },
    honestSearch: async () => ({
      records: [...records.values()],
      mode: 'literal',
      requestedSemantic: false,
      indexUnavailableReason: null,
      caveat: null,
      recallFiltered: false,
      excludedFlaggedCount: 0,
      excludedBelowFloorCount: 0,
      excludedOutOfWindowCount: 0,
      totalBeforeRecallFilter: records.size,
      recallFloor: 60,
    }),
    get: async (id) => records.get(id) ?? null,
    updateReview: async (id, patch) => {
      const record = records.get(id);
      if (!record) return null;
      Object.assign(record, patch);
      return record;
    },
    delete: async (id) => records.delete(id),
    list: async () => [...records.values()],
    searchSemantic: async () => [...records.values()].map((record) => ({ record, distance: 0, similarity: 1, score: 1 })),
    update: async (id, patch) => {
      const record = records.get(id);
      if (!record) return null;
      Object.assign(record, patch);
      return record;
    },
    link: async (fromId, toId, relation) => {
      if (!records.has(fromId) || !records.has(toId)) return null;
      const link: MemoryLink = { fromId, toId, relation, createdAt: Date.now() };
      links.push(link);
      return link;
    },
    linksFor: async (id) => links.filter((link) => link.fromId === id || link.toId === id),
    reviewQueue: async (limit) => [...records.values()].slice(0, limit ?? 10),
    exportBundle: async () => ({
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      scope: 'all',
      recordCount: records.size,
      linkCount: links.length,
      records: [...records.values()],
      links: [...links],
    }),
    importBundle: async (bundle) => {
      let importedRecords = 0;
      let skippedRecords = 0;
      for (const record of bundle.records) {
        if (records.has(record.id)) { skippedRecords++; continue; }
        records.set(record.id, record);
        importedRecords++;
      }
      let importedLinks = 0;
      for (const link of bundle.links) {
        if (records.has(link.fromId) && records.has(link.toId)) { links.push(link); importedLinks++; }
      }
      return { importedRecords, skippedRecords, importedLinks };
    },
    vectorStats: async () => ({
      backend: 'sqlite-vec',
      enabled: false,
      available: false,
      path: '',
      dimensions: 0,
      indexedRecords: 0,
      embeddingProviderId: 'none',
      embeddingProviderLabel: 'none',
    }),
    doctor: async () => ({
      vector: {
        backend: 'sqlite-vec',
        enabled: false,
        available: false,
        path: '',
        dimensions: 0,
        indexedRecords: 0,
        embeddingProviderId: 'none',
        embeddingProviderLabel: 'none',
      },
      embeddings: {
        activeProviderId: 'none',
        providers: [],
        asyncProviders: [],
        syncProviders: [],
        warnings: [],
      },
      checkedAt: Date.now(),
    }),
  };
  return { access, records };
}

interface Harness {
  readonly daemon: BootedDaemon;
  readonly homeDirectory: string;
  readonly workingDir: string;
}

async function startHarness(): Promise<Harness> {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'goodvibes-memory-spine-daemon-home-'));
  const workingDir = mkdtempSync(join(tmpdir(), 'goodvibes-memory-spine-daemon-project-'));
  const daemon = await bootDaemon({ homeDirectory, workingDir, port: 0, token: TOKEN });
  return { daemon, homeDirectory, workingDir };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.daemon.stop();
  rmSync(harness.homeDirectory, { recursive: true, force: true });
  rmSync(harness.workingDir, { recursive: true, force: true });
}

describe('MemorySpineClient against a real bootDaemon (isolated home, ephemeral port)', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await stopHarness(harness);
    harness = null;
  });

  test('local mode (no daemon adopted): reads/writes stay on the local store, never the daemon', async () => {
    harness = await startHarness();
    const { access: local, records } = createFakeLocalAccess();
    const client = new MemorySpineClient({ local, log: { debug: () => {}, info: () => {} } });
    expect(client.mode()).toBe('local');

    const record = await client.add({ cls: 'fact', summary: 'stays local' });
    expect(client.mode()).toBe('local');
    expect(records.has(record.id)).toBe(true);

    // The daemon's own canonical registry never saw this write — local mode
    // structurally never touches the transport.
    expect(harness.daemon.memory.get(record.id)).toBeNull();

    const fetched = await client.get(record.id);
    expect(fetched?.summary).toBe('stays local');
  }, TEST_BUDGET_MS);

  test('activating on an adopted daemon routes add/get/search/review/delete through the wire to the daemon\'s own canonical registry', async () => {
    harness = await startHarness();
    const { access: local } = createFakeLocalAccess();
    const client = new MemorySpineClient({ local, log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiMemorySpineTransport({ baseUrl: harness.daemon.url, authToken: TOKEN }));
    expect(client.mode()).toBe('client');

    const record = await client.add({ cls: 'decision', summary: 'wire-routed record' });

    // Visible on the DAEMON's own registry — not a detached local copy — proving
    // the write actually crossed the wire rather than landing in `local`.
    expect(harness.daemon.memory.get(record.id)?.summary).toBe('wire-routed record');

    const fetched = await client.get(record.id);
    expect(fetched?.id).toBe(record.id);

    const searchResult = await client.honestSearch({ limit: 10 });
    expect(searchResult.records.some((r) => r.id === record.id)).toBe(true);

    const reviewed = await client.updateReview(record.id, { state: 'reviewed', confidence: 95 });
    expect(reviewed?.reviewState).toBe('reviewed');
    expect(harness.daemon.memory.get(record.id)?.reviewState).toBe('reviewed');

    const deleted = await client.delete(record.id);
    expect(deleted).toBe(true);
    expect(harness.daemon.memory.get(record.id)).toBeNull();
  }, TEST_BUDGET_MS);

  test('a get() for an id the daemon has never seen resolves null over the wire (honest 404, not a thrown error)', async () => {
    harness = await startHarness();
    const { access: local } = createFakeLocalAccess();
    const client = new MemorySpineClient({ local, log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiMemorySpineTransport({ baseUrl: harness.daemon.url, authToken: TOKEN }));

    await expect(client.get('no-such-record')).resolves.toBeNull();
    await expect(client.updateReview('no-such-record', { state: 'stale' })).resolves.toBeNull();
  }, TEST_BUDGET_MS);
});

describe('memory-spine version-skew wire honesty (route-not-found vs record-missing 404)', () => {
  // A fake fetch that answers every request with one canned JSON response — lets a
  // test drive the transport's 404 discrimination without a live daemon.
  function cannedFetch(status: number, body: object): typeof fetch {
    return (async () => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  }
  const routeNotFound = { error: 'Route not found', code: 'NOT_FOUND', category: 'not_found', status: 404 };
  const recordMissing = { error: 'Unknown memory record', code: 'MEMORY_RECORD_NOT_FOUND', category: 'not_found', status: 404 };

  test('a NULLABLE verb (update) against an older daemon (route-not-found 404) REJECTS honestly, never nulls', async () => {
    const transport = createTuiMemorySpineTransport({
      baseUrl: 'http://127.0.0.1:9', authToken: 'tok', fetchImpl: cannedFetch(404, routeNotFound),
    });
    await expect(transport.update!('mem_x', { summary: 's' })).rejects.toThrow(/does not support the 'update' memory verb/);
  }, TEST_BUDGET_MS);

  test('a NULLABLE verb (update) against a current daemon with a missing record (record-missing 404) resolves null', async () => {
    const transport = createTuiMemorySpineTransport({
      baseUrl: 'http://127.0.0.1:9', authToken: 'tok', fetchImpl: cannedFetch(404, recordMissing),
    });
    await expect(transport.update!('mem_x', { summary: 's' })).resolves.toBeNull();
  }, TEST_BUDGET_MS);

  test('a NON-NULLABLE verb (list) against an older daemon (route-not-found 404) REJECTS honestly instead of a raw 404', async () => {
    const transport = createTuiMemorySpineTransport({
      baseUrl: 'http://127.0.0.1:9', authToken: 'tok', fetchImpl: cannedFetch(404, routeNotFound),
    });
    await expect(transport.list!({})).rejects.toThrow(/does not support the 'list' memory verb/);
  }, TEST_BUDGET_MS);

  test('a bare legacy 404 with no code is treated as method-unavailable, never a silent null', async () => {
    const transport = createTuiMemorySpineTransport({
      baseUrl: 'http://127.0.0.1:9', authToken: 'tok', fetchImpl: cannedFetch(404, { error: 'Not found' }),
    });
    await expect(transport.update!('mem_x', { summary: 's' })).rejects.toThrow(/does not support the 'update' memory verb/);
  }, TEST_BUDGET_MS);
});

describe('memory-spine recall honesty passthrough', () => {
  test('indexUnavailableReason from the wire transport survives to the caller unchanged (never dropped or re-derived)', async () => {
    const reason = 'semantic index unavailable: sqlite-vec extension not loaded';
    // Typed as MemoryTransport (core-only) rather than the full MemoryAccess —
    // version tolerance: a transport implementing only the CORE verbs is valid;
    // this spy never exercises an extended verb.
    const spyTransport: MemoryTransport = {
      add: async () => { throw new Error('unused in this test'); },
      honestSearch: async () => ({
        records: [],
        mode: 'literal',
        requestedSemantic: true,
        indexUnavailableReason: reason,
        caveat: null,
        recallFiltered: false,
        excludedFlaggedCount: 0,
        excludedBelowFloorCount: 0,
        excludedOutOfWindowCount: 0,
        totalBeforeRecallFilter: 0,
        recallFloor: 60,
      }),
      get: async () => null,
      updateReview: async () => null,
      delete: async () => false,
    };
    const { access: local } = createFakeLocalAccess();
    const client = new MemorySpineClient({ local, log: { debug: () => {}, info: () => {} } });
    client.activate(spyTransport);

    const result = await client.honestSearch({ query: 'anything', semantic: true }, { recall: true });
    expect(result.indexUnavailableReason).toBe(reason);
    expect(result.mode).toBe('literal');
    expect(result.requestedSemantic).toBe(true);
  }, TEST_BUDGET_MS);
});

describe('memory-spine deactivation on daemon loss', () => {
  test('reverts to local access with the SDK\'s own honest logged note; further writes land locally', async () => {
    const { access: local, records } = createFakeLocalAccess();
    const notes: Array<{ message: string; meta: unknown }> = [];
    const client = new MemorySpineClient({
      local,
      log: { debug: () => {}, info: (message, meta) => { notes.push({ message, meta }); } },
    });
    const activeRef: MemorySpineActiveRef = { value: null };
    const log = { info: () => {} };

    // Adopt an external daemon (fake baseUrl — this test only exercises the
    // activate/deactivate state machine, not a live wire round-trip).
    syncMemorySpineToHostStatus(client, 'external', 'http://127.0.0.1:9', 'tok', activeRef, log);
    expect(client.mode()).toBe('client');
    expect(activeRef.value).toBe('http://127.0.0.1:9');

    // Daemon lost — mode changes away from 'external'.
    syncMemorySpineToHostStatus(client, 'unavailable', 'http://127.0.0.1:9', 'tok', activeRef, log);
    expect(client.mode()).toBe('local');
    expect(activeRef.value).toBeNull();

    // The SDK client itself logs the honest note on deactivate — not a silent flip.
    const deactivateNote = notes.find((n) => n.message.includes('deactivated'));
    expect(deactivateNote?.message).toBe('memory spine deactivated — reverting to owned-local memory access');
    expect(deactivateNote?.meta).toEqual({ reason: "daemon mode changed to 'unavailable'" });

    // A write now lands on the LOCAL store again, not any wire target.
    const record = await client.add({ cls: 'fact', summary: 'back to local after daemon loss' });
    expect(records.has(record.id)).toBe(true);
  }, TEST_BUDGET_MS);
});
