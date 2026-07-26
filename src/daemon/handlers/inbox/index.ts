// ---------------------------------------------------------------------------
// Inbox surface: attaches the HOST handler to the SDK-registered
// `channels.inbox.list` gateway descriptor.
//
// The SDK already declares the method id, input schema, output schema, scopes
// (read:channels) and HTTP binding (GET /api/channels/inbox). This module does
// NOT re-declare any of that — it looks the descriptor up via the catalog and
// attaches an implementation with `registerCatalogHandler` ({ replace: true }).
//
// register(ctx, routing) =>
//   1. registers built-in provider adapter factories (slack/discord/email)
//   2. constructs adapters with the daemon credential store + a route resolver
//      bridged from the routing surface (best-effort, never throws)
//   3. opens the inbox cursor store and seeds an initial poll
//   4. starts the per-provider polling loops
//   5. attaches the read-only `channels.inbox.list` handler (no confirm)
//   6. returns an Unregister that detaches the handler, stops the poller, and
//      closes the store.
//
// The handler reads the persisted feed (filtered by provider/limit/since) and
// maps the daemon-internal item shape onto the SDK CHANNEL_INBOX_ITEM_SCHEMA
// wire shape. The redacted `fromDigest` is the only sender value emitted (as
// `from`); raw sender ids and unredacted bodies never leave the daemon. The
// monotonic cursor advances to max(receivedAt) in the returned window.
// ---------------------------------------------------------------------------

import type { HandlerContext } from '../context.ts';
import type { Unregister } from '../register.ts';
import { registerCatalogHandler } from '../register.ts';
import type { RoutingRegistration } from '../index.ts';
import {
  buildAdapters,
  registerAdapterFactory,
  type AdapterContext,
  type InboundChannelItem,
  type RouteResolver,
} from './provider-adapter.ts';
import { InboxCursorStore } from './cursor-store.ts';
import { InboundPoller } from './poller.ts';
import { createSlackAdapter, SLACK_PROVIDER_ID } from './providers/slack.ts';
import { createDiscordAdapter, DISCORD_PROVIDER_ID } from './providers/discord.ts';
import { createEmailAdapter, EMAIL_PROVIDER_ID } from './providers/email.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export const INBOX_LIST_METHOD_ID = 'channels.inbox.list';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** SDK `channels.inbox.list` input (single optional provider per the schema). */
export interface InboxListInput {
  provider?: string;
  limit?: number;
  since?: number;
}

/** One item in the SDK CHANNEL_INBOX_ITEM_SCHEMA wire shape. */
export interface ChannelInboxItem {
  id: string;
  provider: string;
  kind: string;
  /** Redacted sender token (sha256First, 16 hex). Never the raw id. */
  from: string;
  subject?: string;
  bodyPreview: string;
  receivedAt: number;
  unread: boolean;
  routeId?: string;
}

/** SDK `channels.inbox.list` output (objectSchema: items/total/truncated/cursor?). */
export interface InboxListOutput {
  items: ChannelInboxItem[];
  total: number;
  truncated: boolean;
  cursor?: string;
}

/** Start/stop control over the poll loops, handed to a leadership gate. */
export interface InboxPollingControl {
  /** Seed one poll and arm the loops. Resolves once polling has begun. */
  start(): Promise<void>;
  /** Disarm the loops. Resolves once no further poll can run. */
  stop(): Promise<void>;
}

export interface RegisterInboxOptions {
  /** Override the cursor-store filename (tests). */
  storeFileName?: string;
  /** Skip the initial seed poll (tests that drive polling manually). */
  skipInitialPoll?: boolean;
  /** Register the built-in slack/discord/email adapters (default true). */
  registerBuiltins?: boolean;
  /**
   * Hand polling to a leadership gate instead of starting it here.
   *
   * When supplied, register() prepares the store and the handler but does NOT
   * poll: the callback receives start/stop control and something else decides
   * when this node is the one that should be fetching. When absent the loops
   * start immediately, which is the behaviour every existing caller and test
   * relies on.
   *
   * The READ path is never gated. `channels.inbox.list` serves the persisted
   * feed on every node — a node that is not fetching still answers questions
   * about what has already arrived.
   */
  gatePolling?: (control: InboxPollingControl) => void;
}

function registerBuiltinAdapters(): void {
  registerAdapterFactory(SLACK_PROVIDER_ID, (ctx) => createSlackAdapter(ctx));
  registerAdapterFactory(DISCORD_PROVIDER_ID, (ctx) => createDiscordAdapter(ctx));
  registerAdapterFactory(EMAIL_PROVIDER_ID, (ctx) => createEmailAdapter(ctx));
}

