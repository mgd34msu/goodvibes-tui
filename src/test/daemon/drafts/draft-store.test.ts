import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { AtRestCipher } from '../../../daemon/handlers/credentials.ts';
import {
  DRAFT_MESSAGE_DIGEST_HEX,
  DraftSyncStore,
  MAX_DRAFT_LIST_LIMIT,
  sha256First,
} from '../../../daemon/handlers/drafts/draft-store.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

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

function makeStore(workingDirectory: string, cipher: AtRestCipher): DraftSyncStore {
  let idCounter = 0;
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

describe('DraftSyncStore', () => {
  let dir: string;
  let cipher: ReturnType<typeof makeFakeCipher>;
  let store: DraftSyncStore;

  beforeEach(async () => {
    dir = makeProjectTempDir('gv-drafts');
    cipher = makeFakeCipher();
    store = makeStore(dir, cipher);
    await store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('create assigns a uuid, defaults version 1, reports created:true', async () => {
    const result = await store.upsert({ message: 'hello world' });
    expect(result.created).toBe(true);
    expect(result.draft.id).toBe('id-1');
    expect(result.draft.version).toBe(1);
    expect(result.draft.status).toBe('draft');
  });

  test('body is encrypted at rest; plaintext never appears in records', async () => {
    const { draft } = await store.upsert({ message: 'secret body' });
    expect(cipher.encryptCalls).toContain('secret body');
    const record = store.get(draft.id);
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain('secret body');
    const asRec = record as unknown as Record<string, unknown>;
    expect(asRec.body).toBeUndefined();
    expect(asRec.bodyEnc).toBeUndefined();
  });

  test('the message field carries the sha256First(body,12) digest', async () => {
    const body = 'the quick brown fox';
    const { draft } = await store.upsert({ message: body });
    const expected = sha256First(body, DRAFT_MESSAGE_DIGEST_HEX);
    expect(draft.message).toBe(expected);
    expect(draft.message.length).toBe(DRAFT_MESSAGE_DIGEST_HEX);
    expect(draft.message).not.toBe(body);
  });

  test('webhook is encrypted at rest and always redacted on read', async () => {
    const { draft } = await store.upsert({
      message: 'm',
      webhook: '[redacted]',
    });
    expect(draft.webhook).toBe('[redacted]');
    // A raw value passed directly to the store is encrypted then redacted on read.
    const direct = await store.upsert({ message: 'm', webhook: 'opaque-hook-value' });
    expect(cipher.encryptCalls).toContain('opaque-hook-value');
    const record = store.get(direct.draft.id);
    expect(record?.webhook).toBe('[redacted]');
    expect(JSON.stringify(record)).not.toContain('opaque-hook-value');
  });

  test('update preserves createdAt, bumps updatedAt, reports created:false', async () => {
    const created = await store.upsert({ message: 'v1' });
    const original = store.get(created.draft.id)!;
    const updated = await store.upsert({ id: created.draft.id, message: 'v2', version: 2 });
    expect(updated.created).toBe(false);
    expect(updated.draft.createdAt).toBe(original.createdAt);
    expect(updated.draft.version).toBe(2);
    expect(Date.parse(updated.draft.updatedAt)).toBeGreaterThan(Date.parse(original.updatedAt));
  });

  test('caller-supplied updatedAt is persisted verbatim', async () => {
    const ts = '2026-01-02T03:04:05.000Z';
    const { draft } = await store.upsert({ message: 'm', updatedAt: ts });
    expect(draft.updatedAt).toBe(ts);
  });

  test('full-replace: omitting an optional field clears it on update', async () => {
    const created = await store.upsert({ message: 'm', title: 'keep', tags: ['a', 'b'] });
    expect(store.get(created.draft.id)?.title).toBe('keep');
    await store.upsert({ id: created.draft.id, message: 'm2' });
    const after = store.get(created.draft.id)!;
    expect(after.title).toBeUndefined();
    expect(after.tags).toBeUndefined();
  });

  test('list returns newest-updated first and count reflects totals', async () => {
    await store.upsert({ message: 'a' });
    await store.upsert({ message: 'b' });
    const drafts = store.list();
    expect(drafts.length).toBe(2);
    expect(Date.parse(drafts[0]!.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(drafts[1]!.updatedAt),
    );
    expect(store.count()).toBe(2);
  });

  test('list filters by status and count honours the filter', async () => {
    await store.upsert({ message: 'a', status: 'draft' });
    await store.upsert({ message: 'b', status: 'queued' });
    expect(store.list({ status: 'queued' }).map((d) => d.status)).toEqual(['queued']);
    expect(store.count('queued')).toBe(1);
    expect(store.count('draft')).toBe(1);
  });

  test('list clamps an over-large limit to MAX_DRAFT_LIST_LIMIT', async () => {
    for (let i = 0; i < 3; i += 1) await store.upsert({ message: `m${i}` });
    const drafts = store.list({ limit: MAX_DRAFT_LIST_LIMIT + 10_000 });
    expect(drafts.length).toBe(3);
  });

  test('get returns null for an unknown id; delete reports existence', async () => {
    expect(store.get('nope')).toBeNull();
    const { draft } = await store.upsert({ message: 'm' });
    expect(store.delete(draft.id)).toBe(true);
    expect(store.delete(draft.id)).toBe(false);
    expect(store.get(draft.id)).toBeNull();
  });

  test('persists across reopen (save + reinit reads the mirror back)', async () => {
    const { draft } = await store.upsert({ message: 'durable' });
    await store.save();
    store.close();
    const reopened = makeStore(dir, cipher);
    await reopened.init();
    try {
      const record = reopened.get(draft.id);
      expect(record?.id).toBe(draft.id);
      expect(record?.message).toBe(sha256First('durable', DRAFT_MESSAGE_DIGEST_HEX));
    } finally {
      reopened.close();
    }
  });
});
