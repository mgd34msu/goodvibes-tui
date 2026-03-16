import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HttpListenerConfig {
  port?: number;
  host?: string;
  allowedOrigins?: string[];
}

interface HttpDangerConfig {
  httpListener: boolean;
}

// ---------------------------------------------------------------------------
// HttpListener
// ---------------------------------------------------------------------------

/**
 * HttpListener — fully implemented webhook listener, disabled by default.
 *
 * Enable via: danger.httpListener = true in config.
 * Listens for incoming POST /webhook requests.
 * Events are acknowledged only — not processed.
 */
export class HttpListener {
  private enabled = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private host: string;
  private allowedOrigins: string[];

  constructor(private config: HttpListenerConfig = {}) {
    this.port = config.port ?? 3422;
    this.host = config.host ?? '127.0.0.1';
    this.allowedOrigins = config.allowedOrigins ?? [];
  }

  /**
   * Enable the listener. Requires danger.httpListener = true in config.
   * Returns true if enabled, false if the config forbids it.
   */
  enable(dangerConfig: HttpDangerConfig): boolean {
    if (!dangerConfig.httpListener) {
      logger.info('HttpListener.enable: danger.httpListener is false — not enabling');
      return false;
    }
    this.enabled = true;
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
    if (this.server !== null) {
      logger.info('HttpListener: already running');
      return;
    }

    const self = this;
    this.server = Bun.serve({
      port: this.port,
      hostname: this.host,
      fetch(req: Request): Response {
        return self.handleWebhook(req);
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
  // Webhook handling
  // -------------------------------------------------------------------------

  private handleWebhook(req: Request): Response {
    const url = new URL(req.url);
    const origin = req.headers.get('origin') ?? '';

    // CORS origin check when allowedOrigins is configured
    if (this.allowedOrigins.length > 0 && origin && !this.allowedOrigins.includes(origin)) {
      return Response.json({ error: 'Origin not allowed' }, { status: 403 });
    }

    if (url.pathname === '/webhook' && req.method === 'POST') {
      return Response.json(
        { acknowledged: true, message: 'Webhook received. Processing is not yet implemented.' },
        { status: 202 },
      );
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json({ status: 'ok' });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}
