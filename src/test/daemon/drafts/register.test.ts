import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { GatewayMethodInvocation } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { HandlerContext } from '../../../daemon/handlers/context.ts';
import type { AtRestCipher } from '../../../daemon/handlers/credentials.ts';
import type { Unregister } from '../../../daemon/handlers/register.ts';
import {
  DraftSyncStore,
  registerDraftMethods,
} from '../../../daemon/handlers/drafts/index.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

const LIST = 'channels.drafts.list';
const GET = 'channels.drafts.get';
const SAVE = 'channels.drafts.save';
const DELETE = 'channels.drafts.delete';

function makeFakeCipher(): AtRestCipher {
  return {
    async encrypt(plaintext: string): Promise<string> {
      return `enc:${Buffer.from(plaintext, 'utf-8').toString('base64')}`;
    },
    async decrypt(ciphertext: string): Promise<string> {
      return Buffer.from(ciphertext.replace(/^enc:/, ''), 'base64').toString('utf-8');
    },
  };
}

function makeContext(catalog: GatewayMethodCatalog, workingDirectory: string): HandlerContext {
  return {
    catalog,
    credentials: {
      async resolveRef() {
        return null;
      },
      async resolveConfigSecret() {
        return null;
      },
      async put() {},
      async has() {
        return false;
      },
    },
    configManager: {
      get: () => undefined,
      getCategory: () => ({}),
    } as unknown as HandlerContext['configManager'],
    workingDirectory,
    homeDirectory: workingDirectory,
    logger: { info() {}, warn() {}, error() {} },
  };
}

/** Build an SDK invocation envelope. explicitUserRequest rides in context.metadata. */
function invocation(
  body: unknown,
  opts: { explicit?: boolean } = {},
): GatewayMethodInvocation {
  return {
    body,
    query: {},
    context: {
      authToken: 'token',
      principalId: 'op-1',
      admin: true,
      scopes: ['read:channels', 'write:channels'],
      metadata: { explicitUserRequest: opts.explicit ?? false },
    },
  } as unknown as GatewayMethodInvocation;
}

const confirmedSave = (body: Record<string, unknown>): GatewayMethodInvocation =>
  invocation({ ...body, confirm: true }, { explicit: true });

