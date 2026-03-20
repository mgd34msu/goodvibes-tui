import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discord interaction types (subset used here) */
export const DiscordInteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ApplicationCommandAutocomplete: 4,
  ModalSubmit: 5,
} as const;

/** Discord interaction response types */
export const DiscordInteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  DeferredUpdateMessage: 6,
} as const;

export interface DiscordInteraction {
  id: string;
  type: number;
  applicationId: string;
  token: string;
  guildId?: string;
  channelId?: string;
  userId: string;
  commandName?: string;
  commandOptions?: Array<{ name: string; value: unknown }>;
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DiscordIntegration
// ---------------------------------------------------------------------------

/**
 * DiscordIntegration — handles inbound interaction verification/parsing and
 * outbound message posting for Discord slash commands and webhooks.
 *
 * Env vars:
 *   DISCORD_WEBHOOK_URL   — webhook URL for outbound posting
 *   DISCORD_BOT_TOKEN     — bot token for Discord API calls
 *   DISCORD_PUBLIC_KEY    — Ed25519 public key for interaction verification
 */
export class DiscordIntegration {
  constructor(
    private webhookUrl?: string,
    private botToken?: string,
  ) {}

  // -------------------------------------------------------------------------
  // Inbound: verification
  // -------------------------------------------------------------------------

  /**
   * Verify an inbound Discord interaction using Ed25519.
   * Discord signs: timestamp + body with the application's public key.
   */
  async verifySignature(
    body: string,
    signature: string,
    timestamp: string,
    publicKey: string,
  ): Promise<boolean> {
    try {
      const keyBytes = this.hexToBytes(publicKey);
      const sigBytes = this.hexToBytes(signature);
      const message = new TextEncoder().encode(timestamp + body);

      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );

      return await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, message);
    } catch (err) {
      logger.warn('DiscordIntegration.verifySignature: verification error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Inbound: parsing
  // -------------------------------------------------------------------------

  /**
   * Parse an inbound Discord interaction payload into a typed DiscordInteraction.
   */
  parseInteraction(body: Record<string, unknown>): DiscordInteraction {
    const member = (body.member ?? {}) as Record<string, unknown>;
    const memberUser = (member.user ?? {}) as Record<string, unknown>;
    const directUser = (body.user ?? {}) as Record<string, unknown>;
    // Guild interactions put the user under member.user; DMs put it under user
    const userObj = Object.keys(memberUser).length > 0 ? memberUser : directUser;

    const data = (body.data ?? {}) as Record<string, unknown>;
    const options = Array.isArray(data.options)
      ? (data.options as Array<Record<string, unknown>>).map((o) => ({
          name: typeof o.name === 'string' ? o.name : '',
          value: o.value,
        }))
      : undefined;

    return {
      id: typeof body.id === 'string' ? body.id : '',
      type: typeof body.type === 'number' ? body.type : 0,
      applicationId: typeof body.application_id === 'string' ? body.application_id : '',
      token: typeof body.token === 'string' ? body.token : '',
      guildId: typeof body.guild_id === 'string' ? body.guild_id : undefined,
      channelId: typeof body.channel_id === 'string' ? body.channel_id : undefined,
      userId: typeof userObj.id === 'string' ? userObj.id : '',
      commandName: typeof data.name === 'string' ? data.name : undefined,
      commandOptions: options,
      raw: body,
    };
  }

  // -------------------------------------------------------------------------
  // Outbound: posting
  // -------------------------------------------------------------------------

  /**
   * Post a message via Discord webhook URL.
   */
  async postWebhook(content: string, embeds?: unknown[], url?: string): Promise<void> {
    const target = url ?? this.webhookUrl;
    if (!target) {
      throw new Error('DiscordIntegration: webhookUrl is required for postWebhook');
    }
    const payload: Record<string, unknown> = {};
    if (content) payload.content = content;
    if (embeds && embeds.length > 0) payload.embeds = embeds;

    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`DiscordIntegration.postWebhook failed (${res.status}): ${err}`);
    }
  }

  /**
   * Post a message to a channel via the Discord Bot API.
   * Requires DISCORD_BOT_TOKEN.
   */
  async postMessage(channelId: string, content: string, embeds?: unknown[]): Promise<void> {
    if (!this.botToken) {
      throw new Error('DiscordIntegration: botToken is required for postMessage');
    }
    this.validateSnowflake(channelId, 'channelId');
    const payload: Record<string, unknown> = {};
    if (content) payload.content = content;
    if (embeds && embeds.length > 0) payload.embeds = embeds;

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${this.botToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`DiscordIntegration.postMessage failed (${res.status}): ${err}`);
    }
  }

  /**
   * Respond to an interaction via the Discord interactions endpoint.
   * Use this to send the deferred acknowledgment or a follow-up.
   */
  async respondToInteraction(
    interactionId: string,
    interactionToken: string,
    type: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    this.validateSnowflake(interactionId, 'interactionId');
    const payload: Record<string, unknown> = { type };
    if (data) payload.data = data;

    const res = await fetch(
      `https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    // 204 No Content is the normal success code
    if (!res.ok && res.status !== 204) {
      const err = await res.text();
      throw new Error(`DiscordIntegration.respondToInteraction failed (${res.status}): ${err}`);
    }
  }

  /**
   * Edit the original deferred interaction response (follow-up).
   */
  async editOriginalResponse(
    applicationId: string,
    interactionToken: string,
    content: string,
    embeds?: unknown[],
  ): Promise<void> {
    this.validateSnowflake(applicationId, 'applicationId');
    const payload: Record<string, unknown> = { content };
    if (embeds && embeds.length > 0) payload.embeds = embeds;

    const res = await fetch(
      `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(
        `DiscordIntegration.editOriginalResponse failed (${res.status}): ${err}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------

  /**
   * Format an agent result as a Discord embed object.
   */
  formatAgentResult(agentId: string, task: string, result: string): unknown {
    const truncated =
      result.length > 4000 ? `${result.slice(0, 4000)}\n\n*…truncated*` : result;
    return {
      title: 'Agent Complete',
      color: 0x57f287, // green
      fields: [
        { name: 'Task', value: task.slice(0, 1024), inline: false },
        { name: 'Agent ID', value: `\`${agentId}\``, inline: true },
      ],
      description: truncated,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Format a session summary as a Discord embed object.
   */
  formatSessionSummary(
    sessionId: string,
    messageCount: number,
    tokensUsed: number,
  ): unknown {
    return {
      title: 'Session Summary',
      color: 0x5865f2, // blurple
      fields: [
        { name: 'Session ID', value: `\`${sessionId}\``, inline: false },
        { name: 'Messages', value: String(messageCount), inline: true },
        { name: 'Tokens Used', value: tokensUsed.toLocaleString(), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('DiscordIntegration: invalid hex string');
    }
    const buf = new ArrayBuffer(hex.length / 2);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  private validateSnowflake(id: string, name: string): void {
    if (!/^\d{17,20}$/.test(id)) {
      throw new Error(`DiscordIntegration: invalid ${name}: ${id}`);
    }
  }
}
