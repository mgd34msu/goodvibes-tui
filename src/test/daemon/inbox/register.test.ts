/**
 * Integration tests for the inbox surface registration. Verifies that the host
 * handler attaches to the SDK-registered `channels.inbox.list` descriptor (it is
 * never re-declared), maps the daemon-internal item shape onto the SDK
 * CHANNEL_INBOX_ITEM_SCHEMA wire shape, emits the redacted sender as `from`,
 * advances a monotonic cursor, and reports total/truncated.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { HandlerContext } from '../../../daemon/handlers/context.ts';
import type { DaemonCredentialStore } from '../../../daemon/handlers/credentials.ts';
import type { RoutingRegistration } from '../../../daemon/handlers/index.ts';
import {
  INBOX_LIST_METHOD_ID,
  registerInboxMethods,
  type InboxListOutput,
} from '../../../daemon/handlers/inbox/index.ts';
import {
  clearAdapterRegistry,
  registerAdapterFactory,
  type InboundChannelItem,
  type InboundProviderAdapter,
  type ProviderPollResult,
} from '../../../daemon/handlers/inbox/provider-adapter.ts';

const logger = { info() {}, warn() {}, error() {} };

function fakeCredentials(): DaemonCredentialStore {
  return {
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
  };
}

function mkItem(over: Partial<InboundChannelItem> & { id: string }): InboundChannelItem {
  return {
    provider: 'fake',
    kind: 'dm',
    fromDigest: 'cafebabedeadbeef',
    subjectPreview: 'Direct message',
    bodyPreview: 'hello world',
    receivedAt: 1_000,
    unread: true,
    ...over,
  };
}

/**
 * Register a fake provider that returns the supplied items on its first poll.
 * It honors the injected route resolver exactly as the real adapters do, so the
 * routing bridge can be exercised end to end.
 */
function installFakeProvider(items: InboundChannelItem[]): void {
  clearAdapterRegistry();
  registerAdapterFactory('fake', (adapterCtx) => {
    const adapter: InboundProviderAdapter = {
      id: 'fake',
      pollIntervalMs: 30_000,
      async poll(): Promise<ProviderPollResult> {
        const resolved: InboundChannelItem[] = [];
        for (const item of items) {
          const next = { ...item };
          if (adapterCtx.resolveRouteId) {
            const routeId = await adapterCtx.resolveRouteId({
              provider: item.provider,
              fromDigest: item.fromDigest,
              kind: item.kind,
            });
            if (routeId) next.routeId = routeId;
          }
          resolved.push(next);
        }
        return { state: 'ready', items: resolved };
      },
    };
    return adapter;
  });
}

let dir: string;
let catalog: GatewayMethodCatalog;
let ctx: HandlerContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inbox-register-'));
  catalog = new GatewayMethodCatalog();
  ctx = {
    catalog,
    credentials: fakeCredentials(),
    // get/getCategory are cast through unknown straight to ConfigManager's own
    // method types (rather than reconstructed as independent generic
    // signatures): the SDK's ConfigValue mapped type is a very large
    // discriminated union, and asking the compiler to structurally verify a
    // freshly-written generic signature against it here hits TS's "excessive
    // stack depth" recursion limit (TS2321) — a compiler limitation, not a
    // real type mismatch.
    configManager: {
      get: ((_key: string) => undefined) as unknown as HandlerContext['configManager']['get'],
      getCategory: ((_category: string) => ({})) as unknown as HandlerContext['configManager']['getCategory'],
    },
    workingDirectory: dir,
    homeDirectory: dir,
    logger,
  };
});

afterEach(async () => {
  clearAdapterRegistry();
  await rm(dir, { recursive: true, force: true });
});

async function invoke(body: Record<string, unknown>): Promise<InboxListOutput> {
  return (await catalog.invoke(INBOX_LIST_METHOD_ID, {
    body,
    query: {},
    context: { authToken: 'fake-auth', scopes: ['read:channels'] },
  })) as InboxListOutput;
}

describe('registerInboxMethods', () => {
  test('attaches a handler to the SDK descriptor without re-declaring it', () => {
    // The SDK auto-registered the descriptor with handler=undefined.
    const before = catalog.get(INBOX_LIST_METHOD_ID);
    expect(before).toBeDefined();
    expect(catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(false);

    installFakeProvider([]);
    const unregister = registerInboxMethods(ctx, undefined, {
      registerBuiltins: false,
      skipInitialPoll: true,
    });
    try {
      expect(catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(true);
      // Canonical descriptor metadata is preserved (id/scopes from the SDK).
      const after = catalog.get(INBOX_LIST_METHOD_ID);
      expect(after!.id).toBe(INBOX_LIST_METHOD_ID);
      expect(after!.scopes).toEqual(before!.scopes);
    } finally {
      unregister();
    }
    // Teardown detaches the handler again.
    expect(catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(false);
  });

  test('maps internal items to the SDK wire shape and emits redacted sender', async () => {
    installFakeProvider([
      mkItem({ id: 'fake:1', fromDigest: 'aaaa1111bbbb2222', receivedAt: 1_000 }),
      mkItem({ id: 'fake:2', fromDigest: 'cccc3333dddd4444', receivedAt: 2_000 }),
    ]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke({});
      expect(out.items).toHaveLength(2);
      const newest = out.items[0]!;
      expect(newest.id).toBe('fake:2');
      // `from` carries the redacted digest, never a raw sender id.
      expect(newest.from).toBe('cccc3333dddd4444');
      expect(newest.subject).toBe('Direct message');
      expect(newest.bodyPreview).toBe('hello world');
      expect(newest.unread).toBe(true);
      // Required SDK fields present.
      for (const required of ['id', 'provider', 'kind', 'from', 'bodyPreview', 'receivedAt', 'unread'] as const) {
        expect(newest[required]).toBeDefined();
      }
      expect(out.total).toBe(2);
      expect(out.truncated).toBe(false);
      // Cursor is the stringified monotonic max(receivedAt).
      expect(out.cursor).toBe('2000');
    } finally {
      unregister();
    }
  });

  test('honors limit and reports truncated when more items exist', async () => {
    installFakeProvider([
      mkItem({ id: 'fake:1', receivedAt: 1 }),
      mkItem({ id: 'fake:2', receivedAt: 2 }),
      mkItem({ id: 'fake:3', receivedAt: 3 }),
    ]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke({ limit: 2 });
      expect(out.items).toHaveLength(2);
      expect(out.total).toBe(3);
      expect(out.truncated).toBe(true);
    } finally {
      unregister();
    }
  });

  test('filters by the single `provider` input field', async () => {
    installFakeProvider([
      mkItem({ id: 'fake:1', provider: 'fake', receivedAt: 10 }),
    ]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const matched = await invoke({ provider: 'fake' });
      expect(matched.items).toHaveLength(1);
      const other = await invoke({ provider: 'nope' });
      expect(other.items).toHaveLength(0);
      expect(other.total).toBe(0);
    } finally {
      unregister();
    }
  });

  test('routing bridge surfaces a resolved profile as the item routeId', async () => {
    installFakeProvider([mkItem({ id: 'fake:1', receivedAt: 5 })]);
    const routing: RoutingRegistration = {
      unregister() {},
      resolveProfileId: (surfaceKind) => (surfaceKind === 'fake' ? 'profile-x' : null),
    };
    const unregister = registerInboxMethods(ctx, routing, { registerBuiltins: false });
    try {
      const out = await invoke({});
      expect(out.items[0]!.routeId).toBe('profile-x');
    } finally {
      unregister();
    }
  });
});
