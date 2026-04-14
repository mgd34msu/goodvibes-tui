import { sleepWithSignal } from './backoff.ts';
import { mergeHeaders, resolveAuthToken, type AuthTokenResolver } from './http-auth.ts';
import {
  getStreamReconnectDelay,
  normalizeStreamReconnectPolicy,
  type StreamReconnectPolicy,
} from './stream-reconnect.ts';
import type { TransportJsonError } from './http-json-transport.ts';

export interface ServerSentEventHandlers {
  readonly onEvent?: (eventName: string, payload: unknown) => void;
  readonly onReady?: (payload: unknown) => void;
  readonly onError?: (error: unknown) => void;
  readonly onReconnect?: (input: { readonly attempt: number; readonly delayMs: number }) => void;
}

export interface ServerSentEventOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
  readonly authToken?: string | null;
  readonly getAuthToken?: AuthTokenResolver;
  readonly lastEventId?: string | null;
  readonly reconnect?: StreamReconnectPolicy;
}

function readEventPayload(data: string): unknown {
  if (!data.trim()) return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { readonly name?: string }).name === 'AbortError'
  );
}

function createStreamError(
  status: number,
  url: string,
  body: string,
): Error & { readonly transport: TransportJsonError } {
  const message = body.trim()
    ? `Unable to open SSE stream: ${status} ${body}`.trim()
    : `Unable to open SSE stream: ${status}`;
  return Object.assign(new Error(message), {
    transport: {
      status,
      body,
      url,
      method: 'GET',
    },
  });
}

function reportStreamError(error: unknown, handlers: ServerSentEventHandlers): void {
  if (handlers.onError) {
    handlers.onError(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}

export async function openServerSentEventStream(
  fetchImpl: typeof fetch,
  url: string,
  handlers: ServerSentEventHandlers,
  options: ServerSentEventOptions = {},
): Promise<() => void> {
  const outerController = new AbortController();
  const reconnectPolicy = normalizeStreamReconnectPolicy(options.reconnect);
  let lastEventId = options.lastEventId ?? null;
  let activeController: AbortController | null = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let readySettled = false;

  if (options.signal) {
    options.signal.addEventListener('abort', () => outerController.abort(), { once: true });
  }

  const readyPromise = new Promise<void>((resolve, reject) => {
    const settleReady = (error?: unknown) => {
      if (readySettled) return;
      readySettled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const runConnection = async (): Promise<void> => {
      const controller = new AbortController();
      activeController = controller;
      outerController.signal.addEventListener('abort', () => controller.abort(), { once: true });
      const token = await resolveAuthToken(options.authToken ?? null, options.getAuthToken);
      const headers = mergeHeaders(
        { Accept: 'text/event-stream' },
        options.headers,
        token ? { Authorization: `Bearer ${token}` } : undefined,
        lastEventId ? { 'Last-Event-ID': lastEventId } : undefined,
      );

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
          headers,
        });
      } catch (error) {
        const wrapped = createStreamError(0, url, error instanceof Error ? error.message : String(error));
        if (!readySettled) {
          settleReady(wrapped);
          return;
        }
        throw wrapped;
      }

      if (!response.ok || !response.body) {
        const body = await response.text().catch(() => '');
        const wrapped = createStreamError(response.status, url, body);
        if (!readySettled) {
          settleReady(wrapped);
          return;
        }
        throw wrapped;
      }

      settleReady();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = '';
      let data = '';

      const flush = (): void => {
        if (!eventName && !data.trim()) {
          eventName = '';
          data = '';
          return;
        }
        const payload = readEventPayload(data);
        if (eventName === 'ready') {
          handlers.onReady?.(payload);
        } else {
          handlers.onEvent?.(eventName || 'message', payload);
        }
        eventName = '';
        data = '';
      };

      const consumeLine = (line: string): void => {
        if (!line) {
          flush();
          return;
        }
        if (line.startsWith(':')) return;
        if (line.startsWith('id:')) {
          const candidate = line.slice(3).trim();
          if (candidate) {
            lastEventId = candidate;
          }
          return;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          return;
        }
        if (line.startsWith('data:')) {
          data += `${data ? '\n' : ''}${line.slice(5).trim()}`;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            consumeLine(line);
            newlineIndex = buffer.indexOf('\n');
          }
        }
        if (buffer.trim()) {
          consumeLine(buffer.replace(/\r$/, ''));
          flush();
        }
        if (reconnectPolicy.enabled && !controller.signal.aborted && !outerController.signal.aborted && !stopped) {
          throw createStreamError(response.status, url, 'Stream closed unexpectedly');
        }
      } finally {
        controller.abort();
        if (activeController === controller) {
          activeController = null;
        }
      }
    };

    const loop = async (): Promise<void> => {
      while (!outerController.signal.aborted && !stopped) {
        try {
          await runConnection();
          reconnectAttempts = 0;
          return;
        } catch (error) {
          if (isAbortError(error) || outerController.signal.aborted || stopped) {
            return;
          }
          const nextAttempt = reconnectAttempts + 1;
          const shouldReconnect = reconnectPolicy.enabled && nextAttempt < reconnectPolicy.maxAttempts;
          if (!shouldReconnect) {
            reportStreamError(error, handlers);
            return;
          }
          reconnectAttempts = nextAttempt;
          const delayMs = getStreamReconnectDelay(nextAttempt + 1, reconnectPolicy);
          handlers.onReconnect?.({ attempt: nextAttempt, delayMs });
          handlers.onError?.(error);
          try {
            await sleepWithSignal(delayMs, outerController.signal);
          } catch (sleepError) {
            if (!isAbortError(sleepError)) {
              reportStreamError(sleepError, handlers);
            }
            return;
          }
        }
      }
    };

    void loop();
  });
  await readyPromise;

  return () => {
    stopped = true;
    activeController?.abort();
    outerController.abort();
  };
}
