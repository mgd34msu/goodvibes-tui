// ---------------------------------------------------------------------------
// Inbound provider poller.
//
// Runs one setInterval per provider at the provider's own cadence (Slack/
// Discord 30s, email 60s, others 120s). Each tick:
//   1. resolves the provider's persisted cursor (nextSince)
//   2. calls adapter.poll({ since, limit })
//   3. dedups + persists items into the cursor store (upsert)
//   4. advances the cursor monotonically to max(receivedAt)
//   5. records the last per-provider state for channels.inbox.list to report
//
// One bad provider can never crash the loop: adapter.poll() resolves with
// state:'unavailable' instead of rejecting, and any thrown error is caught and
// downgraded to an 'unavailable' status here.
// ---------------------------------------------------------------------------

import type { InboundProviderAdapter, ProviderState } from './provider-adapter.ts';
import type { InboxCursorStore } from './cursor-store.ts';
import type { HandlerLogger } from '../context.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export interface ProviderStatus {
  id: string;
  state: ProviderState;
  itemCount: number;
  error?: string;
  lastPolledAt?: number;
}

export interface PollerOptions {
  adapters: Map<string, InboundProviderAdapter>;
  store: InboxCursorStore;
  logger: HandlerLogger;
  /** Max items fetched per provider per tick. */
  perProviderLimit?: number;
  /** Inject a timer factory for tests (defaults to global setInterval). */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

const DEFAULT_PER_PROVIDER_LIMIT = 50;

export class InboundPoller {
  private readonly adapters: Map<string, InboundProviderAdapter>;
  private readonly store: InboxCursorStore;
  private readonly logger: HandlerLogger;
  private readonly perProviderLimit: number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly statuses = new Map<string, ProviderStatus>();
  private readonly inFlight = new Set<string>();
  private started = false;

  constructor(options: PollerOptions) {
    this.adapters = options.adapters;
    this.store = options.store;
    this.logger = options.logger;
    this.perProviderLimit = options.perProviderLimit ?? DEFAULT_PER_PROVIDER_LIMIT;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
    for (const id of this.adapters.keys()) {
      this.statuses.set(id, { id, state: 'empty', itemCount: 0 });
    }
  }

  /** Begin per-provider interval loops. Idempotent. Does NOT poll immediately. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const id of this.adapters.keys()) this.startProvider(id);
  }

  /**
   * Begin ONE provider's interval loop. Idempotent.
   *
   * Each inbox account is its own surface in the LAN election, so the machine
   * that reads the work Slack account may not be the machine that reads the
   * mailbox. A blanket start/stop cannot express that: it would take every
   * account down to hand one of them over. Everything below is therefore
   * addressable per provider, and the blanket calls are fan-outs over it.
   */
  startProvider(id: string): void {
    if (this.timers.has(id)) return;
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    const handle = this.setIntervalImpl(() => {
      void this.pollProvider(id, adapter);
    }, adapter.pollIntervalMs);
    // Do not keep the event loop alive solely for polling (Bun/Node unref).
    (handle as unknown as { unref?: () => void }).unref?.();
    this.timers.set(id, handle);
  }

  /**
   * Stop ONE provider's interval loop. Idempotent.
   *
   * Synchronous underneath — clearing the interval means no further tick can
   * be scheduled — which is what lets the RESIGN that follows a handoff be an
   * honest claim that this node has stopped reading that account.
   */
  stopProvider(id: string): void {
    const handle = this.timers.get(id);
    if (handle === undefined) return;
    this.clearIntervalImpl(handle);
    this.timers.delete(id);
    if (this.timers.size === 0) this.started = false;
  }

  /** True when this node is polling the given provider right now. */
  isProviderRunning(id: string): boolean {
    return this.timers.has(id);
  }

  /** Every provider this node has an adapter for. */
  providerIds(): string[] {
    return [...this.adapters.keys()];
  }

  /** Run a single poll across all providers now (used on register + tests). */
  async pollOnce(): Promise<void> {
    await Promise.all(
      [...this.adapters.entries()].map(([id, adapter]) => this.pollProvider(id, adapter)),
    );
  }

  /** Run a single poll for ONE provider now. Never throws. */
  async pollProviderOnce(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    await this.pollProvider(id, adapter);
  }

  /** Poll a single provider, dedup + persist, update status. Never throws. */
  async pollProvider(id: string, adapter: InboundProviderAdapter): Promise<void> {
    if (this.inFlight.has(id)) return; // skip overlapping ticks
    this.inFlight.add(id);
    const since = this.store.getCursor(id) || undefined;
    try {
      const result = await adapter.poll({ since, limit: this.perProviderLimit });
      if (result.state === 'unavailable') {
        this.setStatus(id, {
          id,
          state: 'unavailable',
          itemCount: 0,
          error: result.error ?? 'provider unavailable',
          lastPolledAt: Date.now(),
        });
        return;
      }
      const newCount = this.store.upsertItems(result.items);
      let maxReceived = since ?? 0;
      for (const item of result.items) {
        if (item.receivedAt > maxReceived) maxReceived = item.receivedAt;
      }
      if (maxReceived > 0) this.store.advanceCursor(id, maxReceived);
      await this.store.flush();
      this.setStatus(id, {
        id,
        state: result.items.length > 0 ? 'ready' : 'empty',
        itemCount: newCount,
        lastPolledAt: Date.now(),
      });
    } catch (error) {
      const message = summarizeError(error);
      this.logger.warn('inbound poll failed', { provider: id, error: message });
      this.setStatus(id, {
        id,
        state: 'unavailable',
        itemCount: 0,
        error: message,
        lastPolledAt: Date.now(),
      });
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Snapshot of the last known status for each provider. */
  snapshotStatuses(providerIds?: readonly string[]): ProviderStatus[] {
    const ids = providerIds && providerIds.length > 0
      ? providerIds.filter((id) => this.statuses.has(id))
      : [...this.statuses.keys()];
    return ids.map((id) => {
      const status = this.statuses.get(id)!;
      return { ...status };
    });
  }

  /** Stop all interval loops. Idempotent. */
  stop(): void {
    for (const handle of this.timers.values()) {
      this.clearIntervalImpl(handle);
    }
    this.timers.clear();
    this.started = false;
  }

  private setStatus(id: string, status: ProviderStatus): void {
    this.statuses.set(id, status);
  }
}
