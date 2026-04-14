import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

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

export interface DiscordOAuthAuthorizeOptions {
  readonly clientId: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly permissions?: string;
  readonly guildId?: string;
  readonly disableGuildSelect?: boolean;
  readonly state?: string;
}

export interface DiscordApplicationCommandOption {
  readonly type: number;
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
}

export interface DiscordApplicationCommand {
  readonly id?: string;
  readonly application_id?: string;
  readonly guild_id?: string;
  readonly name: string;
  readonly description: string;
  readonly type?: number;
  readonly options?: readonly DiscordApplicationCommandOption[];
  readonly default_member_permissions?: string | null;
  readonly dm_permission?: boolean;
}

export interface DiscordGatewayBotResponse {
  readonly url: string;
  readonly shards: number;
  readonly session_start_limit?: Record<string, unknown>;
}

export interface DiscordGatewayDispatch {
  readonly op: number;
  readonly t?: string;
  readonly s?: number;
  readonly d?: Record<string, unknown> | null;
}

export interface DiscordGatewayClientOptions {
  readonly token: string;
  readonly integration: DiscordIntegration;
  readonly intents?: number;
  readonly gatewayUrl?: string;
  readonly onDispatch: (dispatch: DiscordGatewayDispatch, client: DiscordGatewayClient) => void | Promise<void>;
  readonly WebSocketImpl?: typeof WebSocket;
}

export const DiscordGatewayOpcode = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

export const DiscordGatewayIntent = {
  Guilds: 1 << 0,
  GuildMessages: 1 << 9,
  DirectMessages: 1 << 12,
  MessageContent: 1 << 15,
} as const;

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

  static buildOAuthAuthorizeUrl(options: DiscordOAuthAuthorizeOptions): string {
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('scope', (options.scopes?.length ? options.scopes : ['bot', 'applications.commands']).join(' '));
    if (options.redirectUri) url.searchParams.set('redirect_uri', options.redirectUri);
    if (options.permissions) url.searchParams.set('permissions', options.permissions);
    if (options.guildId) url.searchParams.set('guild_id', options.guildId);
    if (options.disableGuildSelect !== undefined) url.searchParams.set('disable_guild_select', options.disableGuildSelect ? 'true' : 'false');
    if (options.state) url.searchParams.set('state', options.state);
    return url.toString();
  }

  static buildGoodVibesCommand(): DiscordApplicationCommand {
    return {
      name: 'goodvibes',
      description: 'Send a prompt to GoodVibes.',
      type: 1,
      options: [
        {
          type: 3,
          name: 'prompt',
          description: 'Prompt or control command to run.',
          required: true,
        },
      ],
    };
  }

  async getGatewayBot(token = this.botToken): Promise<DiscordGatewayBotResponse> {
    return this.apiFetch<DiscordGatewayBotResponse>('/gateway/bot', { token });
  }

  async getCurrentBotUser(token = this.botToken): Promise<Record<string, unknown>> {
    return this.apiFetch<Record<string, unknown>>('/users/@me', { token });
  }

  async listGuildChannels(guildId: string, token = this.botToken): Promise<Array<Record<string, unknown>>> {
    this.validateSnowflake(guildId, 'guildId');
    return this.apiFetch<Array<Record<string, unknown>>>(`/guilds/${guildId}/channels`, { token });
  }

  async listGuildMembers(
    guildId: string,
    options: { readonly token?: string; readonly limit?: number; readonly after?: string } = {},
  ): Promise<Array<Record<string, unknown>>> {
    this.validateSnowflake(guildId, 'guildId');
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.min(1000, options.limit ?? 100))),
    });
    if (options.after) params.set('after', options.after);
    return this.apiFetch<Array<Record<string, unknown>>>(`/guilds/${guildId}/members?${params.toString()}`, {
      token: options.token ?? this.botToken,
    });
  }

  async registerGlobalCommand(
    applicationId: string,
    command: DiscordApplicationCommand,
    token = this.botToken,
  ): Promise<DiscordApplicationCommand> {
    this.validateSnowflake(applicationId, 'applicationId');
    return this.apiFetch<DiscordApplicationCommand>(`/applications/${applicationId}/commands`, {
      method: 'POST',
      token,
      body: command,
    });
  }

  async registerGuildCommand(
    applicationId: string,
    guildId: string,
    command: DiscordApplicationCommand,
    token = this.botToken,
  ): Promise<DiscordApplicationCommand> {
    this.validateSnowflake(applicationId, 'applicationId');
    this.validateSnowflake(guildId, 'guildId');
    return this.apiFetch<DiscordApplicationCommand>(`/applications/${applicationId}/guilds/${guildId}/commands`, {
      method: 'POST',
      token,
      body: command,
    });
  }

  async bulkOverwriteGuildCommands(
    applicationId: string,
    guildId: string,
    commands: readonly DiscordApplicationCommand[],
    token = this.botToken,
  ): Promise<DiscordApplicationCommand[]> {
    this.validateSnowflake(applicationId, 'applicationId');
    this.validateSnowflake(guildId, 'guildId');
    return this.apiFetch<DiscordApplicationCommand[]>(`/applications/${applicationId}/guilds/${guildId}/commands`, {
      method: 'PUT',
      token,
      body: commands,
    });
  }

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
        error: summarizeError(err),
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

  private async apiFetch<T>(
    path: string,
    options: {
      readonly method?: string;
      readonly token?: string;
      readonly body?: unknown;
    } = {},
  ): Promise<T> {
    const token = options.token ?? this.botToken;
    if (!token) {
      throw new Error(`DiscordIntegration: botToken is required for ${path}`);
    }
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bot ${token}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`DiscordIntegration.apiFetch ${path} failed (${res.status}): ${err}`);
    }
    return await res.json() as T;
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

