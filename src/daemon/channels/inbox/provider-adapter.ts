// ---------------------------------------------------------------------------
// Inbound provider adapter contract + registry.
//
// Each adapter owns ONE provider (slack, discord, email, ...). The poller calls
// adapter.poll() on a cadence, dedups by item.id, and persists into the cursor
// store. Adapters resolve credentials ONLY through the daemon credential store
// and NEVER return raw sender ids or unredacted bodies — mapping/redaction is
// the adapter's responsibility (see mapping helpers in `./mapping.ts`).
//
// CRITICAL: when a credential is missing/misconfigured an adapter returns
// state 'unavailable' WITH an error string. It is NEVER silently omitted — the
// caller must be able to distinguish "configured-but-empty" from "not wired".
// ---------------------------------------------------------------------------

import type { DaemonCredentialStore } from '../../operator/index.ts';
import type { OperatorLogger } from '../../operator/index.ts';

/** Wire-shape inbound item as published by `channels.inbox.list`. */
export interface InboundChannelItem {
  /** Stable, provider-scoped dedup key. Idempotent across polls. */
  id: string;
  provider: string;
  kind: 'dm' | 'thread' | 'mention' | 'reaction';
  /**
   * sha256First(senderExternalId, 16) — NEVER the raw id. 16 hex chars == the
   * first 8 bytes of the SHA-256 digest (handoff: 'first-8' bytes / acceptance
   * checklist: 'first 16 hex chars' — the same value).
   */
  fromDigest: string;
  /** <= 200 chars, safe for display. */
  subjectPreview: string;
  /** <= 500 chars, plain text, PII-stripped. */
  bodyPreview: string;
  /** Daemon route binding id, when resolvable. */
  routeId?: string;
  /** Unix ms. */
  receivedAt: number;
  unread: boolean;
  /** Optional triage metadata written by the triage surface (read-only here). */
  triageScore?: number;
  triageTags?: string[];
}

export type ProviderState = 'ready' | 'unavailable' | 'empty';

export interface ProviderPollResult {
  items: InboundChannelItem[];
  state: ProviderState;
  /** Present only when state === 'unavailable'. */
  error?: string;
}

export interface ProviderPollOptions {
  /** Only return items newer than this Unix-ms timestamp, when supported. */
  since?: number;
  /** Max items to return this poll. */
  limit: number;
}

/** Context handed to every adapter at construction time. */
export interface AdapterContext {
  readonly credentials: DaemonCredentialStore;
  readonly logger: OperatorLogger;
  /**
   * Optional route resolver supplied by the routing surface. Returns the route
   * binding id for a given inbound item, or undefined when no route matches /
   * the routing surface is not wired yet. Adapters/poller call this best-effort.
   */
  readonly resolveRouteId?: RouteResolver;
}

/**
 * Best-effort route resolution seam. The routing surface (concurrent work)
 * injects its `resolveProfile`-backed implementation. Until then it is
 * undefined and items carry no routeId.
 */
export type RouteResolver = (input: {
  provider: string;
  fromDigest: string;
  kind: InboundChannelItem['kind'];
}) => Promise<string | undefined> | string | undefined;

export interface InboundProviderAdapter {
  /** Provider id, e.g. 'slack'. Must be unique within the registry. */
  readonly id: string;
  /**
   * Poll cadence in ms. Slack/Discord 30s, email 60s, everything else 120s.
   * The poller reads this to schedule its per-provider interval.
   */
  readonly pollIntervalMs: number;
  /**
   * Pull recent DMs/threads/mentions. MUST resolve (never reject) — failures
   * are reported via state:'unavailable' + error so one bad provider cannot
   * crash the aggregate feed.
   */
  poll(opts: ProviderPollOptions): Promise<ProviderPollResult>;
}

/** Factory signature: adapters are constructed lazily with shared context. */
export type AdapterFactory = (ctx: AdapterContext) => InboundProviderAdapter;

// ---------------------------------------------------------------------------
// Cadence constants (single source of truth, referenced by adapters + tests).
// ---------------------------------------------------------------------------

export const POLL_CADENCE_MS = {
  realtime: 30_000, // slack, discord
  email: 60_000,
  default: 120_000,
} as const;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const FACTORIES = new Map<string, AdapterFactory>();

/** Register a provider factory. Last registration for an id wins (idempotent). */
export function registerAdapterFactory(id: string, factory: AdapterFactory): void {
  FACTORIES.set(id, factory);
}

/** All registered provider ids, in insertion order. */
export function registeredProviderIds(): string[] {
  return [...FACTORIES.keys()];
}

/**
 * Construct adapters for the requested provider ids (or all registered ids when
 * `requested` is undefined/empty). Unknown ids are ignored by the caller via the
 * returned map only containing known providers.
 */
export function buildAdapters(
  ctx: AdapterContext,
  requested?: readonly string[],
): Map<string, InboundProviderAdapter> {
  const ids = requested && requested.length > 0
    ? requested.filter((id) => FACTORIES.has(id))
    : registeredProviderIds();
  const out = new Map<string, InboundProviderAdapter>();
  for (const id of ids) {
    const factory = FACTORIES.get(id);
    if (!factory) continue;
    out.set(id, factory(ctx));
  }
  return out;
}

/** Test/seam hook: clear the registry. */
export function clearAdapterRegistry(): void {
  FACTORIES.clear();
}
