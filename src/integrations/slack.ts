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

export interface SlackEventCallback {
  type: 'event_callback';
  eventType: string;
  text: string;
  userId: string;
  channelId: string;
  teamId: string;
  threadTs?: string;
  eventTs?: string;
  raw: Record<string, unknown>;
}

export type SlackEvent = SlackSlashCommand | SlackInteraction | SlackEventCallback;

export interface SlackOAuthAuthorizeOptions {
  readonly clientId: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly userScopes?: readonly string[];
  readonly state?: string;
  readonly teamId?: string;
}

export interface SlackOAuthExchangeOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri?: string;
}

export interface SlackOAuthExchangeResult {
  readonly ok: boolean;
  readonly access_token?: string;
  readonly bot_user_id?: string;
  readonly app_id?: string;
  readonly team?: { readonly id?: string; readonly name?: string };
  readonly authed_user?: Record<string, unknown>;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface SlackAuthTestResult {
  readonly ok: boolean;
  readonly url?: string;
  readonly team?: string;
  readonly user?: string;
  readonly team_id?: string;
  readonly user_id?: string;
  readonly bot_id?: string;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface SlackSocketModeConnection {
  readonly ok: boolean;
  readonly url?: string;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface SlackConversationRecord {
  readonly id: string;
  readonly name?: string;
  readonly is_channel?: boolean;
  readonly is_group?: boolean;
  readonly is_im?: boolean;
  readonly is_mpim?: boolean;
  readonly is_archived?: boolean;
  readonly num_members?: number;
  readonly [key: string]: unknown;
}

export interface SlackUserRecord {
  readonly id: string;
  readonly name?: string;
  readonly real_name?: string;
  readonly is_bot?: boolean;
  readonly deleted?: boolean;
  readonly profile?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface SlackCursorPage<T> {
  readonly ok: boolean;
  readonly entries: readonly T[];
  readonly nextCursor: string;
  readonly error?: string;
}

export interface SlackSocketModeEnvelope {
  readonly envelope_id?: string;
  readonly type?: string;
  readonly accepts_response_payload?: boolean;
  readonly payload?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface SlackSocketModeClientOptions {
  readonly appToken: string;
  readonly integration: SlackIntegration;
  readonly onEnvelope: (envelope: SlackSocketModeEnvelope, client: SlackSocketModeClient) => void | Promise<void>;
  readonly WebSocketImpl?: typeof WebSocket;
}

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

  static buildOAuthAuthorizeUrl(options: SlackOAuthAuthorizeOptions): string {
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', options.clientId);
    const scopes = options.scopes?.length ? options.scopes : ['commands', 'chat:write'];
    url.searchParams.set('scope', scopes.join(','));
    if (options.userScopes?.length) url.searchParams.set('user_scope', options.userScopes.join(','));
    if (options.redirectUri) url.searchParams.set('redirect_uri', options.redirectUri);
    if (options.state) url.searchParams.set('state', options.state);
    if (options.teamId) url.searchParams.set('team', options.teamId);
    return url.toString();
  }

  async authTest(token = this.botToken): Promise<SlackAuthTestResult> {
    return this.callApi<SlackAuthTestResult>('auth.test', {}, token);
  }

  async appsConnectionsOpen(appToken: string): Promise<SlackSocketModeConnection> {
    return this.callApi<SlackSocketModeConnection>('apps.connections.open', {}, appToken);
  }

  async exchangeOAuthCode(options: SlackOAuthExchangeOptions): Promise<SlackOAuthExchangeResult> {
    const body = new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
    });
    if (options.redirectUri) body.set('redirect_uri', options.redirectUri);
    const res = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`SlackIntegration.exchangeOAuthCode failed (${res.status}): ${err}`);
    }
    return await res.json() as SlackOAuthExchangeResult;
  }

