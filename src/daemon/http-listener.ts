import { timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger.ts';
import { HookDispatcher } from '../hooks/dispatcher.ts';
import type { HookEvent } from '../hooks/types.ts';
import { buildOperatorSessionCookie, extractOperatorAuthToken } from '../security/http-auth.ts';
import { UserAuthManager } from '../security/user-auth.ts';
import { ConfigManager } from '../config/manager.ts';
import { extractForwardedClientIp, resolveInboundTlsContext, type ResolvedInboundTlsContext } from '../runtime/network/index.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HttpListenerConfig {
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  hookDispatcher?: HookDispatcher;
  configManager: ConfigManager;
  serveFactory?: typeof Bun.serve;
  /** Max requests per 60-second window per IP. Default: 60. */
  rateLimit?: number;
  /** Pre-configured UserAuthManager owned by the runtime service graph. */
  userAuth: UserAuthManager;
}

interface HttpDangerConfig {
  httpListener: boolean;
}

// ---------------------------------------------------------------------------
// Rate limiter (sliding window per IP, in-memory)
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;

class RateLimiter {
  private counts = new Map<string, number[]>();

  constructor(private limit: number) {}

  /** Returns true if the request is allowed, false if rate-limited. */
  check(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;
    const hits = (this.counts.get(ip) ?? []).filter((t) => t > windowStart);
    hits.push(now);
    this.counts.set(ip, hits);
    return hits.length <= this.limit;
  }
}

// ---------------------------------------------------------------------------
// HttpListener
// ---------------------------------------------------------------------------

/**
 * HttpListener — webhook listener, disabled by default.
 *
 * Enable via: danger.httpListener = true in config.
 * All routes require Bearer token auth (set via enable()).
 * POST /webhook — parse hook event, fire through HookDispatcher.
 * GET  /health  — liveness check.
 * Rate limited to 60 requests/minute per IP by default.
 */
export class HttpListener {
  private enabled = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private host: string;
  private allowedOrigins: string[];
  private hookDispatcher: HookDispatcher | null;
  private authToken: string | null = null;
  private userAuth: UserAuthManager;
  private rateLimiter: RateLimiter;
  private readonly configManager: ConfigManager;
  private readonly serveFactory: typeof Bun.serve;
  private tlsState: ResolvedInboundTlsContext | null = null;

  constructor(private config: HttpListenerConfig) {
    this.configManager = config.configManager;
    this.port = config.port ?? Number(this.configManager.get('httpListener.port') ?? 3422);
    this.host = config.host ?? String(this.configManager.get('httpListener.host') ?? '127.0.0.1');
    this.allowedOrigins = config.allowedOrigins ?? [];
    this.hookDispatcher = config.hookDispatcher ?? null;
    this.userAuth = config.userAuth;
    this.rateLimiter = new RateLimiter(config.rateLimit ?? 60);
    this.serveFactory = config.serveFactory ?? Bun.serve;
  }

  /**
   * Enable the listener. Requires danger.httpListener = true in config.
   * The provided token is used to authenticate all incoming requests.
   * Returns true if enabled, false if the config forbids it.
   */
  enable(dangerConfig: HttpDangerConfig, token?: string): boolean {
    if (!dangerConfig.httpListener) {
      logger.info('HttpListener.enable: danger.httpListener is false — not enabling');
      return false;
    }
    this.enabled = true;
    this.authToken = token ?? null;
    return true;
  }

