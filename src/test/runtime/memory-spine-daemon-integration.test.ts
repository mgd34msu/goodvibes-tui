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
import type { MemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { MemoryRecord } from '@pellux/goodvibes-sdk/platform/state';
import { createTuiMemorySpineTransport, syncMemorySpineToHostStatus, type MemorySpineActiveRef } from '../../runtime/memory-spine-transport.ts';

const TOKEN = 'memory-spine-integration-token';

/** A minimal, isolated in-memory MemoryAccess standing in for the TUI's own local registry — the offline/host backend. Exposes its record map so tests can assert a write never reached it (or did). */
function createFakeLocalAccess(): { access: MemoryAccess; records: Map<string, MemoryRecord> } {
  const records = new Map<string, MemoryRecord>();
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
      totalBeforeRecallFilter: records.size,
    }),
    get: async (id) => records.get(id) ?? null,
    updateReview: async (id, patch) => {
      const record = records.get(id);
      if (!record) return null;
      Object.assign(record, patch);
      return record;
    },
    delete: async (id) => records.delete(id),
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
  });

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
  });

  test('a get() for an id the daemon has never seen resolves null over the wire (honest 404, not a thrown error)', async () => {
    harness = await startHarness();
    const { access: local } = createFakeLocalAccess();
    const client = new MemorySpineClient({ local, log: { debug: () => {}, info: () => {} } });
    client.activate(createTuiMemorySpineTransport({ baseUrl: harness.daemon.url, authToken: TOKEN }));

    await expect(client.get('no-such-record')).resolves.toBeNull();
    await expect(client.updateReview('no-such-record', { state: 'stale' })).resolves.toBeNull();
  });
});

describe('memory-spine recall honesty passthrough', () => {
  test('indexUnavailableReason from the wire transport survives to the caller unchanged (never dropped or re-derived)', async () => {
    const reason = 'semantic index unavailable: sqlite-vec extension not loaded';
    const spyTransport: MemoryAccess = {
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
        totalBeforeRecallFilter: 0,
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
  });
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
  });
});
