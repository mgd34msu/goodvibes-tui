import { logger } from '../utils/logger.ts';
import type { EventBus } from '../core/event-bus.ts';

// ---------------------------------------------------------------------------
// WebhookNotifier
// ---------------------------------------------------------------------------

/**
 * WebhookNotifier — sends HTTP POST notifications to configured webhook URLs.
 *
 * Defaults to ntfy.sh-compatible format: plain text body, no auth required.
 * Works with any service that accepts a plain POST with a text/plain body,
 * including ntfy.sh, generic webhooks, and custom endpoints.
 *
 * Usage:
 *   const notifier = new WebhookNotifier(['https://ntfy.sh/my-topic']);
 *   notifier.attachToEventBus(bus);
 */
// ---------------------------------------------------------------------------
// Module-level singleton — wired at startup, accessible to command handlers
// ---------------------------------------------------------------------------

let _liveNotifier: WebhookNotifier | null = null;

/**
 * Set the live WebhookNotifier instance (called from main.ts after wiring to EventBus).
 * The /notify test command uses this to send test pings through the active instance.
 */
export function setWebhookNotifier(notifier: WebhookNotifier): void {
  _liveNotifier = notifier;
}

/**
 * Get the live WebhookNotifier instance, or null if not yet initialized.
 */
export function getWebhookNotifier(): WebhookNotifier | null {
  return _liveNotifier;
}

export class WebhookNotifier {
  private urls: string[];
  private unsubscribers: Array<() => void> = [];

  constructor(urls: string[] = []) {
    this.urls = [...urls];
  }

  /**
   * Create a WebhookNotifier from a list of URLs (e.g. from persisted config).
   */
  static fromConfig(urls: string[]): WebhookNotifier {
    return new WebhookNotifier(urls);
  }

  // -------------------------------------------------------------------------
  // URL management
  // -------------------------------------------------------------------------

  /** Add a webhook URL. Ignores duplicates. Throws on invalid URL. */
  addUrl(url: string): void {
    new URL(url); // throws TypeError if url is invalid
    if (!this.urls.includes(url)) {
      this.urls.push(url);
      logger.info('WebhookNotifier: added URL', { url });
    }
  }

  /** Remove a webhook URL. */
  removeUrl(url: string): boolean {
    const before = this.urls.length;
    this.urls = this.urls.filter((u) => u !== url);
    const removed = this.urls.length < before;
    if (removed) logger.info('WebhookNotifier: removed URL', { url });
    return removed;
  }

  /** Replace all webhook URLs. */
  setUrls(urls: string[]): void {
    this.urls = [...urls];
  }

  /** Get a copy of all configured webhook URLs. */
  getUrls(): string[] {
    return [...this.urls];
  }

  /** Returns true if at least one URL is configured. */
  isConfigured(): boolean {
    return this.urls.length > 0;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Send a plain-text notification to all configured webhooks.
   *
   * Uses ntfy.sh format by default: POST with text/plain body.
   * All URLs are fired in parallel; individual failures are logged but do not
   * throw — remaining URLs still receive the notification.
   */
  async send(text: string): Promise<void> {
    if (this.urls.length === 0) return;

    const results = await Promise.allSettled(
      this.urls.map((url) => this.postOne(url, text)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.warn('WebhookNotifier: delivery failed', { url: this.urls[i], error: msg });
      }
    }
  }

  /**
   * Send a test notification to all configured webhooks.
   */
  async test(): Promise<{ url: string; ok: boolean; error?: string }[]> {
    if (this.urls.length === 0) return [];

    const results = await Promise.allSettled(
      this.urls.map((url) => this.postOne(url, 'goodvibes-tui: webhook test')),
    );

    return this.urls.map((url, i) => {
      const result = results[i];
      if (result.status === 'fulfilled') {
        return { url, ok: true };
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return { url, ok: false, error };
      }
    });
  }

  // -------------------------------------------------------------------------
  // EventBus integration
  // -------------------------------------------------------------------------

  /**
   * Subscribe to relevant EventBus events and dispatch webhook notifications.
   *
   * Events handled:
   *   subagent:complete  → "Agent completed: {task}"
   *   subagent:error     → "Agent failed: {id} — {error}"
   *   wrfc:chain-passed  → "WRFC passed: chain {chainId}"
   *   wrfc:chain-failed  → "WRFC failed: {reason}"
   */
  attachToEventBus(bus: EventBus): void {
    this.detachFromEventBus();

    this.unsubscribers.push(
      bus.on('subagent:complete', (data) => {
        void this.send(`Agent completed: ${data.id}`);
      }),
    );

    this.unsubscribers.push(
      bus.on('subagent:error', (data) => {
        const errorMsg = data.error instanceof Error ? data.error.message : String(data.error ?? 'unknown error');
        void this.send(`Agent failed: ${data.id} — ${errorMsg}`);
      }),
    );

    this.unsubscribers.push(
      bus.on('wrfc:chain-passed', (data) => {
        const chainId = String(data.chainId ?? '');
        void this.send(`WRFC passed: chain ${chainId}`);
      }),
    );

    this.unsubscribers.push(
      bus.on('wrfc:chain-failed', (data) => {
        const reason = typeof data.reason === 'string' ? data.reason : 'unknown reason';
        void this.send(`WRFC failed: ${reason}`);
      }),
    );

    logger.info('WebhookNotifier: attached to EventBus', { urlCount: this.urls.length });
  }

  /**
   * Remove all EventBus subscriptions.
   */
  detachFromEventBus(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async postOne(url: string, text: string): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
  }
}
