import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayMethodInvocation } from '@pellux/goodvibes-sdk/platform/control-plane';
import type {
  AtRestCipher,
  OperatorContext,
  Unregister,
} from '../../../daemon/operator/index.ts';
import { OperatorSqliteStore, sha256First } from '../../../daemon/operator/index.ts';
import {
  DRAFT_MESSAGE_DIGEST_HEX,
  DraftSyncStore,
  MAX_DRAFT_LIST_LIMIT,
  registerDraftsMethods,
} from '../../../daemon/channels/drafts/index.ts';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// Deterministic reversible cipher: NOT real crypto, but exercises the
// encrypt-at-rest contract (store persists ciphertext, never plaintext).
function makeFakeCipher(): AtRestCipher & { encryptCalls: string[] } {
  const encryptCalls: string[] = [];
  return {
    encryptCalls,
    async encrypt(plaintext: string): Promise<string> {
      encryptCalls.push(plaintext);
      return `enc:${Buffer.from(plaintext, 'utf-8').toString('base64')}`;
    },
    async decrypt(ciphertext: string): Promise<string> {
      const stripped = ciphertext.replace(/^enc:/, '');
      return Buffer.from(stripped, 'base64').toString('utf-8');
    },
  };
}

let idCounter = 0;
function makeStore(workingDirectory: string, cipher: AtRestCipher): DraftSyncStore {
  idCounter = 0;
  let clock = 1_000;
  return new DraftSyncStore({
    workingDirectory,
    cipher,
    generateId: () => {
      idCounter += 1;
      return `id-${idCounter}`;
    },
    now: () => {
      clock += 1;
      return new Date(clock).toISOString();
    },
  });
}

// Minimal fake catalog matching the SDK register/invoke surface used by the
// register-helper foundation.
interface FakeCatalog {
  register: OperatorContext['catalog']['register'];
  invoke: (
    methodId: string,
    input: { body: unknown; context: { principalId: string; metadata?: Record<string, unknown> } },
  ) => Promise<unknown>;
  descriptors: Map<string, unknown>;
}

function makeCatalog(): FakeCatalog {
  const handlers = new Map<string, (input: GatewayMethodInvocation) => Promise<unknown>>();
  const descriptors = new Map<string, unknown>();
  return {
    descriptors,
    register: ((descriptor: { id: string }, handler: (input: GatewayMethodInvocation) => Promise<unknown>) => {
      handlers.set(descriptor.id, handler);
      descriptors.set(descriptor.id, descriptor);
      return () => {
        handlers.delete(descriptor.id);
        descriptors.delete(descriptor.id);
      };
    }) as unknown as OperatorContext['catalog']['register'],
    async invoke(methodId, input) {
      const handler = handlers.get(methodId);
      if (!handler) throw new Error(`no handler for ${methodId}`);
      return handler(input as unknown as GatewayMethodInvocation);
    },
  };
}

function makeContext(workingDirectory: string, catalog: FakeCatalog): OperatorContext {
  return {
    catalog: catalog as unknown as OperatorContext['catalog'],
    secrets: {} as OperatorContext['secrets'],
    configManager: { get: () => undefined, getCategory: () => ({}) } as unknown as OperatorContext['configManager'],
    workingDirectory,
    homeDirectory: workingDirectory,
    logger: { info() {}, warn() {}, error() {} },
  };
}

const invokeCtx = { principalId: 'op-1', metadata: { explicitUserRequest: true } };

// ---------------------------------------------------------------------------
// Store-level tests
// ---------------------------------------------------------------------------

