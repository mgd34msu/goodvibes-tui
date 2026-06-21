import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerInboxMethods,
  INBOX_LIST_METHOD_ID,
  INBOX_LIST_SCOPES,
  type InboxListOutput,
} from '../../../daemon/channels/inbox/register.ts';
import { InboxCursorStore } from '../../../daemon/channels/inbox/cursor-store.ts';
import { clearAdapterRegistry } from '../../../daemon/channels/inbox/provider-adapter.ts';
import type { OperatorContext } from '../../../daemon/operator/index.ts';

// ---- Fake catalog (records descriptor + handler) --------------------------
interface CapturedMethod {
  descriptor: Record<string, unknown>;
  handler: (input: { body: unknown; context: { principalId?: string; metadata?: Record<string, unknown> } }) => Promise<unknown>;
}

function makeFakeCatalog() {
  const methods = new Map<string, CapturedMethod>();
  const catalog = {
    register(descriptor: Record<string, unknown>, handler: CapturedMethod['handler']) {
      const id = String(descriptor.id);
      methods.set(id, { descriptor, handler });
      return () => {
        methods.delete(id);
      };
    },
  };
  return { catalog, methods };
}

// ---- Fake secrets manager (always returns null => unavailable) ------------
const nullSecrets = {
  async get() {
    return null;
  },
  async set() {},
} as unknown as OperatorContext['secrets'];

const silentLogger = { info() {}, warn() {}, error() {} };

function makeContext(catalog: ReturnType<typeof makeFakeCatalog>['catalog'], workingDirectory: string): OperatorContext {
  return {
    catalog: catalog as unknown as OperatorContext['catalog'],
    secrets: nullSecrets,
    configManager: { get() { return undefined; }, getCategory() { return {}; } } as unknown as OperatorContext['configManager'],
    workingDirectory,
    homeDirectory: workingDirectory,
    logger: silentLogger,
  };
}

describe('registerInboxMethods', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inbox-register-'));
    clearAdapterRegistry();
  });

  afterEach(async () => {
    clearAdapterRegistry();
    await rm(dir, { recursive: true, force: true });
  });

  test('registers channels.inbox.list as a read-only method with the right scopes', async () => {
    const { catalog, methods } = makeFakeCatalog();
    const ctx = makeContext(catalog, dir);
    const unregister = registerInboxMethods(ctx);
    try {
      const method = methods.get(INBOX_LIST_METHOD_ID);
      expect(method).toBeDefined();
      const d = method!.descriptor;
      expect(d.id).toBe(INBOX_LIST_METHOD_ID);
      expect(d.category).toBe('channels');
      // foundation maps access 'operator' -> 'admin' and source 'daemon' -> 'builtin'
      expect(d.access).toBe('admin');
      expect(d.source).toBe('builtin');
      expect(d.scopes).toEqual(INBOX_LIST_SCOPES);
      // effect/confirm are stripped before reaching the catalog
      expect(d.effect).toBeUndefined();
      expect(d.confirm).toBeUndefined();
      expect(d.outputSchema).toBeDefined();
    } finally {
      unregister();
    }
  });

  test('handler returns the wire shape and reports every provider state (no omissions)', async () => {
    const { catalog, methods } = makeFakeCatalog();
    const ctx = makeContext(catalog, dir);
    const unregister = registerInboxMethods(ctx);
    try {
      const handler = methods.get(INBOX_LIST_METHOD_ID)!.handler;
      const result = (await handler({
        body: { limit: 10 },
        context: { principalId: 'op-1', metadata: {} },
      })) as InboxListOutput;
      expect(Array.isArray(result.items)).toBe(true);
      expect(typeof result.nextSince).toBe('number');
      // all three built-in providers reported, all unavailable (null creds)
      const ids = result.providers.map((p) => p.id).sort();
      expect(ids).toEqual(['discord', 'email', 'slack']);
      for (const p of result.providers) {
        expect(p.state).toBe('unavailable');
        expect(typeof p.error).toBe('string');
      }
    } finally {
      unregister();
    }
  });

  test('handler reads persisted items, advances nextSince monotonically, honors filters', async () => {
    // Pre-seed the cursor store the surface will open.
    const seed = new InboxCursorStore(dir);
    await seed.init();
    seed.upsertItems([
      { id: 'slack:a', provider: 'slack', kind: 'dm', fromDigest: 'd', subjectPreview: 's', bodyPreview: 'b', receivedAt: 1000, unread: true },
      { id: 'discord:b', provider: 'discord', kind: 'dm', fromDigest: 'd', subjectPreview: 's', bodyPreview: 'b', receivedAt: 2000, unread: true },
    ]);
    await seed.flush();
    await seed.close();

    const { catalog, methods } = makeFakeCatalog();
    const ctx = makeContext(catalog, dir);
    // skipInitialPoll so the (uncredentialled) adapters don't overwrite anything
    const unregister = registerInboxMethods(ctx, { skipInitialPoll: true });
    try {
      const handler = methods.get(INBOX_LIST_METHOD_ID)!.handler;
      const all = (await handler({ body: { limit: 50 }, context: { principalId: 'op', metadata: {} } })) as InboxListOutput;
      expect(all.items.map((i) => i.id)).toEqual(['discord:b', 'slack:a']);
      expect(all.nextSince).toBe(2000);

      // provider filter
      const slackOnly = (await handler({ body: { providers: ['slack'], limit: 50 }, context: { principalId: 'op', metadata: {} } })) as InboxListOutput;
      expect(slackOnly.items.map((i) => i.id)).toEqual(['slack:a']);
      expect(slackOnly.nextSince).toBe(1000);

      // since filter advances monotonically and never drops below requested since
      const sinceHigh = (await handler({ body: { since: 5000, limit: 50 }, context: { principalId: 'op', metadata: {} } })) as InboxListOutput;
      expect(sinceHigh.items).toHaveLength(0);
      expect(sinceHigh.nextSince).toBe(5000);
    } finally {
      unregister();
    }
  });

  test('unregister removes the method', async () => {
    const { catalog, methods } = makeFakeCatalog();
    const ctx = makeContext(catalog, dir);
    const unregister = registerInboxMethods(ctx, { skipInitialPoll: true });
    expect(methods.has(INBOX_LIST_METHOD_ID)).toBe(true);
    unregister();
    expect(methods.has(INBOX_LIST_METHOD_ID)).toBe(false);
  });
});
