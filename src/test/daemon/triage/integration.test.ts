import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  INBOX_LIST_METHOD_ID,
  registerTriagedInbox,
} from '../../../daemon/handlers/triage/integration.ts';
import type {
  GatewayMethodCatalog,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
} from '../../../daemon/handlers/contracts.ts';
import type { HandlerContext } from '../../../daemon/handlers/context.ts';
import { fakeContext, item, makeTempDir, removeTempDir } from './helpers.ts';

/**
 * Minimal stand-in for the SDK GatewayMethodCatalog that records the handler
 * registered against a given descriptor id and lets the test invoke it. The
 * real catalog's register(descriptor, handler, {replace}) contract is mirrored.
 */
function stubCatalog() {
  const handlers = new Map<string, GatewayMethodHandler>();
  let registerCalls = 0;
  const catalog = {
    register(
      descriptor: GatewayMethodDescriptor,
      handler?: GatewayMethodHandler,
    ): () => void {
      registerCalls += 1;
      if (handler) handlers.set(descriptor.id, handler);
      return () => handlers.delete(descriptor.id);
    },
  } as unknown as GatewayMethodCatalog;
  return {
    catalog,
    handlers,
    registerCalls: () => registerCalls,
  };
}

const INBOX_DESCRIPTOR = { id: INBOX_LIST_METHOD_ID } as GatewayMethodDescriptor;
const OTHER_DESCRIPTOR = { id: 'channels.routing.list' } as GatewayMethodDescriptor;

describe('registerTriagedInbox', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('gv-triage-integration-');
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('decorates channels.inbox.list so returned items carry persisted triage metadata', async () => {
    const stub = stubCatalog();
    const ctx: HandlerContext = fakeContext({ workingDirectory: dir, catalog: stub.catalog });

    // The inbox surface registers a raw list handler that returns two items.
    const rawHandler: GatewayMethodHandler = async () => ({
      items: [{ id: 'i1' }, { id: 'i2' }],
      total: 2,
      truncated: false,
    });
    const registerInbox = (inboxCtx: HandlerContext) =>
      inboxCtx.catalog.register(INBOX_DESCRIPTOR, rawHandler);

    const reg = registerTriagedInbox(ctx, registerInbox, { tagger: { autoTagEnabled: false } });

    // Persist triage for one of the two items via the poller-facing pipeline.
    await reg.runInboxTriage([
      item({ id: 'i1', surface: 'email', subject: 'free lottery winner prize', snippet: 'claim now!!!' }),
    ]);

    const decorated = stub.handlers.get(INBOX_LIST_METHOD_ID)!;
    const result = (await decorated({ body: {}, query: {}, context: { authToken: 't' } } as never)) as {
      items: Array<{ id: string; triageLabel?: string }>;
      total: number;
    };
    const i1 = result.items.find((r) => r.id === 'i1')!;
    const i2 = result.items.find((r) => r.id === 'i2')!;
    expect(i1.triageLabel).toBeDefined();
    expect(i2.triageLabel).toBeUndefined();
    expect(result.total).toBe(2);

    reg.unregister();
    expect(stub.handlers.has(INBOX_LIST_METHOD_ID)).toBe(false);
  });

  it('passes non-inbox registrations straight through to the real catalog', async () => {
    const stub = stubCatalog();
    const ctx = fakeContext({ workingDirectory: dir, catalog: stub.catalog });
    const otherHandler: GatewayMethodHandler = async () => ({ ok: true });
    const registerInbox = (inboxCtx: HandlerContext) =>
      inboxCtx.catalog.register(OTHER_DESCRIPTOR, otherHandler);

    registerTriagedInbox(ctx, registerInbox, { tagger: { autoTagEnabled: false } });
    // The undecorated handler is stored verbatim (identity preserved).
    expect(stub.handlers.get('channels.routing.list')).toBe(otherHandler);
  });

  it('registers NO catalog method for any inbox.triage.* id', async () => {
    const stub = stubCatalog();
    const ctx = fakeContext({ workingDirectory: dir, catalog: stub.catalog });
    const registerInbox = (inboxCtx: HandlerContext) =>
      inboxCtx.catalog.register(INBOX_DESCRIPTOR, async () => ({ items: [], total: 0, truncated: false }));

    registerTriagedInbox(ctx, registerInbox);
    const ids = [...stub.handlers.keys()];
    expect(ids.some((id) => id.startsWith('inbox.triage'))).toBe(false);
    // Only the single inbox.list registration happened.
    expect(stub.registerCalls()).toBe(1);
  });

  it('degrades to the raw result when the list handler returns no items', async () => {
    const stub = stubCatalog();
    const ctx = fakeContext({ workingDirectory: dir, catalog: stub.catalog });
    const registerInbox = (inboxCtx: HandlerContext) =>
      inboxCtx.catalog.register(INBOX_DESCRIPTOR, async () => ({ items: [], total: 0, truncated: false }));
    registerTriagedInbox(ctx, registerInbox);
    const decorated = stub.handlers.get(INBOX_LIST_METHOD_ID)!;
    const result = (await decorated({ body: {}, query: {}, context: { authToken: 't' } } as never)) as {
      items: unknown[];
    };
    expect(result.items).toEqual([]);
  });
});
