import { timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger.ts';
import { VERSION } from '../version.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { ConfigManager } from '../config/manager.ts';
import type { ConfigKey } from '../config/schema.ts';
import { isValidConfigKey } from '../config/schema.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import { UserAuthManager } from '../security/user-auth.ts';
import { TaskScheduler } from '../scheduler/scheduler.ts';
import { SlackIntegration, DiscordIntegration, DiscordInteractionResponseType, DiscordInteractionType } from '../integrations/index.ts';
import { GitHubIntegration } from '../integrations/github.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DaemonConfig {
  port?: number;
  host?: string;
  agentManager?: AgentManager;
  /** HMAC-SHA256 secret for verifying GitHub webhook signatures. Falls back to GITHUB_WEBHOOK_SECRET env var. */
  githubWebhookSecret?: string;
  /** Optional pre-configured UserAuthManager (for testing). */
  userAuth?: UserAuthManager;
}

interface DaemonDangerConfig {
  daemon: boolean;
}

type JsonBody = Record<string, unknown>;
type ScheduleRecord = ReturnType<TaskScheduler['list']>[number];

// ---------------------------------------------------------------------------
// DaemonServer
// ---------------------------------------------------------------------------

/**
 * DaemonServer — HTTP task server, disabled by default.
 *
 * Enable via: danger.daemon = true in config.
 * All routes require Bearer token auth (set via enable()).
 * POST /task    — submit a task; returns agentId.
 * GET  /task/:id — returns agent status.
 * GET  /status  — server health check.
 */
export class DaemonServer {
  private enabled = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private host: string;
  private agentManager: AgentManager;
  private configManager: ConfigManager;
  private authToken: string | null = null;
  private userAuth: UserAuthManager;
  private githubWebhookSecret: string | null;
  private scheduler: TaskScheduler;

  constructor(private config: DaemonConfig = {}, _configManager?: ConfigManager) {
    this.port = config.port ?? 3421;
    this.host = config.host ?? '127.0.0.1';
    this.agentManager = config.agentManager ?? AgentManager.getInstance();
    this.configManager = _configManager ?? new ConfigManager();
    this.userAuth = config.userAuth ?? new UserAuthManager();
    // Webhook secrets follow 12-factor app conventions (https://12factor.net/config):
    // prefer explicit config object values (e.g. from a vault-injected object) and
    // fall back to environment variables so the binary works in any deployment
    // without code changes. Secrets are never logged or exposed via the API.
    this.githubWebhookSecret =
      config.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? null;
    this.scheduler = TaskScheduler.getInstance();
  }

  /**
   * Enable the daemon. Requires danger.daemon = true in config.
   * The provided token is used to authenticate all incoming requests.
   * Returns true if enabled, false if the config forbids it.
   */
  enable(dangerConfig: DaemonDangerConfig, token?: string): boolean {
    if (!dangerConfig.daemon) {
      logger.info('DaemonServer.enable: danger.daemon is false — not enabling');
      return false;
    }
    this.enabled = true;
    this.authToken = token ?? null;
    return true;
  }

  /**
   * Start the daemon. Refuses to start if not explicitly enabled.
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info('Daemon mode is disabled. Enable via danger.daemon config.');
      return;
    }
    if (this.authToken === null) {
      logger.error('DaemonServer: starting without auth token — requests require session-based authentication via UserAuth');
    }
    if (this.server !== null) {
      logger.info('DaemonServer: already running');
      return;
    }

    const self = this;
    this.server = Bun.serve({
      port: this.port,
      hostname: this.host,
      async fetch(req: Request): Promise<Response> {
        return self.handleRequest(req);
      },
    });

    await this.scheduler.start();
    logger.info('DaemonServer started', { port: this.port, host: this.host });
  }

  /**
   * Stop the daemon server.
   */
  async stop(): Promise<void> {
    if (this.server === null) return;
    this.scheduler.stop();
    this.server.stop(true);
    this.server = null;
    logger.info('DaemonServer stopped');
  }

