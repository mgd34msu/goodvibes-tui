import { logger } from '../utils/logger.ts';
import type { EventBus } from '../core/event-bus.ts';
import { SlackIntegration } from './slack.ts';
import { DiscordIntegration } from './discord.ts';

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

  constructor(options?: { slack?: SlackIntegration; discord?: DiscordIntegration }) {
    this.slack = options?.slack;
    this.discord = options?.discord;
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
    const errors: string[] = [];

    if (this.slack) {
      try {
        await this.slack.postWebhook(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Slack: ${msg}`);
        logger.warn('Notifier: Slack notification failed', { error: msg });
      }
    }

    if (this.discord) {
      try {
        await this.discord.postWebhook(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Discord: ${msg}`);
        logger.warn('Notifier: Discord notification failed', { error: msg });
      }
    }

    if (errors.length > 0) {
      logger.warn('Notifier.notify: some channels failed', { errors });
    }
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
        const result = data.result as unknown as Record<string, unknown>;
        void this.notify('subagent:complete', {
          event: 'subagent:complete',
          agentId: data.id,
          task: typeof result?.task === 'string' ? result.task : data.id,
          result: typeof result?.output === 'string' ? result.output : '',
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
