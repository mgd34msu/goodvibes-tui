import { logger } from '../utils/logger.ts';
import type { EventBus } from '../core/event-bus.ts';
import { SlackIntegration } from './slack.ts';
import { DiscordIntegration } from './discord.ts';
import { DeliveryQueue } from './delivery.ts';
import type { DeliveryQueueConfig, IntegrationQueueStatus } from './delivery.ts';
import { snapshotQueueStatus } from './delivery.ts';

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

/**
 * Notifier — unified notification dispatcher.
 *
 * Reads configuration from environment variables:
 *   SLACK_WEBHOOK_URL, SLACK_BOT_TOKEN
 *   DISCORD_WEBHOOK_URL, DISCORD_BOT_TOKEN
 *
 * Attach to an EventBus to automatically post notifications for key events.
 */
export class Notifier {
  private slack?: SlackIntegration;
  private discord?: DiscordIntegration;
  private unsubscribers: Array<() => void> = [];
  private readonly _queue: DeliveryQueue;

  constructor(options?: {
    slack?: SlackIntegration;
    discord?: DiscordIntegration;
    delivery?: Partial<DeliveryQueueConfig>;
  }) {
    this.slack = options?.slack;
    this.discord = options?.discord;
    this._queue = new DeliveryQueue(options?.delivery ?? {});
  }

  /**
   * Create a Notifier pre-wired from environment variables.
   */
  static fromEnv(): Notifier {
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const discordWebhook = process.env.DISCORD_WEBHOOK_URL;
    const discordToken = process.env.DISCORD_BOT_TOKEN;

    const slack =
      slackWebhook || slackToken
        ? new SlackIntegration(slackWebhook, slackToken)
        : undefined;

    const discord =
      discordWebhook || discordToken
        ? new DiscordIntegration(discordWebhook, discordToken)
        : undefined;

    return new Notifier({ slack, discord });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Send a notification to all configured channels.
   *
   * @param event  - Human-readable event name (used as message text)
   * @param data   - Arbitrary key/value payload for formatting
   */
  async notify(event: string, data: Record<string, unknown>): Promise<void> {
    const text = this.formatText(event, data);

    if (this.slack) {
      const slack = this.slack;
      await this._queue.enqueue('slack', event, text, () => slack.postWebhook(text));
    }

    if (this.discord) {
      const discord = this.discord;
      await this._queue.enqueue('discord', event, text, () => discord.postWebhook(text));
    }
  }

  /**
   * Get delivery queue status snapshots for all active channels.
   * Used by integration diagnostics to surface queue and DLQ state.
   */
  getQueueStatus(): IntegrationQueueStatus[] {
    const sloEnforced = this._queue.sloEnforced;
    const statuses: IntegrationQueueStatus[] = [];
    if (this.slack) {
      statuses.push(snapshotQueueStatus('slack', this._queue, sloEnforced));
    }
    if (this.discord) {
      statuses.push(snapshotQueueStatus('discord', this._queue, sloEnforced));
    }
    return statuses;
  }

  /**
   * Replay all dead-letter entries to their respective channels.
   * Re-attempts delivery for each DLQ entry; results are returned per-entry.
   */
  async replayDeadLetters(): Promise<Array<{ id: string; outcome: import('./delivery.ts').DeliveryOutcome }>> {
    return this._queue.replay(async (dlqEntry) => {
      const text = dlqEntry.payload;
      if (dlqEntry.channel === 'slack' && this.slack) {
        await this.slack.postWebhook(text);
      } else if (dlqEntry.channel === 'discord' && this.discord) {
        await this.discord.postWebhook(text);
      } else {
        throw new Error(`No active integration for channel: ${dlqEntry.channel}`);
      }
    });
  }

  /** Dispose the delivery queue (cancel pending timers). Call on shutdown. */
  dispose(): void {
    this._queue.dispose();
  }

  /**
   * Subscribe to relevant EventBus events and automatically dispatch notifications.
   *
   * Events handled:
   *   subagent:complete  → "Agent completed: {task}"
   *   wrfc:chain-passed  → "Review passed: {score}/10"
   *   wrfc:chain-failed  → "Review chain failed: {reason}"
   *   plan:activate      → "Plan activated: {task}"
   */
  attachToEventBus(bus: EventBus): void {
    this.detachFromEventBus();

    this.unsubscribers.push(
      bus.on('subagent:complete', (data) => {
        void this.notify('subagent:complete', {
          event: 'subagent:complete',
          agentId: data.id,
          task: data.result.output?.slice(0, 100) ?? data.id,
          result: data.result.output,
        });
      }),
    );

    this.unsubscribers.push(
      bus.on('wrfc:chain-passed', (data) => {
        void this.notify('wrfc:chain-passed', {
          event: 'wrfc:chain-passed',
          chainId: data.chainId,
        });
      }),
    );

    this.unsubscribers.push(
      bus.on('wrfc:chain-failed', (data) => {
        void this.notify('wrfc:chain-failed', {
          event: 'wrfc:chain-failed',
          chainId: data.chainId,
          reason: data.reason,
        });
      }),
    );

    this.unsubscribers.push(
      bus.on('plan:activate', (data) => {
        void this.notify('plan:activate', {
          event: 'plan:activate',
          planId: data.planId,
          task: data.task,
        });
      }),
    );

    logger.info('Notifier: attached to EventBus');
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

  private formatText(event: string, data: Record<string, unknown>): string {
    switch (event) {
      case 'subagent:complete': {
        const task = typeof data.task === 'string' ? data.task : String(data.agentId ?? '');
        return `Agent completed: ${task}`;
      }
      case 'wrfc:chain-passed': {
        const score = typeof data.score === 'number' ? `${data.score}/10` : 'passed';
        return `Review passed: ${score}`;
      }
      case 'wrfc:chain-failed': {
        const reason = typeof data.reason === 'string' ? data.reason : 'unknown reason';
        return `Review chain failed: ${reason}`;
      }
      case 'plan:activate': {
        const task = typeof data.task === 'string' ? data.task : String(data.planId ?? '');
        return `Plan activated: ${task}`;
      }
      default: {
        const extras = Object.entries(data)
          .filter(([k]) => k !== 'event')
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ');
        return extras ? `${event}: ${extras}` : event;
      }
    }
  }
}