  /**
   * Start listening. Refuses to start if not enabled.
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info('HTTP listener is disabled. Enable via danger.httpListener config.');
      return;
    }
    if (this.authToken === null) {
      logger.info('HttpListener: starting with session-based authentication via UserAuth');
    }
    if (this.server !== null) {
      logger.info('HttpListener: already running');
      return;
    }

    const self = this;
    this.tlsState = resolveInboundTlsContext(this.configManager, 'httpListener');
    this.server = this.serveFactory({
      port: this.port,
      hostname: this.host,
      ...(this.tlsState.tls ? { tls: this.tlsState.tls } : {}),
      async fetch(req: Request): Promise<Response> {
        return self.handleRequest(req);
      },
    });

    logger.info('HttpListener started', {
      port: this.port,
      host: this.host,
      tlsMode: this.tlsState.mode,
      scheme: this.tlsState.scheme,
      trustProxy: this.tlsState.trustProxy,
    });
  }

  /**
   * Stop the listener.
   */
  async stop(): Promise<void> {
    if (this.server === null) return;
    this.server.stop(true);
    this.server = null;
    this.tlsState = null;
    logger.info('HttpListener stopped');
  }

  /**
   * Returns true if the listener is currently running.
   */
  get isRunning(): boolean {
    return this.server !== null;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private checkAuth(req: Request): boolean {
    const bearer = extractOperatorAuthToken(req);

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
    // Handle login route before auth check
    const url = new URL(req.url);
    if (url.pathname === '/login' && req.method === 'POST') {
      return this.handleLogin(req);
    }
    // CORS origin check when allowedOrigins is configured
    const origin = req.headers.get('origin') ?? '';
    if (this.allowedOrigins.length > 0 && origin && !this.allowedOrigins.includes(origin)) {
      return Response.json({ error: 'Origin not allowed' }, { status: 403 });
    }

    // Rate limiting (keyed by a synthetic IP-like string from headers)
    // Note: x-forwarded-for is only trustworthy when running behind a trusted reverse proxy.
    // If exposed directly to the internet, clients can spoof this header.
    const clientIp = extractForwardedClientIp(req, this.tlsState?.trustProxy ?? Boolean(this.configManager.get('httpListener.trustProxy'))) ?? 'unknown';
    if (!this.rateLimiter.check(clientIp)) {
      return Response.json({ error: 'Too many requests' }, { status: 429 });
    }

    // Auth check
    if (!this.checkAuth(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { pathname, method } = { pathname: url.pathname, method: req.method };

    if (pathname === '/webhook' && method === 'POST') {
      return this.handleWebhook(req);
    }

    if (pathname === '/health' && method === 'GET') {
      return Response.json({ status: 'ok' });
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
    }, {
      headers: {
        'Set-Cookie': buildOperatorSessionCookie(session.token, {
          req,
          expiresAt: session.expiresAt,
          trustProxy: this.tlsState?.trustProxy ?? Boolean(this.configManager.get('httpListener.trustProxy')),
        }),
      },
    });
  }

  private async handleWebhook(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Construct a HookEvent from the incoming payload
    const eventType = typeof body.event === 'string' ? body.event : 'webhook';
    const phase = typeof body.phase === 'string' ? body.phase : 'Post';

    const hookEvent: HookEvent = {
      path: `${phase}:webhook:${eventType}` as unknown as import('../hooks/types.ts').HookEventPath,
      phase: phase as HookEvent['phase'],
      category: 'workflow' as HookEvent['category'],
      specific: eventType,
      sessionId: '',
      timestamp: Date.now(),
      payload: body,
    };

    if (!this.hookDispatcher) {
      // No dispatcher wired — acknowledge without processing
      logger.info('HttpListener: no HookDispatcher wired, acknowledging without processing', {
        event: eventType,
      });
      return Response.json(
        { acknowledged: true, fired: false, reason: 'No HookDispatcher configured' },
        { status: 202 },
      );
    }

    try {
      const result = await this.hookDispatcher.fire(hookEvent);
      return Response.json(
        {
          acknowledged: true,
          fired: true,
          ok: result.ok,
          decision: result.decision ?? null,
          reason: result.reason ?? null,
          error: result.error ?? null,
        },
        { status: result.ok ? 200 : 422 },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('HttpListener: hook dispatch failed', { error: message });
      return Response.json({ error: `Hook dispatch failed: ${message}` }, { status: 500 });
    }
  }
}
