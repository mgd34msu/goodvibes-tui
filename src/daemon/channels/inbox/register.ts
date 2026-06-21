// ---------------------------------------------------------------------------
// Surface register: `channels.inbox.list`.
//
// register(ctx) =>
//   1. registers built-in provider adapter factories (slack/discord/email)
//   2. constructs adapters with a daemon credential store
//   3. opens the inbox cursor store and seeds an initial poll
//   4. starts the per-provider polling loops
//   5. publishes the read-only `channels.inbox.list` operator method
//   6. returns an Unregister that stops the poller, closes the store, and
//      removes the method.
//
// `channels.inbox.list` is READ-ONLY (no confirm). It reads the persisted feed
// (filtered by providers/limit/since) and reports per-provider state from the
// live poller status. nextSince advances monotonically (max receivedAt in the
// returned window, never below the requested `since`).
// ---------------------------------------------------------------------------

import {
  createDaemonCredentialStore,
  declareOperatorMethod,
} from '../../operator/index.ts';
import type {
  OperatorContext,
  OperatorInvocation,
  SurfaceRegister,
  Unregister,
} from '../../operator/index.ts';
import {
  buildAdapters,
  registerAdapterFactory,
  type AdapterContext,
  type InboundChannelItem,
  type RouteResolver,
} from './provider-adapter.ts';
import { InboxCursorStore } from './cursor-store.ts';
import { InboundPoller, type ProviderStatus } from './poller.ts';
import { createSlackAdapter, SLACK_PROVIDER_ID } from './providers/slack.ts';
import { createDiscordAdapter, DISCORD_PROVIDER_ID } from './providers/discord.ts';
import { createEmailAdapter, EMAIL_PROVIDER_ID } from './providers/email.ts';

export const INBOX_LIST_METHOD_ID = 'channels.inbox.list';
export const INBOX_LIST_SCOPES = ['channels:inbox:read'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export interface InboxListInput {
  providers?: string[];
  limit?: number;
  since?: number;
}

export interface InboxProviderReport {
  id: string;
  state: ProviderStatus['state'];
  itemCount: number;
  error?: string;
}

export interface InboxListOutput {
  items: InboundChannelItem[];
  nextSince: number;
  providers: InboxProviderReport[];
}

export interface RegisterInboxOptions {
  /** Route resolver injected by the routing surface (optional, best-effort). */
  resolveRouteId?: RouteResolver;
  /** Override the cursor-store filename (tests). */
  storeFileName?: string;
  /** Skip the initial seed poll (tests that drive polling manually). */
  skipInitialPoll?: boolean;
  /** Replace the default built-in adapter set (tests). */
  registerBuiltins?: boolean;
}

function registerBuiltinAdapters(): void {
  registerAdapterFactory(SLACK_PROVIDER_ID, (ctx) => createSlackAdapter(ctx));
  registerAdapterFactory(DISCORD_PROVIDER_ID, (ctx) => createDiscordAdapter(ctx));
  registerAdapterFactory(EMAIL_PROVIDER_ID, (ctx) => createEmailAdapter(ctx));
}

const INBOX_LIST_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['items', 'nextSince', 'providers'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id', 'provider', 'kind', 'fromDigest',
          'subjectPreview', 'bodyPreview', 'receivedAt', 'unread',
        ],
        properties: {
          id: { type: 'string' },
          provider: { type: 'string' },
          kind: { type: 'string', enum: ['dm', 'thread', 'mention', 'reaction'] },
          fromDigest: { type: 'string' },
          subjectPreview: { type: 'string', maxLength: 200 },
          bodyPreview: { type: 'string', maxLength: 500 },
          routeId: { type: 'string' },
          receivedAt: { type: 'number' },
          unread: { type: 'boolean' },
          triageScore: { type: 'number' },
          triageTags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    nextSince: { type: 'number' },
    providers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'state', 'itemCount'],
        properties: {
          id: { type: 'string' },
          state: { type: 'string', enum: ['ready', 'unavailable', 'empty'] },
          itemCount: { type: 'number' },
          error: { type: 'string' },
        },
      },
    },
  },
};