export class DiscordGatewayClient {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private started = false;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(private readonly options: DiscordGatewayClientOptions) {
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  async start(): Promise<DiscordGatewayBotResponse> {
    if (this.started && this.socket) {
      return {
        url: this.options.gatewayUrl ?? '',
        shards: 1,
      };
    }
    const gateway = this.options.gatewayUrl
      ? { url: this.options.gatewayUrl, shards: 1 }
      : await this.options.integration.getGatewayBot(this.options.token);
    const url = `${gateway.url.replace(/\/+$/, '')}/?v=10&encoding=json`;
    const socket = new this.WebSocketImpl(url);
    this.socket = socket;
    this.started = true;
    socket.addEventListener('message', (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => this.cleanup());
    return gateway;
  }

  stop(): void {
    this.cleanup();
    this.socket?.close();
    this.socket = null;
  }

  send(op: number, d: unknown): void {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return;
    this.socket.send(JSON.stringify({ op, d }));
  }

  get isStarted(): boolean {
    return this.started;
  }

  private async handleMessage(data: unknown): Promise<void> {
    const raw = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf-8') : String(data);
    let dispatch: DiscordGatewayDispatch;
    try {
      dispatch = JSON.parse(raw) as DiscordGatewayDispatch;
    } catch (error) {
      logger.warn('DiscordGatewayClient: invalid gateway payload', {
        error: summarizeError(error),
      });
      return;
    }
    if (typeof dispatch.s === 'number') this.sequence = dispatch.s;
    if (dispatch.op === DiscordGatewayOpcode.Hello) {
      const hello = dispatch.d ?? {};
      const interval = typeof hello.heartbeat_interval === 'number' ? hello.heartbeat_interval : 45_000;
      this.startHeartbeat(interval);
      this.identify();
      return;
    }
    if (dispatch.op === DiscordGatewayOpcode.Dispatch) {
      await this.options.onDispatch(dispatch, this);
    }
  }

  private identify(): void {
    this.send(DiscordGatewayOpcode.Identify, {
      token: this.options.token,
      intents: this.options.intents
        ?? (DiscordGatewayIntent.Guilds | DiscordGatewayIntent.GuildMessages | DiscordGatewayIntent.DirectMessages | DiscordGatewayIntent.MessageContent),
      properties: {
        os: process.platform,
        browser: 'goodvibes-tui',
        device: 'goodvibes-tui',
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      this.send(DiscordGatewayOpcode.Heartbeat, this.sequence);
    }, intervalMs);
    this.send(DiscordGatewayOpcode.Heartbeat, this.sequence);
  }

  private cleanup(): void {
    this.started = false;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
