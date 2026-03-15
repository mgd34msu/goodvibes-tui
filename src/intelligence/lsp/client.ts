import { logger } from '../../utils/logger.ts';
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './protocol.ts';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class LspClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private buffer = '';
  private readLoopRunning = false;

  constructor(
    private command: string,
    private args: string[],
    private options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) {}

  /** Start the LSP server process. */
  async start(): Promise<void> {
    if (this.proc) return;
    try {
      this.proc = Bun.spawn([this.command, ...this.args], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: this.options?.cwd,
        env: this.options?.env ? { ...process.env, ...this.options.env } : undefined,
      });
      this._startReadLoop();
    } catch (err) {
      logger.error('LspClient: failed to start process', { command: this.command, err: String(err) });
      this.proc = null;
      throw err;
    }
  }

  /** Send a request and wait for response. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.proc || !this.isRunning) {
      throw new Error('LspClient: server is not running');
    }
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const json = JSON.stringify(msg);
    const bytes = Buffer.byteLength(json, 'utf-8');
    const frame = `Content-Length: ${bytes}\r\n\r\n${json}`;

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.options?.timeout ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LspClient: request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.proc!.stdin.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`LspClient: failed to write request: ${String(err)}`));
      }
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (!this.proc || !this.isRunning) return;
    try {
      const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
      const json = JSON.stringify(msg);
      const bytes = Buffer.byteLength(json, 'utf-8');
      const frame = `Content-Length: ${bytes}\r\n\r\n${json}`;
      this.proc.stdin.write(frame);
    } catch (err) {
      logger.error('LspClient: failed to send notification', { method, err: String(err) });
    }
  }

  /** Stop the server process. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('LspClient: server stopped'));
      this.pendingRequests.delete(id);
    }
    try {
      this.proc.stdin.end();
      this.proc.kill();
      await this.proc.exited;
    } catch {
      // Ignore errors during shutdown
    } finally {
      this.proc = null;
      this.buffer = '';
      this.readLoopRunning = false;
    }
  }

  /** Is the server running? */
  get isRunning(): boolean {
    if (!this.proc) return false;
    // Bun.spawn process: check exitCode — null means still running
    try {
      return (this.proc as { exitCode: number | null }).exitCode === null;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _startReadLoop(): void {
    if (this.readLoopRunning || !this.proc) return;
    this.readLoopRunning = true;

    const proc = this.proc;
    const decoder = new TextDecoder();

    (async () => {
      try {
        const reader = proc.stdout.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          this._processBuffer();
        }
      } catch (err) {
        logger.debug('LspClient: stdout read loop ended', { err: String(err) });
      } finally {
        this.readLoopRunning = false;
        // Reject any remaining pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('LspClient: server process exited unexpectedly'));
          this.pendingRequests.delete(id);
        }
      }
    })();
  }

  private _processBuffer(): void {
    while (true) {
      // Look for the header terminator
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        // Malformed header — skip to next boundary
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      // Wait for full body
      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);

      this._dispatchMessage(body);
    }
  }

  private _dispatchMessage(body: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch (err) {
      logger.error('LspClient: failed to parse JSON-RPC message', { err: String(err), body: body.slice(0, 200) });
      return;
    }

    if (typeof msg !== 'object' || msg === null) return;

    const response = msg as JsonRpcResponse;
    if ('id' in response && typeof response.id === 'number') {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(`LSP error ${response.error.code}: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
      }
    }
    // Notifications (no id) are silently ignored for now
  }

  /** Encode a JSON-RPC frame (Content-Length framing). Exposed for testing. */
  static encodeFrame(json: string): string {
    const bytes = Buffer.byteLength(json, 'utf-8');
    return `Content-Length: ${bytes}\r\n\r\n${json}`;
  }

  /** Parse all complete JSON-RPC messages from a buffer string. Returns [messages, remainingBuffer]. */
  static parseMessages(buffer: string): [unknown[], string] {
    const messages: unknown[] = [];
    let remaining = buffer;

    while (true) {
      const headerEnd = remaining.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = remaining.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        remaining = remaining.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (remaining.length < bodyEnd) break;

      const body = remaining.slice(bodyStart, bodyEnd);
      remaining = remaining.slice(bodyEnd);

      try {
        messages.push(JSON.parse(body));
      } catch {
        // skip malformed
      }
    }

    return [messages, remaining];
  }
}