  /**
   * Returns true if the server is currently running.
   */
  get isRunning(): boolean {
    return this.server !== null;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private checkAuth(req: Request): boolean {
    const bearer = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';

    if (this.authToken) {
      if (bearer.length !== this.authToken.length) return false;
      return timingSafeEqual(Buffer.from(bearer), Buffer.from(this.authToken));
    }

    if (!bearer) return false;
    return this.userAuth.validateSession(bearer) !== null;
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/login' && req.method === 'POST') {
      return this.handleLogin(req);
    }

    if (url.pathname === '/webhook/slack' && req.method === 'POST') {
      return this.handleSlackWebhook(req);
    }
    if (url.pathname === '/webhook/discord' && req.method === 'POST') {
      return this.handleDiscordWebhook(req);
    }
    if (url.pathname === '/webhook/github' && req.method === 'POST') {
      return this.handleGitHubWebhook(req);
    }

    if (!this.checkAuth(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { pathname, method } = { pathname: url.pathname, method: req.method };

    if (pathname === '/status' && method === 'GET') {
      // health check
      return Response.json({ status: 'running', version: VERSION });
    }
    if (pathname === '/config' && method === 'GET') {
      // return full config snapshot
      const cfg = this.configManager.getAll();
      return Response.json(cfg);
    }
    if (pathname === '/config' && method === 'POST') {
      // set config key/value
      let payload: { key?: string; value?: unknown };
      try {
        payload = await req.json() as { key?: string; value?: unknown };
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      const { key, value } = payload;
      if (!key || typeof key !== 'string') {
        return Response.json({ error: 'Missing or invalid key' }, { status: 400 });
      }
      if (!isValidConfigKey(key)) {
        return Response.json({ error: 'Invalid config key' }, { status: 400 });
      }
      try {
        this.configManager.setDynamic(key as ConfigKey, value);
      } catch (e: unknown) {
        return Response.json({ error: e instanceof Error ? e.message : 'Failed to set config' }, { status: 400 });
      }
      return Response.json({ success: true, key, value });
    }

    if (pathname === '/task' && method === 'POST') {
      return this.handlePostTask(req);
    }

    // GET /task/:id
    const taskStatusMatch = pathname.match(/^\/task\/([^/]+)$/);
    if (taskStatusMatch && method === 'GET') {
      return this.handleGetTaskStatus(taskStatusMatch[1]);
    }

    // --- Schedules API ---
    if (pathname === '/schedules' && method === 'GET') {
      return this.handleGetSchedules();
    }
    if (pathname === '/schedules' && method === 'POST') {
      return this.handlePostSchedule(req);
    }
    const scheduleIdMatch = pathname.match(/^\/schedules\/([^/]+)$/);
    if (scheduleIdMatch && method === 'DELETE') {
      return this.handleDeleteSchedule(scheduleIdMatch[1]);
    }
    const scheduleActionMatch = pathname.match(/^\/schedules\/([^/]+)\/(enable|disable|run)$/);
    if (scheduleActionMatch && method === 'POST') {
      const [, schedId, action] = scheduleActionMatch;
      if (action === 'run') return this.handleRunScheduleNow(schedId);
      return this.handleSetScheduleEnabled(schedId, action === 'enable');
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  private async handleLogin(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = this.userAuth.authenticate(username, password);

    if (!user) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const session = this.userAuth.createSession(user.username);
    return Response.json({
      authenticated: true,
      token: session.token,
      username: session.username,
      expiresAt: session.expiresAt,
    });
  }

  private async handlePostTask(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const task = body.task;
    if (!task || typeof task !== 'string' || task.trim() === '') {
      return Response.json({ error: 'Missing required field: task (non-empty string)' }, { status: 400 });
    }

    const model = typeof body.model === 'string' ? body.model : undefined;
    const tools = Array.isArray(body.tools)
      ? (body.tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    const spawnResult = this.trySpawnAgent({
      mode: 'spawn',
      task,
      ...(model !== undefined && { model }),
      ...(tools !== undefined && { tools }),
    });
    if (spawnResult instanceof Response) return spawnResult;
    const record = spawnResult;

    return Response.json(
      {
        acknowledged: true,
        agentId: record.id,
        status: record.status,
        task: record.task,
        model: record.model ?? null,
        tools: record.tools,
      },
      { status: 202 },
    );
  }

  // -------------------------------------------------------------------------
  // GitHub webhook handler
  // -------------------------------------------------------------------------

  private async handleGitHubWebhook(req: Request): Promise<Response> {
    const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
    if (contentLength > 1_000_000) {
      return Response.json({ error: 'Payload too large' }, { status: 413 });
    }

    // Read raw body as text for HMAC verification
    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return Response.json({ error: 'Failed to read request body' }, { status: 400 });
    }

    // Reject if no secret is configured
    if (!this.githubWebhookSecret) {
      logger.warn('DaemonServer: GITHUB_WEBHOOK_SECRET not configured — rejecting');
      return Response.json({ error: 'Webhook not configured' }, { status: 503 });
    }

    // Verify HMAC signature
    const signature = req.headers.get('x-hub-signature-256') ?? '';
    if (!signature) {
      return Response.json({ error: 'Missing X-Hub-Signature-256 header' }, { status: 401 });
    }
    if (!GitHubIntegration.verifySignature(rawBody, signature, this.githubWebhookSecret)) {
      logger.warn('DaemonServer: GitHub webhook signature verification failed');
      return Response.json({ error: 'Invalid webhook signature' }, { status: 401 });
    }

    // Parse JSON body
    const body = this.parseJsonText(rawBody);
    if (body instanceof Response) return body;

    // Parse the GitHub event
    const event = GitHubIntegration.parseEvent(req.headers, body);

    // Convert event to agent prompt
    const prompt = GitHubIntegration.eventToPrompt(event);
    if (prompt === null) {
      logger.info('DaemonServer: GitHub webhook event ignored (no prompt generated)', {
        type: event.type,
        action: event.action,
      });
      return Response.json({ acknowledged: true, queued: false, reason: 'Event not actionable' });
    }

    // Spawn agent asynchronously — return 200 immediately
    let agentId: string | null = null;
    const spawnResult = this.trySpawnAgent({ mode: 'spawn', task: prompt });
    if (spawnResult instanceof Response) return spawnResult;
    try {
      agentId = spawnResult.id;
      logger.info('DaemonServer: GitHub webhook spawned agent', {
        type: event.type,
        action: event.action,
        agentId,
      });
    } catch {}

    return Response.json({
      acknowledged: true,
      queued: true,
      agentId,
      eventType: event.type,
      action: event.action,
    });
  }

  // -------------------------------------------------------------------------
  // Webhook handlers
  // -------------------------------------------------------------------------

  private async handleSlackWebhook(req: Request): Promise<Response> {
    const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
    if (contentLength > 1_000_000) {
      return Response.json({ error: 'Payload too large' }, { status: 413 });
    }

    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      logger.warn('DaemonServer.handleSlackWebhook: SLACK_SIGNING_SECRET not set — rejecting');
      return Response.json({ error: 'Webhook not configured' }, { status: 503 });
    }

    const timestamp = req.headers.get('x-slack-request-timestamp') ?? '';
    const signature = req.headers.get('x-slack-signature') ?? '';
    const rawBody = await req.text();

    const slack = new SlackIntegration(
      process.env.SLACK_WEBHOOK_URL,
      process.env.SLACK_BOT_TOKEN,
    );

    if (!slack.verifySignature(rawBody, timestamp, signature, signingSecret)) {
      logger.warn('DaemonServer.handleSlackWebhook: invalid signature');
      return Response.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // Parse body — could be form-encoded or JSON
    let bodyRecord: Record<string, unknown>;
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        bodyRecord = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
    } else {
      // application/x-www-form-urlencoded
      bodyRecord = Object.fromEntries(new URLSearchParams(rawBody));
    }

    // Handle Slack URL verification challenge
    if (bodyRecord.type === 'url_verification') {
      return Response.json({ challenge: bodyRecord.challenge });
    }

    const event = slack.parseEvent(bodyRecord);

    if (event.type === 'slash_command') {
      const task = event.text.trim();
      if (!task) {
        return Response.json({
          response_type: 'ephemeral',
          text: 'Usage: `/goodvibes <your prompt>`',
        });
      }

      // Spawn agent async — respond immediately within Slack's 3-second window
      let responseUrl: string | undefined = event.responseUrl;
      if (responseUrl && !responseUrl.startsWith('https://hooks.slack.com/')) {
        logger.warn('DaemonServer.handleSlackWebhook: suspicious responseUrl, ignoring');
        responseUrl = undefined;
      }
      setImmediate(async () => {
        const spawnResult = this.trySpawnAgent({ mode: 'spawn', task }, 'DaemonServer.handleSlackWebhook');
        if (spawnResult instanceof Response) {
          const payload = await spawnResult.json() as { error?: string };
          const msg = payload.error ?? 'Agent spawn failed';
          logger.error('DaemonServer.handleSlackWebhook: spawn failed', { error: msg });
          if (responseUrl) {
            await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                response_type: 'in_channel',
                text: `Agent spawn failed: ${msg}`,
              }),
            }).catch(() => {});
          }
          return;
        }
        const record = spawnResult;
        if (responseUrl && record) {
          await fetch(responseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              response_type: 'in_channel',
              blocks: slack.formatAgentResult(record.id, task, `Agent spawned (id: ${record.id}). Result will be available via \`/task/${record.id}\`.`),
            }),
          }).catch((e: unknown) => {
            logger.warn('DaemonServer.handleSlackWebhook: follow-up post failed', {
              error: e instanceof Error ? e.message : String(e),
            });
          });
        }
      });

      return Response.json({
        response_type: 'in_channel',
        text: `Running: _${task}_`,
      });
    }

    // Interaction payload — acknowledge immediately
    return new Response(null, { status: 200 });
  }

  private async handleDiscordWebhook(req: Request): Promise<Response> {
    const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
    if (contentLength > 1_000_000) {
      return Response.json({ error: 'Payload too large' }, { status: 413 });
    }

    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
      logger.warn('DaemonServer.handleDiscordWebhook: DISCORD_PUBLIC_KEY not set — rejecting');
      return Response.json({ error: 'Webhook not configured' }, { status: 503 });
    }

    const signature = req.headers.get('x-signature-ed25519') ?? '';
    const timestamp = req.headers.get('x-signature-timestamp') ?? '';
    const rawBody = await req.text();

    const discord = new DiscordIntegration(
      process.env.DISCORD_WEBHOOK_URL,
      process.env.DISCORD_BOT_TOKEN,
    );

    const valid = await discord.verifySignature(rawBody, signature, timestamp, publicKey);
    if (!valid) {
      logger.warn('DaemonServer.handleDiscordWebhook: invalid Ed25519 signature');
      return new Response('Invalid request signature', { status: 401 });
    }

    let bodyRecord: Record<string, unknown>;
    try {
      bodyRecord = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }

    const interaction = discord.parseInteraction(bodyRecord);

    // PING — Discord sends this to verify the endpoint
    if (interaction.type === DiscordInteractionType.Ping) {
      return Response.json({ type: DiscordInteractionResponseType.Pong });
    }

    // Application command (slash command)
    if (interaction.type === DiscordInteractionType.ApplicationCommand) {
      // Respond with deferred message immediately
      const deferredResponse = Response.json({
        type: DiscordInteractionResponseType.DeferredChannelMessageWithSource,
      });

      // Extract prompt from the first option value or fall back to command name
      const promptOption = interaction.commandOptions?.find((o) => o.name === 'prompt');
      const task =
        typeof promptOption?.value === 'string' ? promptOption.value.trim() : '';

      if (!task) {
        return deferredResponse;
      }

      const appId = interaction.applicationId;
      const token = interaction.token;

      setImmediate(async () => {
        const spawnResult = this.trySpawnAgent({ mode: 'spawn', task }, 'DaemonServer.handleDiscordWebhook');
        if (spawnResult instanceof Response) {
          const payload = await spawnResult.json() as { error?: string };
          const msg = payload.error ?? 'Agent spawn failed';
          logger.error('DaemonServer.handleDiscordWebhook: spawn failed', { error: msg });
          await discord
            .editOriginalResponse(appId, token, `Agent spawn failed: ${msg}`)
            .catch(() => {});
          return;
        }
        const record = spawnResult;
        if (record) {
          const embed = discord.formatAgentResult(
            record.id,
            task,
            `Agent spawned. Result will be available via \`/task/${record.id}\`.`,
          );
          await discord
            .editOriginalResponse(appId, token, '', [embed])
            .catch((e: unknown) => {
              logger.warn('DaemonServer.handleDiscordWebhook: follow-up failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            });
        }
      });

      return deferredResponse;
    }

    // Unknown interaction type — acknowledge
    return Response.json({ type: DiscordInteractionResponseType.DeferredUpdateMessage });
  }

  private handleGetTaskStatus(agentId: string): Response {
    const record = this.agentManager.getStatus(agentId);
    if (!record) {
      return Response.json({ error: `Agent not found: ${agentId}` }, { status: 404 });
    }

    const durationMs =
      record.completedAt !== undefined
        ? record.completedAt - record.startedAt
        : Date.now() - record.startedAt;

    return Response.json({
      agentId: record.id,
      task: record.task,
      status: record.status,
      model: record.model ?? null,
      tools: record.tools,
      durationMs,
      toolCallCount: record.toolCallCount,
      progress: record.progress ?? null,
      error: record.error ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Schedule handlers
  // -------------------------------------------------------------------------

  private handleGetSchedules(): Response {
    const tasks = this.scheduler.list();
    return Response.json({ tasks });
  }

  private async handlePostSchedule(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const cron = typeof body.cron === 'string' ? body.cron : undefined;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : undefined;
    if (!cron || !prompt) {
      return Response.json({ error: 'Missing required fields: cron (string), prompt (string)' }, { status: 400 });
    }

    // Validate prompt length (injection / DoS mitigation)
    if (prompt.length > 10_000) {
      return Response.json({ error: 'prompt exceeds maximum length of 10000 characters' }, { status: 400 });
    }

    // Validate cron expression is parseable before passing to scheduler
    try {
      this.scheduler.getNextRun(cron);
    } catch {
      return Response.json({ error: 'Invalid cron expression' }, { status: 400 });
    }

    const name = typeof body.name === 'string' ? body.name : prompt.slice(0, 40);
    const model = typeof body.model === 'string' ? body.model : undefined;
    const template = typeof body.template === 'string' ? body.template : undefined;
    const enabled = body.enabled !== false; // default true

    try {
      const task = this.scheduler.add({ name, cron, prompt, model, template, enabled });
      return Response.json(task, { status: 201 });
    } catch (e: unknown) {
      return Response.json({ error: e instanceof Error ? e.message : 'Failed to create schedule' }, { status: 400 });
    }
  }

  private handleDeleteSchedule(id: string): Response {
    const task = this.findSchedule(id);
    if (!task) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
    this.scheduler.remove(task.id);
    return Response.json({ removed: true, id: task.id });
  }

  private handleSetScheduleEnabled(id: string, enabled: boolean): Response {
    const task = this.findSchedule(id);
    if (!task) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
    this.scheduler.setEnabled(task.id, enabled);
    const updated = this.scheduler.list().find((t) => t.id === task.id);
    return Response.json(updated ?? { id: task.id, enabled });
  }

  private async handleRunScheduleNow(id: string): Promise<Response> {
    const task = this.findSchedule(id);
    if (!task) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
    try {
      const agentId = await this.scheduler.runNow(task.id);
      return Response.json({ taskId: task.id, agentId, status: 'running' });
    } catch (e: unknown) {
      return Response.json({ error: e instanceof Error ? e.message : 'Failed to run schedule' }, { status: 500 });
    }
  }

  private async parseJsonBody(req: Request): Promise<JsonBody | Response> {
    try {
      return await req.json() as JsonBody;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  private parseJsonText(rawBody: string): JsonBody | Response {
    try {
      return JSON.parse(rawBody) as JsonBody;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  private trySpawnAgent(
    input: Parameters<AgentManager['spawn']>[0],
    logLabel = 'DaemonServer',
  ): AgentRecord | Response {
    try {
      return this.agentManager.spawn(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`${logLabel}: agent spawn failed`, { error: message });
      return Response.json({ error: `Failed to spawn agent: ${message}` }, { status: 500 });
    }
  }

  private findSchedule(id: string): ScheduleRecord | undefined {
    return this.scheduler.list().find((task) => task.id === id || task.id.startsWith(id));
  }
}
