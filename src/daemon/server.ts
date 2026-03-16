import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DaemonConfig {
  port?: number;
  host?: string;
}

interface DaemonDangerConfig {
  daemon: boolean;
}

// ---------------------------------------------------------------------------
// DaemonServer
// ---------------------------------------------------------------------------

/**
 * DaemonServer — fully implemented HTTP task server, disabled by default.
 *
 * Enable via: danger.daemon = true in config.
 * Accepts task submissions via POST /task.
 * Returns status via GET /status.
 * Tasks are acknowledged only — not processed.
 */
export class DaemonServer {
  private enabled = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private host: string;

  constructor(private config: DaemonConfig = {}) {
    this.port = config.port ?? 3421;
    this.host = config.host ?? '127.0.0.1';
  }

  /**
   * Enable the daemon. Requires danger.daemon = true in config.
   * Returns true if enabled, false if the config forbids it.
   */
  enable(dangerConfig: DaemonDangerConfig): boolean {
    if (!dangerConfig.daemon) {
      logger.info('DaemonServer.enable: danger.daemon is false — not enabling');
      return false;
    }
    this.enabled = true;
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
    if (this.server !== null) {
      logger.info('DaemonServer: already running');
      return;
    }

    const self = this;
    this.server = Bun.serve({
      port: this.port,
      hostname: this.host,
      fetch(req: Request): Response {
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
  // Request handling
  // -------------------------------------------------------------------------

  private handleRequest(req: Request): Response {
    const url = new URL(req.url);

    if (url.pathname === '/status' && req.method === 'GET') {
      return Response.json({ status: 'running', version: '0.2.0' });
    }

    if (url.pathname === '/task' && req.method === 'POST') {
      // Acknowledge receipt — tasks are not processed in the stub
      return Response.json(
        { acknowledged: true, message: 'Task received. Processing is not yet implemented.' },
        { status: 202 },
      );
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}
