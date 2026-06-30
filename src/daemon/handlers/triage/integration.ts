// ---------------------------------------------------------------------------
// Daemon-internal triage INTEGRATION (the single entry the runtime calls).
//
// `registerTriagedInbox(ctx, registerInbox, options)` closes the contract loop:
//
//   1. It DECORATES the inbox surface's `channels.inbox.list` handler. The
//      inbox surface (a separate handler module) attaches its handler to the
//      SDK-auto-registered descriptor via `ctx.catalog.register(descriptor,
//      handler, { replace: true })`. We pass the inbox `registerInbox` a
//      catalog PROXY whose `register` intercepts exactly the
//      `channels.inbox.list` id and wraps the handler so every returned item is
//      overlaid with the persisted triageScore/triageTags via
//      enrichItemsWithTriage(). Every other registration passes straight
//      through to the real catalog. The inbox descriptor/schema/id is never
//      re-authored — only its handler is wrapped.
//   2. It exposes the triage pipeline + tagger (`runInboxTriage`, `tagger`) for
//      the daemon-internal poller, which scores items and persists them to the
//      co-located inbox-triage.sqlite store the decorator reads from.
//   3. inbox.triage.* are intentionally NOT registered on the catalog (they are
//      a daemon-internal pipeline, not published methods) — so this module
//      makes ZERO catalog.register call for any triage id.
//
// Reads in the decorator are best-effort and degrade to the raw item when no
// triage row exists yet, so the read-only inbox feed never breaks.
// ---------------------------------------------------------------------------

import type { HandlerContext } from '../context.ts';
import type {
  GatewayMethodCatalog,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
} from '../contracts.ts';
import type { Unregister } from '../register.ts';
import { HandlerSqliteStore } from '../sqlite-store.ts';
import {
  createTriageStore,
  enrichItemsWithTriage,
  runInboxTriage,
  type RunInboxTriageOptions,
  type RunInboxTriageResult,
} from './pipeline.ts';
import type { InboundChannelItem } from './types.ts';
import {
  createTriageTagger,
  type ApplyTagsRequest,
  type ApplyTagsResult,
  type TriageTagger,
  type TriageTaggerOptions,
} from './tagger/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/**
 * Canonical id of the inbox list method whose handler we decorate. This is the
 * SDK's published id — referenced as a plain string for matching during
 * registration; no descriptor or schema is authored here.
 */
export const INBOX_LIST_METHOD_ID = 'channels.inbox.list';

/** Minimal shape of the inbox.list result the decorator overlays triage onto. */
interface InboxListResult {
  items?: unknown;
  [key: string]: unknown;
}

export interface RegisterTriagedInboxOptions {
  pipeline?: RunInboxTriageOptions;
  tagger?: TriageTaggerOptions;
}

/**
 * The inbox surface provider. The runtime supplies the inbox module's register
 * function; we hand it a decorating catalog proxy so its `channels.inbox.list`
 * handler is wrapped with triage enrichment.
 */
export type RegisterInbox = (ctx: HandlerContext) => Unregister;

/** Handle returned to the runtime: teardown + the poller-facing pipeline/tagger. */
export interface TriagedInboxRegistration {
  readonly unregister: Unregister;
  /** Score (+persist) a batch of polled items. Used by the inbox poller. */
  runInboxTriage(
    items: readonly InboundChannelItem[],
    options?: RunInboxTriageOptions,
  ): Promise<RunInboxTriageResult>;
  /** Provider-side tagger (IMAP flag / Slack or Discord reaction/tag). */
  readonly tagger: TriageTagger;
}

type StoredHandler = GatewayMethodHandler;

interface EnrichmentProxy {
  readonly ctx: HandlerContext;
  /** Close the shared triage store handle (if one was ever opened). */
  dispose(): void;
}

/**
 * Build a HandlerContext whose catalog decorates `channels.inbox.list`
 * registration. The triage store is opened lazily ONCE on the first list
 * invocation and reused for every subsequent call (hot read path); the caller
 * disposes the handle on teardown.
 */
function withInboxEnrichment(ctx: HandlerContext): EnrichmentProxy {
  const original = ctx.catalog;

  let store: HandlerSqliteStore | null = null;
  let initPromise: Promise<HandlerSqliteStore> | null = null;
  const getStore = async (): Promise<HandlerSqliteStore> => {
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
          initPromise = null; // allow a later call to retry opening the store
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

  const decoratedRegister: GatewayMethodCatalog['register'] = (
    descriptor: GatewayMethodDescriptor,
    handler?: StoredHandler,
    options?: { replace?: boolean },
  ): Unregister => {
    if (descriptor.id !== INBOX_LIST_METHOD_ID || !handler) {
      return original.register(descriptor, handler, options);
    }
    const innerHandler = handler;
    const wrapped: StoredHandler = async (invocation) => {
      const result = (await innerHandler(invocation)) as InboxListResult;
      if (!result || !Array.isArray(result.items) || result.items.length === 0) {
        return result;
      }
      const items = result.items as Array<{ id: string }>;
      try {
        const handle = await getStore();
        return { ...result, items: enrichItemsWithTriage(handle, items) };
      } catch (error) {
        // Triage is best-effort: a missing/locked store must never break the
        // read-only inbox feed. Log and return the un-enriched result.
        ctx.logger.warn('triage: inbox enrichment skipped', {
          message: summarizeError(error),
        });
        return result;
      }
    };
    return original.register(descriptor, wrapped, options);
  };

  // Clone the context with only `catalog.register` swapped. Every other catalog
  // method (invoke/list/get/...) keeps pointing at the original instance.
  const proxiedCatalog = new Proxy(original, {
    get(target, prop, receiver) {
      if (prop === 'register') return decoratedRegister;
      return Reflect.get(target, prop, receiver);
    },
  }) as GatewayMethodCatalog;

  return { ctx: { ...ctx, catalog: proxiedCatalog }, dispose };
}

/**
 * Compose the triage pipeline with the inbox surface so channels.inbox.list
 * returns pre-scored items. Returns the teardown plus the poller-facing
 * pipeline/tagger handle. The inbox surface's registration is wrapped; inbox
 * teardown runs first, then the shared store handle is disposed.
 */
export function registerTriagedInbox(
  ctx: HandlerContext,
  registerInbox: RegisterInbox,
  options: RegisterTriagedInboxOptions = {},
): TriagedInboxRegistration {
  const tagger = createTriageTagger(ctx, options.tagger);
  const enriched = withInboxEnrichment(ctx);

  let unregisterInbox: Unregister;
  try {
    unregisterInbox = registerInbox(enriched.ctx);
  } catch (error) {
    enriched.dispose();
    throw error;
  }

  const unregister: Unregister = () => {
    try {
      unregisterInbox();
    } finally {
      enriched.dispose();
    }
  };

  return {
    unregister,
    runInboxTriage: (items, runOptions) =>
      runInboxTriage(items, ctx, { ...options.pipeline, ...runOptions }),
    tagger,
  };
}

export type { ApplyTagsRequest, ApplyTagsResult };