function normalizeInput(body: unknown): { providers?: string[]; limit: number; since?: number } {
  const input = (body ?? {}) as InboxListInput;
  const provider = typeof input.provider === 'string' && input.provider.length > 0
    ? input.provider
    : undefined;
  let limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? Math.floor(input.limit)
    : DEFAULT_LIMIT;
  limit = Math.min(Math.max(1, limit), MAX_LIMIT);
  const since = typeof input.since === 'number' && Number.isFinite(input.since) && input.since >= 0
    ? Math.floor(input.since)
    : undefined;
  return {
    ...(provider ? { providers: [provider] } : {}),
    limit,
    ...(since !== undefined ? { since } : {}),
  };
}

/** Map a daemon-internal item onto the SDK CHANNEL_INBOX_ITEM_SCHEMA wire shape. */
function toWireItem(item: InboundChannelItem): ChannelInboxItem {
  const wire: ChannelInboxItem = {
    id: item.id,
    provider: item.provider,
    kind: item.kind,
    from: item.fromDigest,
    bodyPreview: item.bodyPreview,
    receivedAt: item.receivedAt,
    unread: item.unread,
  };
  if (item.subjectPreview.length > 0) wire.subject = item.subjectPreview;
  if (item.routeId != null) wire.routeId = item.routeId;
  return wire;
}

/**
 * Bridge the routing surface's profile resolver into the adapter `RouteResolver`
 * seam. Resolution is by provider surface (best-effort wildcard); a resolved
 * profile id is surfaced as the item's routeId binding. Never throws.
 */
function routeResolverFromRouting(routing: RoutingRegistration): RouteResolver {
  return ({ provider }) => {
    try {
      return routing.resolveProfileId(provider) ?? undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * Register the inbox surface. Attaches the `channels.inbox.list` handler to the
 * SDK catalog and returns an Unregister that detaches it, stops the poller, and
 * closes the store.
 */
export function registerInboxMethods(
  ctx: HandlerContext,
  routing?: RoutingRegistration,
  options: RegisterInboxOptions = {},
): Unregister {
  if (options.registerBuiltins !== false) {
    registerBuiltinAdapters();
  }

  const adapterContext: AdapterContext = {
    credentials: ctx.credentials,
    logger: ctx.logger,
    ...(routing ? { resolveRouteId: routeResolverFromRouting(routing) } : {}),
  };
  const adapters = buildAdapters(adapterContext);
  // Retention runs inside the store (age TTL + count cap, at init and then on a
  // timer). Both hooks carry COUNTS ONLY — no sender ids, subjects or bodies.
  const store = new InboxCursorStore(ctx.workingDirectory, options.storeFileName, {
    onSweep: (summary) => {
      ctx.logger.info('inbox retention sweep reclaimed items', {
        expired: summary.expired,
        capped: summary.capped,
        remaining: summary.remaining,
      });
    },
    onSweepError: (message) => {
      ctx.logger.warn('inbox retention sweep failed', { error: message });
    },
  });
  const poller = new InboundPoller({ adapters, store, logger: ctx.logger });

  const gated = options.gatePolling !== undefined;

  // Async bootstrap: init store, and (ungated) seed one poll and start loops.
  // Failures are logged but never thrown out of register() — the handler still
  // serves the (possibly empty) persisted feed.
  const ready: Promise<void> = (async () => {
    await store.init();
    if (gated) return;
    if (!options.skipInitialPoll) {
      await poller.pollOnce();
    }
    poller.start();
  })().catch((error: unknown) => {
    ctx.logger.error('inbox surface bootstrap failed', {
      error: summarizeError(error),
    });
  });

  if (options.gatePolling) {
    options.gatePolling({
      start: async () => {
        // The store must be ready before the first fetch, or the seed poll
        // would write cursors into an uninitialised store.
        await ready;
        if (!options.skipInitialPoll) {
          await poller.pollOnce();
        }
        poller.start();
      },
      // Synchronous underneath: stop() clears the interval timers, so once it
      // returns no further poll can be scheduled. Declared async because the
      // gate contract promises "resolves when consumption has ceased", and a
      // future adapter with an in-flight request would need to await it.
      stop: async () => {
        poller.stop();
      },
    });
  }

  const unregisterMethod = registerCatalogHandler<InboxListInput, InboxListOutput>(
    ctx.catalog,
    INBOX_LIST_METHOD_ID,
    async (invocation) => {
      await ready;
      const { providers, limit, since } = normalizeInput(invocation.body);
      const internalItems = store.listItems({
        ...(providers ? { providers } : {}),
        ...(since !== undefined ? { since } : {}),
        limit,
      });
      const items = internalItems.map(toWireItem);
      const total = store.countItems(providers);
      const truncated = internalItems.length >= limit && total > internalItems.length;
      const maxReceived = store.maxReceivedAt(providers);
      const nextSince = Math.max(since ?? 0, maxReceived);
      const output: InboxListOutput = { items, total, truncated };
      if (nextSince > 0) output.cursor = String(nextSince);
      return output;
    },
  );

  return () => {
    try {
      unregisterMethod();
    } finally {
      poller.stop();
      void store.close();
    }
  };
}