describe('DraftSyncStore', () => {
  let dir: string;
  let cipher: ReturnType<typeof makeFakeCipher>;
  let store: DraftSyncStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gv-drafts-'));
    cipher = makeFakeCipher();
    store = makeStore(dir, cipher);
    await store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('create assigns a uuid and reports created:true', async () => {
    const result = await store.upsert({ message: 'hello world' });
    expect(result.created).toBe(true);
    expect(result.id).toBe('id-1');
  });

  test('stores body encrypted at rest and never returns plaintext', async () => {
    const { id } = await store.upsert({ message: 'secret body' });
    expect(cipher.encryptCalls).toContain('secret body');
    const record = store.get(id);
    expect(record).not.toBeNull();
    // No body / bodyEnc field on the public record.
    expect(JSON.stringify(record)).not.toContain('secret body');
    expect((record as unknown as Record<string, unknown>).body).toBeUndefined();
    expect((record as unknown as Record<string, unknown>).bodyEnc).toBeUndefined();
  });

  test('computes messageDigest = sha256First(body, 12)', async () => {
    const { id } = await store.upsert({ message: 'digest me' });
    const record = store.get(id)!;
    expect(record.messageDigest).toBe(sha256First('digest me', DRAFT_MESSAGE_DIGEST_HEX));
    expect(record.messageDigest).toHaveLength(DRAFT_MESSAGE_DIGEST_HEX);
  });

  test('redacts webhook in get/list responses', async () => {
    const { id } = await store.upsert({
      message: 'm',
      webhook: 'https://hooks.example.com/abc/secret-token',
    });
    const record = store.get(id)!;
    expect(record.webhook).toBe('[redacted]');
    expect(JSON.stringify(record)).not.toContain('secret-token');
    const listed = store.list();
    expect(listed[0]!.webhook).toBe('[redacted]');
    expect(JSON.stringify(listed)).not.toContain('secret-token');
  });

  test('omits webhook entirely when none stored', async () => {
    const { id } = await store.upsert({ message: 'm' });
    const record = store.get(id)!;
    expect(record.webhook).toBeUndefined();
  });

  test('update preserves createdAt, bumps updatedAt, created:false', async () => {
    const { id } = await store.upsert({ message: 'v1', title: 'orig' });
    const first = store.get(id)!;
    const result = await store.upsert({ id, message: 'v2', title: 'updated' });
    expect(result.created).toBe(false);
    expect(result.id).toBe(id);
    const second = store.get(id)!;
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(second.title).toBe('updated');
    expect(second.messageDigest).toBe(sha256First('v2', DRAFT_MESSAGE_DIGEST_HEX));
  });

  test('save with explicit id that does not exist creates that id', async () => {
    const result = await store.upsert({ id: 'custom-id', message: 'm' });
    expect(result.created).toBe(true);
    expect(result.id).toBe('custom-id');
    expect(store.get('custom-id')).not.toBeNull();
  });

  test('round-trips tags as a string array', async () => {
    const { id } = await store.upsert({ message: 'm', tags: ['a', 'b'] });
    expect(store.get(id)!.tags).toEqual(['a', 'b']);
  });

  // Full-replace semantics: upsert treats caller input as a complete snapshot,
  // not a partial patch. Updating without re-supplying an optional field clears
  // the stored value. See DraftSyncStore.upsert FULL-REPLACE SEMANTICS note.
  test('update without re-supplying webhook clears the stored webhook', async () => {
    const { id } = await store.upsert({
      message: 'm',
      webhook: 'https://hooks.example.com/abc/secret-token',
    });
    // Sanity: webhook is stored (and redacted on read) before the update.
    expect(store.get(id)!.webhook).toBe('[redacted]');

    // Update omits webhook entirely -> full-replace wipes the stored value.
    await store.upsert({ id, message: 'm2' });
    const after = store.get(id)!;
    expect(after.webhook).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain('secret-token');
  });

  test('update without re-supplying tags removes the stored tags', async () => {
    const { id } = await store.upsert({ message: 'm', tags: ['a', 'b'] });
    expect(store.get(id)!.tags).toEqual(['a', 'b']);

    // Update omits tags entirely -> full-replace removes them.
    await store.upsert({ id, message: 'm2' });
    expect(store.get(id)!.tags).toBeUndefined();
  });

  test('update full-replaces optional metadata fields when omitted', async () => {
    const { id } = await store.upsert({
      message: 'm',
      title: 'orig',
      channel: 'general',
      route: 'r1',
      link: 'https://example.com/x',
    });
    const before = store.get(id)!;
    expect(before.title).toBe('orig');
    expect(before.channel).toBe('general');
    expect(before.route).toBe('r1');
    expect(before.link).toBe('https://example.com/x');

    // Update supplies only message -> every omitted optional field is cleared.
    await store.upsert({ id, message: 'm2' });
    const after = store.get(id)!;
    expect(after.title).toBeUndefined();
    expect(after.channel).toBeUndefined();
    expect(after.route).toBeUndefined();
    expect(after.link).toBeUndefined();
    // Re-supplied required field is still updated.
    expect(after.messageDigest).toBe(sha256First('m2', DRAFT_MESSAGE_DIGEST_HEX));
  });

  test('list filters by status and clamps limit to max', async () => {
    await store.upsert({ message: 'd1', status: 'draft' });
    await store.upsert({ message: 'q1', status: 'queued' });
    await store.upsert({ message: 'd2', status: 'draft' });
    const drafts = store.list({ status: 'draft' });
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.status === 'draft')).toBe(true);
    // limit clamp does not throw and returns within bounds
    const clamped = store.list({ limit: MAX_DRAFT_LIST_LIMIT + 5000 });
    expect(clamped.length).toBeLessThanOrEqual(MAX_DRAFT_LIST_LIMIT);
  });

  test('list orders by updatedAt descending (most recent first)', async () => {
    const a = await store.upsert({ message: 'a' });
    await store.upsert({ message: 'b' });
    // touch a -> becomes most recent
    await store.upsert({ id: a.id, message: 'a2' });
    const ids = store.list().map((d) => d.id);
    expect(ids[0]).toBe(a.id);
  });

  test('persists a caller-supplied updatedAt verbatim (conflict model)', async () => {
    const supplied = '2030-01-02T03:04:05.000Z';
    const { id } = await store.upsert({ message: 'm', updatedAt: supplied });
    expect(store.get(id)!.updatedAt).toBe(supplied);
  });

  test('falls back to now() when updatedAt is omitted', async () => {
    const { id } = await store.upsert({ message: 'm' });
    // The injected clock starts at 1_000ms and increments per call.
    expect(store.get(id)!.updatedAt).toBe(new Date(1_001).toISOString());
  });

  test('caller updatedAt drives most-recent-wins ordering', async () => {
    // a is written second by wall-clock but carries the newer updatedAt, so it
    // must sort ahead of b — proving the conflict model is expressible.
    const b = await store.upsert({ message: 'b', updatedAt: '2020-01-01T00:00:00.000Z' });
    const a = await store.upsert({ message: 'a', updatedAt: '2025-01-01T00:00:00.000Z' });
    const ids = store.list().map((d) => d.id);
    expect(ids[0]).toBe(a.id);
    expect(ids[1]).toBe(b.id);
  });

  test('delete returns true when present, false when absent', async () => {
    const { id } = await store.upsert({ message: 'm' });
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeNull();
    expect(store.delete(id)).toBe(false);
    expect(store.delete('never-existed')).toBe(false);
  });

  // The send pipeline owns sentResponseId/sendError: upsert() always writes them
  // as NULL (they are deliberately omitted from the ON CONFLICT UPDATE SET clause
  // so a save() preserves them). They are therefore set out-of-band by the send
  // path via a raw UPDATE. This round-trips a row whose send-pipeline columns are
  // populated and asserts the toRecord() branches surface them on both get + list.
  test('surfaces sentResponseId and sendError when the send pipeline populates them', async () => {
    const { id } = await store.upsert({ message: 'sent body', status: 'queued' });
    await store.save();

    // Simulate the send pipeline writing the terminal columns directly, exactly
    // as it does in production (these are not writable through upsert()).
    const sidecar = new OperatorSqliteStore({
      workingDirectory: dir,
      fileName: 'drafts.sqlite',
      schema: [
        `CREATE TABLE IF NOT EXISTS drafts (
           id TEXT PRIMARY KEY,
           createdAt TEXT NOT NULL,
           updatedAt TEXT NOT NULL,
           status TEXT NOT NULL,
           title TEXT,
           bodyEnc TEXT NOT NULL,
           messageDigest TEXT NOT NULL,
           channel TEXT,
           route TEXT,
           webhookEnc TEXT,
           link TEXT,
           tags TEXT,
           sentResponseId TEXT,
           sendError TEXT
         )`,
      ],
    });
    await sidecar.init();
    sidecar.run(
      'UPDATE drafts SET status = ?, sentResponseId = ?, sendError = ? WHERE id = ?',
      ['sent', 'resp-123', 'rate limited', id],
    );
    await sidecar.save();
    sidecar.close();

    // Reopen the DraftSyncStore against the persisted db so it reads the row the
    // send pipeline wrote — exercising the toRecord() surfacing branches.
    store.close();
    store = makeStore(dir, cipher);
    await store.init();

    const viaGet = store.get(id)!;
    expect(viaGet.sentResponseId).toBe('resp-123');
    expect(viaGet.sendError).toBe('rate limited');

    const viaList = store.list({ status: 'sent' });
    expect(viaList).toHaveLength(1);
    expect(viaList[0]!.sentResponseId).toBe('resp-123');
    expect(viaList[0]!.sendError).toBe('rate limited');
  });

  test('persists across save/reopen (mirror survives restart)', async () => {
    const { id } = await store.upsert({ message: 'persisted', title: 't' });
    await store.save();
    expect(existsSync(store.dbPath)).toBe(true);
    store.close();
    const reopened = makeStore(dir, cipher);
    await reopened.init();
    const record = reopened.get(id);
    expect(record).not.toBeNull();
    expect(record!.title).toBe('t');
    reopened.close();
  });
});