  async listConversations(options: {
    readonly token?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly types?: readonly string[];
    readonly excludeArchived?: boolean;
    readonly teamId?: string;
  } = {}): Promise<SlackCursorPage<SlackConversationRecord>> {
    const data = await this.callApi<{
      ok: boolean;
      channels?: SlackConversationRecord[];
      response_metadata?: { next_cursor?: string };
      error?: string;
    }>('conversations.list', {
      limit: String(Math.max(1, Math.min(1000, options.limit ?? 200))),
      types: (options.types?.length ? options.types : ['public_channel', 'private_channel', 'mpim', 'im']).join(','),
      exclude_archived: options.excludeArchived === false ? 'false' : 'true',
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.teamId ? { team_id: options.teamId } : {}),
    }, options.token ?? this.botToken);
    return {
      ok: data.ok,
      entries: data.channels ?? [],
      nextCursor: data.response_metadata?.next_cursor ?? '',
      ...(data.error ? { error: data.error } : {}),
    };
  }

  async listUsers(options: {
    readonly token?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly teamId?: string;
  } = {}): Promise<SlackCursorPage<SlackUserRecord>> {
    const data = await this.callApi<{
      ok: boolean;
      members?: SlackUserRecord[];
      response_metadata?: { next_cursor?: string };
      error?: string;
    }>('users.list', {
      limit: String(Math.max(1, Math.min(1000, options.limit ?? 200))),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.teamId ? { team_id: options.teamId } : {}),
    }, options.token ?? this.botToken);
    return {
      ok: data.ok,
      entries: data.members ?? [],
      nextCursor: data.response_metadata?.next_cursor ?? '',
      ...(data.error ? { error: data.error } : {}),
    };
  }

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
    if (typeof body.payload === 'string' || (typeof body.payload === 'object' && body.payload !== null)) {
      let parsed: Record<string, unknown>;
      if (typeof body.payload === 'string') {
        try {
          parsed = JSON.parse(body.payload) as Record<string, unknown>;
        } catch {
          parsed = body;
        }
      } else {
        parsed = body.payload as Record<string, unknown>;
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

    const eventPayload = (body.event ?? null) as Record<string, unknown> | null;
    if (body.type === 'event_callback' && eventPayload && typeof eventPayload === 'object') {
      return {
        type: 'event_callback',
        eventType: typeof eventPayload.type === 'string' ? eventPayload.type : 'unknown',
        text: typeof eventPayload.text === 'string' ? eventPayload.text : '',
        userId: typeof eventPayload.user === 'string' ? eventPayload.user : '',
        channelId: typeof eventPayload.channel === 'string' ? eventPayload.channel : '',
        teamId: typeof body.team_id === 'string' ? body.team_id : '',
        threadTs: typeof eventPayload.thread_ts === 'string' ? eventPayload.thread_ts : undefined,
        eventTs: typeof eventPayload.ts === 'string' ? eventPayload.ts : undefined,
        raw: body,
      };
    }

    if (typeof body.type === 'string' && (body.type === 'block_actions' || body.type === 'message_action' || body.type === 'view_submission')) {
      const user = (body.user ?? {}) as Record<string, unknown>;
      const channel = (body.channel ?? {}) as Record<string, unknown>;
      return {
        type: 'interaction',
        interactionType: body.type,
        payload: body,
        userId: typeof user.id === 'string' ? user.id : '',
        channelId: typeof channel.id === 'string' ? channel.id : '',
        responseUrl: typeof body.response_url === 'string' ? body.response_url : undefined,
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

  private async callApi<T extends { ok?: boolean; error?: string }>(
    method: string,
    params: Record<string, string> = {},
    token = this.botToken,
  ): Promise<T> {
    if (!token) {
      throw new Error(`SlackIntegration: token is required for ${method}`);
    }
    const body = new URLSearchParams(params);
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`SlackIntegration.${method} failed (${res.status}): ${err}`);
    }
    return await res.json() as T;
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

export class SlackSocketModeClient {
  private socket: WebSocket | null = null;
  private started = false;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(private readonly options: SlackSocketModeClientOptions) {
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  async start(): Promise<SlackSocketModeConnection> {
    if (this.started) {
      return { ok: true, url: undefined };
    }
    const connection = await this.options.integration.appsConnectionsOpen(this.options.appToken);
    if (!connection.ok || !connection.url) {
      return connection;
    }
    this.started = true;
    const socket = new this.WebSocketImpl(connection.url);
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      this.started = false;
      this.socket = null;
    });
    return connection;
  }

  stop(): void {
    this.started = false;
    this.socket?.close();
    this.socket = null;
  }

  ack(envelopeId: string, payload?: Record<string, unknown>): void {
    this.send({
      envelope_id: envelopeId,
      ...(payload ? { payload } : {}),
    });
  }

  send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  get isStarted(): boolean {
    return this.started;
  }

  private async handleMessage(data: unknown): Promise<void> {
    const raw = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf-8') : String(data);
    let envelope: SlackSocketModeEnvelope;
    try {
      envelope = JSON.parse(raw) as SlackSocketModeEnvelope;
    } catch (error) {
      logger.warn('SlackSocketModeClient: invalid JSON envelope', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (envelope.envelope_id) {
      this.ack(envelope.envelope_id);
    }
    await this.options.onEnvelope(envelope, this);
  }
}