describe('registerDraftMethods', () => {
  let dir: string;
  let catalog: GatewayMethodCatalog;
  let store: DraftSyncStore;
  let unregister: Unregister;

  beforeEach(async () => {
    dir = makeProjectTempDir('gv-drafts-reg');
    catalog = new GatewayMethodCatalog();
    let n = 0;
    let clock = 1_000;
    store = new DraftSyncStore({
      workingDirectory: dir,
      cipher: makeFakeCipher(),
      generateId: () => {
        n += 1;
        return `id-${n}`;
      },
      now: () => {
        clock += 1;
        return new Date(clock).toISOString();
      },
    });
    await store.init();
    const ctx = makeContext(catalog, dir);
    unregister = registerDraftMethods(ctx, { store });
  });

  afterEach(() => {
    unregister();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('attaches handlers to the four canonical SDK descriptors', () => {
    for (const id of [LIST, GET, SAVE, DELETE]) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('does not re-author the SDK descriptors (scopes/access preserved)', () => {
    expect(catalog.get(SAVE)?.access).toBe('admin');
    expect(catalog.get(DELETE)?.dangerous).toBe(true);
    expect(catalog.get(LIST)?.scopes).toContain('read:channels');
    expect(catalog.get(SAVE)?.scopes).toContain('write:channels');
  });

  test('save returns { draft, created } and list returns { drafts, total }', async () => {
    const saved = (await catalog.invoke(
      SAVE,
      confirmedSave({ message: 'hello' }),
    )) as { draft: { id: string; message: string }; created: boolean };
    expect(saved.created).toBe(true);
    expect(saved.draft.id).toBe('id-1');
    expect(saved.draft.message).not.toBe('hello'); // digest, not body

    const listed = (await catalog.invoke(LIST, invocation({}))) as {
      drafts: unknown[];
      total: number;
    };
    expect(listed.total).toBe(1);
    expect(listed.drafts.length).toBe(1);
  });

  test('get returns a flat draft with messageDigest, or a notFound marker', async () => {
    const saved = (await catalog.invoke(
      SAVE,
      confirmedSave({ message: 'body' }),
    )) as { draft: { id: string } };
    const got = (await catalog.invoke(GET, invocation({ draftId: saved.draft.id }))) as {
      id: string;
      message: string;
      messageDigest: string;
      notFound?: boolean;
    };
    expect(got.notFound).toBeUndefined();
    expect(got.id).toBe(saved.draft.id);
    expect(got.messageDigest).toBe(got.message);

    const missing = (await catalog.invoke(GET, invocation({ draftId: 'ghost' }))) as {
      notFound: boolean;
      id: string;
    };
    expect(missing.notFound).toBe(true);
    expect(missing.id).toBe('ghost');
  });

  test('delete returns { deleted, draftId }', async () => {
    const saved = (await catalog.invoke(
      SAVE,
      confirmedSave({ message: 'x' }),
    )) as { draft: { id: string } };
    const del = (await catalog.invoke(
      DELETE,
      invocation({ draftId: saved.draft.id, confirm: true }, { explicit: true }),
    )) as { deleted: boolean; draftId: string };
    expect(del.deleted).toBe(true);
    expect(del.draftId).toBe(saved.draft.id);
  });

  test('save is confirm-gated: rejected without confirm + explicitUserRequest', async () => {
    // missing confirm
    await expect(
      catalog.invoke(SAVE, invocation({ message: 'm' }, { explicit: true })),
    ).rejects.toThrow(/confirmation/i);
    // confirm:true but not an explicit user request
    await expect(
      catalog.invoke(SAVE, invocation({ message: 'm', confirm: true }, { explicit: false })),
    ).rejects.toThrow(/confirmation/i);
  });

  test('delete is confirm-gated', async () => {
    await expect(
      catalog.invoke(DELETE, invocation({ draftId: 'whatever' }, { explicit: true })),
    ).rejects.toThrow(/confirmation/i);
  });

  test('save rejects a RAW webhook URL (redaction required)', async () => {
    await expect(
      catalog.invoke(
        SAVE,
        confirmedSave({ message: 'm', webhook: 'https://hooks.example.com/services/aaa/bbb' }),
      ),
    ).rejects.toThrow(/redact/i);
  });

  test('save accepts a redacted webhook and a goodvibes secret reference', async () => {
    const a = (await catalog.invoke(
      SAVE,
      confirmedSave({ message: 'm', webhook: '[redacted]' }),
    )) as { draft: { webhook?: string } };
    expect(a.draft.webhook).toBe('[redacted]');
    const b = (await catalog.invoke(
      SAVE,
      confirmedSave({ message: 'm', webhook: 'goodvibes://secrets/MY_HOOK' }),
    )) as { draft: { webhook?: string } };
    expect(b.draft.webhook).toBe('[redacted]');
  });

  test('save rejects a non-writable status and a missing message', async () => {
    await expect(
      catalog.invoke(SAVE, confirmedSave({ message: 'm', status: 'sent' })),
    ).rejects.toThrow(/status/i);
    await expect(catalog.invoke(SAVE, confirmedSave({}))).rejects.toThrow(/message/i);
  });

  test('list rejects a non-integer limit', async () => {
    await expect(catalog.invoke(LIST, invocation({ limit: 1.5 }))).rejects.toThrow(/limit/i);
  });

  test('teardown removes the handlers from the catalog', () => {
    unregister();
    for (const id of [LIST, GET, SAVE, DELETE]) {
      expect(catalog.hasHandler(id)).toBe(false);
    }
    // afterEach calls unregister() again; the batch teardown is best-effort and
    // the injected store is owned by the test, so the double-call is safe.
  });
});
