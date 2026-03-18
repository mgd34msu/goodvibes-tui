import { timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger.ts';
import { VERSION } from '../version.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { ConfigManager } from '../config/manager.ts';
import type { ConfigKey } from '../config/schema.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import { UserAuthManager } from '../security/user-auth.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DaemonConfig {
  port?: number;
  host?: string;
  agentManager?: AgentManager;
}

interface DaemonDangerConfig {
  daemon: boolean;
}

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

  constructor(private config: DaemonConfig = {}, _configManager?: ConfigManager) {
    this.port = config.port ?? 3421;
    this.host = config.host ?? '127.0.0.1';
    this.agentManager = config.agentManager ?? AgentManager.getInstance();
    this.configManager = _configManager ?? new ConfigManager();
    this.userAuth = new UserAuthManager();
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
      logger.error('DaemonServer: starting without auth token — all requests accepted');
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

    logger.info('DaemonServer started', { port: this.port, host: this.host });
  }

  /**
   * Stop the daemon server.
   */
  async stop(): Promise<void> {
    if (this.server === null) return;
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

    if (!bearer) return true;
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

    if (!this.checkAuth(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { pathname, method } = { pathname: url.pathname, method: req.method };

    if (pathname === '/status' && method === 'GET') {
      // health check
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

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  private async handleLogin(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

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
    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Accept both 'task' and 'prompt' field names for compatibility
    const task = body.task ?? body.prompt;
    if (!task || typeof task !== 'string' || task.trim() === '') {
      return Response.json({ error: 'Missing required field: task (non-empty string)' }, { status: 400 });
    }

    const model = typeof body.model === 'string' ? body.model : undefined;
    const tools = Array.isArray(body.tools)
      ? (body.tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    let record: AgentRecord;
    try {
      record = this.agentManager.spawn({
        mode: 'spawn',
        task,
        ...(model !== undefined && { model }),
        ...(tools !== undefined && { tools }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('DaemonServer: agent spawn failed', { error: message });
      return Response.json({ error: `Failed to spawn agent: ${message}` }, { status: 500 });
    }

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
}
