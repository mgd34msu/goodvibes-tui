import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackSlashCommand {
  type: 'slash_command';
  command: string;
  text: string;
  userId: string;
  userName: string;
  channelId: string;
  channelName: string;
  teamId: string;
  responseUrl: string;
}

export interface SlackInteraction {
  type: 'interaction';
  interactionType: string;
  payload: Record<string, unknown>;
  userId: string;
  channelId: string;
  responseUrl?: string;
}

export type SlackEvent = SlackSlashCommand | SlackInteraction;

// ---------------------------------------------------------------------------
// SlackIntegration
// ---------------------------------------------------------------------------

/**
 * SlackIntegration — handles inbound webhook verification/parsing and outbound
 * message posting for Slack slash commands and interactions.
 *
 * Env vars:
 *   SLACK_WEBHOOK_URL      — incoming webhook URL for outbound posting
 *   SLACK_BOT_TOKEN        — Bot User OAuth token (xoxb-…) for API calls
 *   SLACK_SIGNING_SECRET   — used to verify X-Slack-Signature on inbound
 */
export class SlackIntegration {
  constructor(
    private webhookUrl?: string,
    private botToken?: string,
  ) {}

  // -------------------------------------------------------------------------
  // Inbound: verification
  // -------------------------------------------------------------------------

  /**
   * Verify an inbound Slack request using HMAC-SHA256.
   * Slack signs requests with: v0={HMAC-SHA256("v0:{timestamp}:{body}")}
   */
  verifySignature(
    body: string,
    timestamp: string,
    signature: string,
    signingSecret: string,
  ): boolean {
    // Guard against replay attacks (5-minute window)
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(timestamp, 10);
    if (Number.isNaN(ts) || Math.abs(now - ts) > 300) {
      logger.warn('SlackIntegration.verifySignature: timestamp too old');
      return false;
    }

    const baseString = `v0:${timestamp}:${body}`;
    const hmac = createHmac('sha256', signingSecret).update(baseString).digest('hex');
    const expected = `v0=${hmac}`;

    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  // -------------------------------------------------------------------------
  // Inbound: parsing
  // -------------------------------------------------------------------------

  /**
   * Parse an inbound Slack payload into a typed SlackEvent.
   * Supports slash commands (application/x-www-form-urlencoded) and
   * interaction payloads (JSON-encoded in a "payload" field).
   */
  parseEvent(body: Record<string, unknown>): SlackEvent {
    // Interaction payloads arrive as a JSON string in the "payload" field
    if (typeof body.payload === 'string') {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body.payload) as Record<string, unknown>;
      } catch {
        parsed = body;
      }
      const user = (parsed.user ?? {}) as Record<string, unknown>;
      const channel = (parsed.channel ?? {}) as Record<string, unknown>;
      return {
        type: 'interaction',
        interactionType: typeof parsed.type === 'string' ? parsed.type : 'unknown',
        payload: parsed,
        userId: typeof user.id === 'string' ? user.id : '',
        channelId: typeof channel.id === 'string' ? channel.id : '',
        responseUrl: typeof parsed.response_url === 'string' ? parsed.response_url : undefined,
      };
    }

    // Slash command — fields come as top-level form values
    return {
      type: 'slash_command',
      command: typeof body.command === 'string' ? body.command : '',
      text: typeof body.text === 'string' ? body.text : '',
      userId: typeof body.user_id === 'string' ? body.user_id : '',
      userName: typeof body.user_name === 'string' ? body.user_name : '',
      channelId: typeof body.channel_id === 'string' ? body.channel_id : '',
      channelName: typeof body.channel_name === 'string' ? body.channel_name : '',
      teamId: typeof body.team_id === 'string' ? body.team_id : '',
      responseUrl: typeof body.response_url === 'string' ? body.response_url : '',
    };
  }

  // -------------------------------------------------------------------------
  // Outbound: posting
  // -------------------------------------------------------------------------

  /**
   * Post a message to a channel using the Slack Web API (chat.postMessage).
   * Requires SLACK_BOT_TOKEN.
   */
  async postMessage(channel: string, text: string, blocks?: unknown[]): Promise<void> {
    if (!this.botToken) {
      throw new Error('SlackIntegration: botToken is required for postMessage');
    }
    const payload: Record<string, unknown> = { channel, text };
    if (blocks && blocks.length > 0) {
      payload.blocks = blocks;
    }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.botToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`SlackIntegration.postMessage failed (${res.status}): ${err}`);
    }
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(`SlackIntegration.postMessage API error: ${data.error ?? 'unknown'}`);
    }
  }

  /**
   * Post a message via an Incoming Webhook URL.
   * Requires SLACK_WEBHOOK_URL or a URL passed at call time.
   */
  async postWebhook(text: string, blocks?: unknown[], url?: string): Promise<void> {
    const target = url ?? this.webhookUrl;
    if (!target) {
      throw new Error('SlackIntegration: webhookUrl is required for postWebhook');
    }
    const payload: Record<string, unknown> = { text };
    if (blocks && blocks.length > 0) {
      payload.blocks = blocks;
    }
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`SlackIntegration.postWebhook failed (${res.status}): ${err}`);
    }
  }

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------

  /**
   * Format an agent result as Slack Block Kit blocks.
   */
  formatAgentResult(agentId: string, task: string, result: string): unknown[] {
    const truncated = result.length > 2900 ? `${result.slice(0, 2900)}\n\n_…truncated_` : result;
    return [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Agent Complete', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Task:*\n${task}` },
          { type: 'mrkdwn', text: `*Agent ID:*\n\`${agentId}\`` },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: truncated },
      },
    ];
  }

  /**
   * Format a session summary as Slack Block Kit blocks.
   */
  formatSessionSummary(
    sessionId: string,
    messageCount: number,
    tokensUsed: number,
  ): unknown[] {
    return [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Session Summary', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Session ID:*\n\`${sessionId}\`` },
          { type: 'mrkdwn', text: `*Messages:*\n${messageCount}` },
          { type: 'mrkdwn', text: `*Tokens Used:*\n${tokensUsed.toLocaleString()}` },
        ],
      },
    ];
  }
}
