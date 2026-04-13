import { logger } from '../utils/logger.ts';
import type { RuntimeEventBus, AgentEvent, WorkflowEvent } from '../runtime/events/index.ts';
import { SlackIntegration } from './slack.ts';
import { DiscordIntegration } from './discord.ts';
import { DeliveryQueue } from './delivery.ts';
import type { DeliveryQueueConfig, IntegrationQueueStatus } from './delivery.ts';
import { snapshotQueueStatus } from './delivery.ts';
import { ServiceRegistry } from '../config/service-registry.ts';

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
 * Attach to the RuntimeEventBus to automatically post notifications for key events.
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
   * Create a Notifier pre-wired from configured services and environment variables.
   */
  static async fromConfig(serviceRegistry: Pick<ServiceRegistry, 'resolveSecret'>): Promise<Notifier> {
    const [
      slackWebhookFromService,
      slackTokenFromService,
      discordWebhookFromService,
      discordTokenFromService,
    ] = await Promise.all([
      serviceRegistry.resolveSecret('slack', 'webhookUrl'),
      serviceRegistry.resolveSecret('slack', 'primary'),
      serviceRegistry.resolveSecret('discord', 'webhookUrl'),
      serviceRegistry.resolveSecret('discord', 'primary'),
    ]);

    const slackWebhook = slackWebhookFromService ?? process.env.SLACK_WEBHOOK_URL;
    const slackToken = slackTokenFromService ?? process.env.SLACK_BOT_TOKEN;
    const discordWebhook = discordWebhookFromService ?? process.env.DISCORD_WEBHOOK_URL;
    const discordToken = discordTokenFromService ?? process.env.DISCORD_BOT_TOKEN;

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

  attachToRuntimeBus(bus: RuntimeEventBus): void {
    this.detach();

    this.unsubscribers.push(
      bus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
        void this.notify('AGENT_COMPLETED', {
          event: 'AGENT_COMPLETED',
          agentId: payload.agentId,
          task: payload.output?.slice(0, 100) ?? payload.agentId,
          result: payload.output,
        });
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', ({ payload }) => {
        void this.notify('WORKFLOW_CHAIN_PASSED', {
          event: 'WORKFLOW_CHAIN_PASSED',
          chainId: payload.chainId,
        });
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', ({ payload }) => {
        void this.notify('WORKFLOW_CHAIN_FAILED', {
          event: 'WORKFLOW_CHAIN_FAILED',
          chainId: payload.chainId,
          reason: payload.reason,
        });
      }),
    );

    logger.info('Notifier: attached to RuntimeEventBus');
  }

  /** Remove all notification subscriptions. */
  detach(): void {
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
      case 'AGENT_COMPLETED': {
        const task = typeof data.task === 'string' ? data.task : String(data.agentId ?? '');
        return `Agent completed: ${task}`;
      }
      case 'WORKFLOW_CHAIN_PASSED': {
        const score = typeof data.score === 'number' ? `${data.score}/10` : 'passed';
        return `Review passed: ${score}`;
      }
      case 'WORKFLOW_CHAIN_FAILED': {
        const reason = typeof data.reason === 'string' ? data.reason : 'unknown reason';
        return `Review chain failed: ${reason}`;
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
