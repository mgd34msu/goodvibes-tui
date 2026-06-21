// ---------------------------------------------------------------------------
// Daemon-internal triage INTEGRATION (composition root).
//
// `registerTriagedInbox(ctx)` is the single call the daemon integration layer
// (services.ts) makes to obtain the contract behaviour end-to-end:
//
//   1. registers the internal triage surface (inbox.triage.list / .tag) so the
//      poller can score + tag items;
//   2. registers the inbox surface (channels.inbox.list) THROUGH a catalog
//      proxy that decorates its list handler so every returned item is overlaid
//      with the persisted triageScore/triageTags via enrichItemsWithTriage();
//   3. returns one Unregister that tears both surfaces down (inbox first, then
//      triage) in reverse order.
//
// This closes the loop the contract specifies: "the agent gets pre-scored items
// via channels.inbox.list metadata" — without editing the inbox surface itself
// (the list handler is decorated, not modified). The triage scoring store is
// the co-located inbox-triage.sqlite written by runInboxTriage(); reads here are
// best-effort and degrade to the raw item when no triage row exists yet.
// ---------------------------------------------------------------------------

import type {
  OperatorContext,
  OperatorSqliteStore,
  Unregister,
} from '../operator/index.ts';
import {
  registerInboxMethods,
  INBOX_LIST_METHOD_ID,
  type RegisterInboxOptions,
  type InboxListOutput,
} from '../channels/inbox/index.ts';
import {
  createTriageRegister,
  type RegisterTriageOptions,
} from './register.ts';
import {
  createTriageStore,
  enrichItemsWithTriage,
} from './pipeline.ts';

export interface RegisterTriagedInboxOptions {
  triage?: RegisterTriageOptions;
  inbox?: RegisterInboxOptions;
}

// The narrow slice of the SDK catalog this module proxies. Matches
// GatewayMethodCatalog.register(descriptor, handler) => Unregister.
type CatalogLike = OperatorContext['catalog'];
type CatalogRegister = CatalogLike['register'];
// The handler the catalog stores: invoked with an opaque invocation, returns a
// promise of the method result. We model it concretely (rather than via the
// SDK's possibly-optional Parameters type) so the wrapped handler is callable.
type StoredHandler = (invocation: unknown) => Promise<unknown>;

interface EnrichedContext {
  ctx: OperatorContext;
  /** Close the shared triage store handle (if one was ever opened). */
  dispose: () => void;
}

/**
 * Wrap a catalog so that registration of `channels.inbox.list` decorates the
 * handler: the original handler runs, then each returned item is enriched with
 * persisted triage metadata. All other registrations pass straight through.
 *
 * The triage store is opened lazily ONCE on the first list invocation and the
 * handle is reused for every subsequent call (this is a hot read path). The
 * caller disposes the handle on teardown via the returned `dispose`.
 */
function withInboxEnrichment(ctx: OperatorContext): EnrichedContext {
  const original = ctx.catalog;

  // Shared, lazily-opened store handle reused across list invocations.
  let store: OperatorSqliteStore | null = null;
  let initPromise: Promise<OperatorSqliteStore> | null = null;
  const getStore = async (): Promise<OperatorSqliteStore> => {
    if (store) return store;
    if (!initPromise) {
      const pending = createTriageStore(ctx.workingDirectory);
      initPromise = pending
        .init()
        .then(() => {
          store = pending;
          return pending;
        })
        .catch((error) => {
          // Reset so a later call can retry opening the store.
          initPromise = null;
          throw error;
        });
    }
    return initPromise;
  };
  const dispose = (): void => {
    if (store) {
      store.close();
      store = null;
    }
    initPromise = null;
  };

  const decoratedRegister: CatalogRegister = ((descriptor: unknown, handler: unknown) => {
    const id = (descriptor as { id?: unknown }).id;
    const innerHandler = handler as StoredHandler;
    if (id !== INBOX_LIST_METHOD_ID) {
      return original.register(
        descriptor as Parameters<CatalogRegister>[0],
        handler as Parameters<CatalogRegister>[1],
      );
    }
    const wrapped: StoredHandler = async (invocation) => {
      const result = (await innerHandler(invocation)) as InboxListOutput;
      if (!result || !Array.isArray(result.items) || result.items.length === 0) {
        return result;
      }
      try {
        const handle = await getStore();
        return { ...result, items: enrichItemsWithTriage(handle, result.items) };
      } catch (error) {
        // Triage is best-effort: a missing/locked store must never break the
        // read-only inbox feed. Log and return the un-enriched result.
        ctx.logger.warn('triage: inbox enrichment skipped', {
          message: error instanceof Error ? error.message : String(error),
        });
        return result;
      }
    };
    return original.register(
      descriptor as Parameters<CatalogRegister>[0],
      wrapped as Parameters<CatalogRegister>[1],
    );
  }) as CatalogRegister;

  // Structurally clone the context with only `catalog` swapped. The proxy keeps
  // every other catalog method (invoke/list/get/...) pointing at the original.
  const proxiedCatalog = new Proxy(original, {
    get(target, prop, receiver) {
      if (prop === 'register') return decoratedRegister;
      return Reflect.get(target, prop, receiver);
    },
  });

  return { ctx: { ...ctx, catalog: proxiedCatalog as CatalogLike }, dispose };
}

/**
 * Compose the triage surface with the inbox surface so channels.inbox.list
 * returns pre-scored items. Returns a single Unregister tearing down both.
 */
export function registerTriagedInbox(
  ctx: OperatorContext,
  options: RegisterTriagedInboxOptions = {},
): Unregister {
  const unregisterTriage = createTriageRegister(options.triage)(ctx);
  const enriched = withInboxEnrichment(ctx);
  let unregisterInbox: Unregister | null = null;
  try {
    unregisterInbox = registerInboxMethods(enriched.ctx, options.inbox ?? {});
  } catch (error) {
    // If inbox registration fails, do not leak the triage surface or the store.
    enriched.dispose();
    unregisterTriage();
    throw error;
  }

  return () => {
    try {
      unregisterInbox?.();
    } finally {
      try {
        // Close the shared triage store handle opened by the enrichment proxy.
        enriched.dispose();
      } finally {
        unregisterTriage();
      }
    }
  };
}
