import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { summarizeError } from '../utils/error-display.ts';

export interface OAuthLocalListenerConfig {
  readonly expectedState: string;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly timeoutMs?: number;
}

export interface OAuthLocalListenerResult {
  readonly code: string;
}

export interface OAuthLocalListener {
  readonly redirectUri: string;
  setExpectedState(state: string): void;
  waitForCode(): Promise<OAuthLocalListenerResult>;
  close(): void;
}

function successHtml(message: string): string {
  return `<!doctype html><html><body><h1>${message}</h1><p>You can close this window.</p></body></html>`;
}

function errorHtml(message: string): string {
  return `<!doctype html><html><body><h1>Authentication failed</h1><p>${message}</p></body></html>`;
}

export async function createOAuthLocalListener(config: OAuthLocalListenerConfig): Promise<OAuthLocalListener> {
  const host = config.host ?? '127.0.0.1';
  const path = config.path ?? '/callback';
  const timeoutMs = config.timeoutMs ?? 180_000;
  let expectedState = config.expectedState;

  let server: Server | null = createServer();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveWait: ((value: OAuthLocalListenerResult) => void) | null = null;
  let rejectWait: ((error: Error) => void) | null = null;

  const waitForCodePromise = new Promise<OAuthLocalListenerResult>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  const settleSuccess = (value: OAuthLocalListenerResult): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    resolveWait?.(value);
    resolveWait = null;
    rejectWait = null;
  };

  const settleFailure = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    rejectWait?.(error);
    resolveWait = null;
    rejectWait = null;
  };

  const close = (): void => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (server) {
      server.removeAllListeners();
      server.close();
      server = null;
    }
  };

  server.on('request', (req, res) => {
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? host}`);
      if (url.pathname !== path) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml('Callback route not found.'));
        return;
      }

      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml(`Provider returned error: ${error}`));
        settleFailure(new Error(`OAuth callback returned error: ${error}`));
        close();
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml('State mismatch.'));
        settleFailure(new Error('OAuth state mismatch.'));
        close();
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml('Authorization code missing.'));
        settleFailure(new Error('OAuth callback did not include an authorization code.'));
        close();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(successHtml('Authentication completed.'));
      settleSuccess({ code });
      close();
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml('Internal callback error.'));
      settleFailure(error instanceof Error ? error : new Error(summarizeError(error)));
      close();
    }
  });

  server.on('error', (error) => {
    settleFailure(error instanceof Error ? error : new Error(summarizeError(error)));
    close();
  });

  const address = await new Promise<AddressInfo>((resolve, reject) => {
    server?.listen(config.port ?? 0, host, () => {
      const currentAddress = server?.address();
      if (!currentAddress || typeof currentAddress === 'string') {
        reject(new Error('Failed to determine OAuth callback listener address.'));
        return;
      }
      resolve(currentAddress);
    });
    server?.once('error', reject);
  });

  timeout = setTimeout(() => {
    settleFailure(new Error('Timed out waiting for OAuth callback.'));
    close();
  }, timeoutMs);

  return {
    redirectUri: `http://${host}:${address.port}${path}`,
    setExpectedState: (state: string) => {
      expectedState = state;
    },
    waitForCode: () => waitForCodePromise,
    close,
  };
}
