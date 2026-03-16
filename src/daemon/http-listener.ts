import { timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger.ts';
import { HookDispatcher } from '../hooks/dispatcher.ts';
import type { HookEvent } from '../hooks/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HttpListenerConfig {
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  hookDispatcher?: HookDispatcher;
  /** Max requests per 60-second window per IP. Default: 60. */
  rateLimit?: number;
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
  private rateLimiter: RateLimiter;

  constructor(private config: HttpListenerConfig = {}) {
    this.port = config.port ?? 3422;
    this.host = config.host ?? '127.0.0.1';
    this.allowedOrigins = config.allowedOrigins ?? [];
    this.hookDispatcher = config.hookDispatcher ?? null;
    this.rateLimiter = new RateLimiter(config.rateLimit ?? 60);
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
      logger.error('HttpListener: starting without auth token — all requests accepted');
    }
    if (this.server !== null) {
      logger.info('HttpListener: already running');
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

    logger.info('HttpListener started', { port: this.port, host: this.host });
  }

  /**
   * Stop the listener.
   */
  async stop(): Promise<void> {
    if (this.server === null) return;
    this.server.stop(true);
    this.server = null;
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
    if (!this.authToken) return true; // no token configured = open
    const bearer = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';
    if (bearer.length !== this.authToken.length) return false;
    return timingSafeEqual(Buffer.from(bearer), Buffer.from(this.authToken));
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: Request): Promise<Response> {
    // CORS origin check when allowedOrigins is configured
    const origin = req.headers.get('origin') ?? '';
    if (this.allowedOrigins.length > 0 && origin && !this.allowedOrigins.includes(origin)) {
      return Response.json({ error: 'Origin not allowed' }, { status: 403 });
    }

    // Rate limiting (keyed by a synthetic IP-like string from headers)
    const clientIp = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown';
    if (!this.rateLimiter.check(clientIp)) {
      return Response.json({ error: 'Too many requests' }, { status: 429 });
    }

    // Auth check
    if (!this.checkAuth(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const { pathname, method } = { pathname: url.pathname, method: req.method };

    if (pathname === '/webhook' && method === 'POST') {
      return this.handleWebhook(req);
    }

    if (pathname === '/health' && method === 'GET') {
      return Response.json({ status: 'ok' });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
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
      path: `${phase}:webhook:${eventType}`,
      phase: phase as HookEvent['phase'],
      specific: eventType,
      input: body,
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
