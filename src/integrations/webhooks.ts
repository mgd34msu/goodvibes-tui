import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { RuntimeEventBus, AgentEvent, WorkflowEvent } from '../runtime/events/index.ts';

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
 *   notifier.attachToRuntimeBus(runtimeBus);
 */
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
  // Runtime event integration
  // -------------------------------------------------------------------------

  attachToRuntimeBus(bus: RuntimeEventBus): void {
    this.detach();

    this.unsubscribers.push(
      bus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
        void this.send(`Agent completed: ${payload.agentId}`);
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
        void this.send(`Agent failed: ${payload.agentId} — ${payload.error}`);
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', ({ payload }) => {
        void this.send(`WRFC passed: chain ${payload.chainId}`);
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', ({ payload }) => {
        void this.send(`WRFC failed: ${payload.reason}`);
      }),
    );

    logger.info('WebhookNotifier: attached to RuntimeEventBus', { urlCount: this.urls.length });
  }

  /** Remove all webhook subscriptions. */
  detach(): void {
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