const INBOX_LIST_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    providers: { type: 'array', items: { type: 'string' } },
    limit: { type: 'number', minimum: 1, maximum: MAX_LIMIT },
    since: { type: 'number', minimum: 0 },
  },
};

function normalizeInput(body: unknown): { providers?: string[]; limit: number; since?: number } {
  const input = (body ?? {}) as InboxListInput;
  const providers = Array.isArray(input.providers)
    ? input.providers.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : undefined;
  let limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? Math.floor(input.limit)
    : DEFAULT_LIMIT;
  limit = Math.min(Math.max(1, limit), MAX_LIMIT);
  const since = typeof input.since === 'number' && Number.isFinite(input.since) && input.since >= 0
    ? Math.floor(input.since)
    : undefined;
  return {
    ...(providers && providers.length > 0 ? { providers } : {}),
    limit,
    ...(since !== undefined ? { since } : {}),
  };
}

/**
 * Register the inbox surface. Returns an Unregister that tears down the poller,
 * closes the store, and removes the operator method.
 */
export function registerInboxMethods(
  ctx: OperatorContext,
  options: RegisterInboxOptions = {},
): Unregister {
  if (options.registerBuiltins !== false) {
    registerBuiltinAdapters();
  }

  const credentials = createDaemonCredentialStore(ctx.secrets);
  const adapterContext: AdapterContext = {
    credentials,
    logger: ctx.logger,
    ...(options.resolveRouteId ? { resolveRouteId: options.resolveRouteId } : {}),
  };
  const adapters = buildAdapters(adapterContext);
  const store = new InboxCursorStore(ctx.workingDirectory, options.storeFileName);
  const poller = new InboundPoller({ adapters, store, logger: ctx.logger });

  // Async bootstrap: init store, seed one poll, start loops. Failures are
  // logged but never thrown out of register() — the method still serves the
  // (possibly empty) persisted feed and reports provider states.
  const ready: Promise<void> = (async () => {
    await store.init();
    if (!options.skipInitialPoll) {
      await poller.pollOnce();
    }
    poller.start();
  })().catch((error: unknown) => {
    ctx.logger.error('inbox surface bootstrap failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const handler = async (
    invocation: OperatorInvocation<InboxListInput>,
  ): Promise<InboxListOutput> => {
    await ready;
    const { providers, limit, since } = normalizeInput(invocation.body);
    const items = store.listItems({ ...(providers ? { providers } : {}), ...(since !== undefined ? { since } : {}), limit });
    const maxReceived = store.maxReceivedAt(providers);
    const nextSince = Math.max(since ?? 0, maxReceived);
    const statuses = poller.snapshotStatuses(providers);
    const reports: InboxProviderReport[] = statuses.map((status) => ({
      id: status.id,
      state: status.state,
      itemCount: status.itemCount,
      ...(status.error ? { error: status.error } : {}),
    }));
    return { items, nextSince, providers: reports };
  };

  const unregisterMethod = declareOperatorMethod<InboxListInput, InboxListOutput>(
    ctx,
    {
      id: INBOX_LIST_METHOD_ID,
      title: 'List inbound channel items',
      description:
        'Aggregated, deduplicated inbound feed (DMs/threads/mentions) across '
        + 'configured providers. Read-only; advances a monotonic nextSince cursor.',
      category: 'channels',
      source: 'daemon',
      access: 'operator',
      transport: ['ws', 'internal'],
      scopes: INBOX_LIST_SCOPES,
      effect: 'read-only',
      confirm: false,
      inputSchema: INBOX_LIST_INPUT_SCHEMA,
      outputSchema: INBOX_LIST_OUTPUT_SCHEMA,
    },
    handler,
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

/**
 * SurfaceRegister contract entry point. Integration wires the inbox surface by
 * calling this from its surface bootstrap (the same mechanism every other
 * daemon surface uses, e.g. routing/triage), retaining the returned Unregister
 * for teardown. This is the production caller of `registerInboxMethods`.
 */
export const register: SurfaceRegister = (ctx) => registerInboxMethods(ctx);