// ---------------------------------------------------------------------------
// Register / catalog integration tests
// ---------------------------------------------------------------------------

describe('registerDraftsMethods', () => {
  let dir: string;
  let catalog: FakeCatalog;
  let store: DraftSyncStore;
  let unregister: Unregister;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-drafts-reg-'));
    catalog = makeCatalog();
    store = makeStore(dir, makeFakeCipher());
    const ctx = makeContext(dir, catalog);
    unregister = registerDraftsMethods(ctx, { store });
  });

  afterEach(() => {
    unregister();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('registers all four methods with correct metadata', () => {
    expect([...catalog.descriptors.keys()].sort()).toEqual([
      'channels.drafts.delete',
      'channels.drafts.get',
      'channels.drafts.list',
      'channels.drafts.save',
    ]);
    // save/delete map to admin access (operator -> admin via foundation).
    const save = catalog.descriptors.get('channels.drafts.save') as { access: string; source: string };
    expect(save.access).toBe('admin');
    expect(save.source).toBe('builtin');
  });

  test('save then list returns messageDigest, never the body, webhook redacted', async () => {
    const saved = (await catalog.invoke('channels.drafts.save', {
      body: { message: 'top secret', webhook: 'https://hook/xyz-token', tags: ['x'] },
      context: invokeCtx,
    })) as { id: string; created: boolean };
    expect(saved.created).toBe(true);

    const listed = (await catalog.invoke('channels.drafts.list', {
      body: {},
      context: invokeCtx,
    })) as { drafts: Array<Record<string, unknown>> };
    expect(listed.drafts).toHaveLength(1);
    const record = listed.drafts[0]!;
    expect(record.messageDigest).toBe(sha256First('top secret', DRAFT_MESSAGE_DIGEST_HEX));
    expect(record.webhook).toBe('[redacted]');
    expect(JSON.stringify(listed)).not.toContain('top secret');
    expect(JSON.stringify(listed)).not.toContain('xyz-token');
  });

  test('get returns notFound for missing id', async () => {
    const result = (await catalog.invoke('channels.drafts.get', {
      body: { id: 'missing' },
      context: invokeCtx,
    })) as { notFound?: boolean; id?: string };
    expect(result.notFound).toBe(true);
    expect(result.id).toBe('missing');
  });

  test('get returns the record for an existing id', async () => {
    const saved = (await catalog.invoke('channels.drafts.save', {
      body: { message: 'hi', title: 'T' },
      context: invokeCtx,
    })) as { id: string };
    const result = (await catalog.invoke('channels.drafts.get', {
      body: { id: saved.id },
      context: invokeCtx,
    })) as Record<string, unknown>;
    expect(result.id).toBe(saved.id);
    expect(result.title).toBe('T');
    expect(result.notFound).toBeUndefined();
  });

  test('delete returns deleted flag', async () => {
    const saved = (await catalog.invoke('channels.drafts.save', {
      body: { message: 'bye' },
      context: invokeCtx,
    })) as { id: string };
    const del = (await catalog.invoke('channels.drafts.delete', {
      body: { id: saved.id },
      context: invokeCtx,
    })) as { deleted: boolean };
    expect(del.deleted).toBe(true);
    const again = (await catalog.invoke('channels.drafts.delete', {
      body: { id: saved.id },
      context: invokeCtx,
    })) as { deleted: boolean };
    expect(again.deleted).toBe(false);
  });

  // Durability via the shipped handler path: saveHandler/deleteHandler call
  // store.save() after every mutation so the mirror survives a daemon restart.
  // Spy on the injected store's save() and assert it fires through the operator
  // invocation — not just at the raw store level.
  test('save handler persists via store.save() after the mutation', async () => {
    const calls: number[] = [];
    const originalSave = store.save.bind(store);
    let n = 0;
    store.save = async () => {
      n += 1;
      calls.push(n);
      await originalSave();
    };
    await catalog.invoke('channels.drafts.save', {
      body: { message: 'durable' },
      context: invokeCtx,
    });
    expect(calls).toHaveLength(1);
    store.save = originalSave;
  });

  test('delete handler persists via store.save() only when a row was removed', async () => {
    const saved = (await catalog.invoke('channels.drafts.save', {
      body: { message: 'bye' },
      context: invokeCtx,
    })) as { id: string };

    let saveCount = 0;
    const originalSave = store.save.bind(store);
    store.save = async () => {
      saveCount += 1;
      await originalSave();
    };

    // Real delete → row removed → save() must fire.
    await catalog.invoke('channels.drafts.delete', {
      body: { id: saved.id },
      context: invokeCtx,
    });
    expect(saveCount).toBe(1);

    // No-op delete (already gone) → nothing mutated → save() must NOT fire again.
    await catalog.invoke('channels.drafts.delete', {
      body: { id: saved.id },
      context: invokeCtx,
    });
    expect(saveCount).toBe(1);
    store.save = originalSave;
  });

  test('save without confirm succeeds (local mutation, no confirmation)', async () => {
    const result = (await catalog.invoke('channels.drafts.save', {
      body: { message: 'no confirm needed' },
      context: { principalId: 'op-1' }, // no explicitUserRequest, no confirm
    })) as { created: boolean };
    expect(result.created).toBe(true);
  });

  test('save rejects missing message with invalid-input error', async () => {
    await expect(
      catalog.invoke('channels.drafts.save', { body: {}, context: invokeCtx }),
    ).rejects.toThrow(/message/);
  });

  test('save rejects a non-writable status', async () => {
    await expect(
      catalog.invoke('channels.drafts.save', {
        body: { message: 'm', status: 'sent' },
        context: invokeCtx,
      }),
    ).rejects.toThrow(/status/);
  });

  test('list rejects a non-numeric limit', async () => {
    await expect(
      catalog.invoke('channels.drafts.list', {
        body: { limit: 'lots' },
        context: invokeCtx,
      }),
    ).rejects.toThrow(/limit/);
  });

  test('list rejects a non-integer (float) limit', async () => {
    await expect(
      catalog.invoke('channels.drafts.list', {
        body: { limit: 1.5 },
        context: invokeCtx,
      }),
    ).rejects.toThrow(/integer/);
  });

  test('list rejects an out-of-range limit (below minimum)', async () => {
    await expect(
      catalog.invoke('channels.drafts.list', {
        body: { limit: 0 },
        context: invokeCtx,
      }),
    ).rejects.toThrow(/between 1 and/);
  });

  test('list rejects an out-of-range limit (above maximum)', async () => {
    await expect(
      catalog.invoke('channels.drafts.list', {
        body: { limit: MAX_DRAFT_LIST_LIMIT + 1 },
        context: invokeCtx,
      }),
    ).rejects.toThrow(/between 1 and/);
  });

  test('list accepts the boundary limits 1 and MAX', async () => {
    await expect(
      catalog.invoke('channels.drafts.list', { body: { limit: 1 }, context: invokeCtx }),
    ).resolves.toBeDefined();
    await expect(
      catalog.invoke('channels.drafts.list', {
        body: { limit: MAX_DRAFT_LIST_LIMIT },
        context: invokeCtx,
      }),
    ).resolves.toBeDefined();
  });

  test('save persists a caller-supplied updatedAt (conflict model)', async () => {
    const updatedAt = '2031-05-06T07:08:09.000Z';
    const saved = (await catalog.invoke('channels.drafts.save', {
      body: { message: 'm', updatedAt },
      context: invokeCtx,
    })) as { id: string };
    const record = (await catalog.invoke('channels.drafts.get', {
      body: { id: saved.id },
      context: invokeCtx,
    })) as { updatedAt: string };
    expect(record.updatedAt).toBe(updatedAt);
  });

  test('save rejects a malformed updatedAt', async () => {
    await expect(
      catalog.invoke('channels.drafts.save', {
        body: { message: 'm', updatedAt: 'not-a-timestamp' },
        context: invokeCtx,
      }),
    ).rejects.toThrow(/updatedAt/);
  });

  test('save rejects parseable-but-non-ISO-8601 updatedAt values', async () => {
    // These all pass Date.parse() yet are NOT strict ISO-8601 date-times.
    // Persisting them verbatim would break the DraftRecord.updatedAt
    // format:'date-time' contract, so validation must reject them.
    for (const updatedAt of ['2020', 'Jan 1 2020', '2020-1-1', '2020/01/01']) {
      await expect(
        catalog.invoke('channels.drafts.save', {
          body: { message: 'm', updatedAt },
          context: invokeCtx,
        }),
      ).rejects.toThrow(/updatedAt/);
    }
  });

  test('save normalizes an offset updatedAt to canonical ISO-8601 (Z)', async () => {
    // A strict ISO-8601 value with a non-Z offset is accepted and normalized
    // so the stored/returned updatedAt always honors format:'date-time'.
    const saved = (await catalog.invoke('channels.drafts.save', {
      body: { message: 'm', updatedAt: '2031-05-06T08:08:09.000+01:00' },
      context: invokeCtx,
    })) as { id: string };
    const record = (await catalog.invoke('channels.drafts.get', {
      body: { id: saved.id },
      context: invokeCtx,
    })) as { updatedAt: string };
    expect(record.updatedAt).toBe('2031-05-06T07:08:09.000Z');
  });

  test('get rejects a missing id', async () => {
    await expect(
      catalog.invoke('channels.drafts.get', { body: {}, context: invokeCtx }),
    ).rejects.toThrow(/id/);
  });

  test('unregister removes all methods', () => {
    unregister();
    expect(catalog.descriptors.size).toBe(0);
    // re-register so afterEach unregister() is harmless
    unregister = registerDraftsMethods(makeContext(dir, catalog), { store });
  });
});
