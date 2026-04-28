import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

type HostServeFetch = (
  request: Request,
  server: unknown,
) => Response | undefined | Promise<Response | undefined>;

type HostServeOptions = Parameters<typeof Bun.serve>[0] & {
  fetch?: HostServeFetch;
};

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return request.url;
  }
}

export function createHostRequestFailureResponse(
  surface: string,
  request: Request,
  error: unknown,
): Response {
  const message = summarizeError(error);
  logger.error(`${surface}: request handler failed`, {
    method: request.method,
    path: requestPath(request),
    error: message,
  });
  return Response.json({
    error: message,
    code: 'HOST_REQUEST_HANDLER_FAILED',
  }, { status: 500 });
}

export function createSafeHostServeFactory(
  surface: string,
  baseServeFactory: typeof Bun.serve = Bun.serve,
): typeof Bun.serve {
  return ((options: HostServeOptions) => {
    const originalFetch = options.fetch;
    if (typeof originalFetch !== 'function') {
      return baseServeFactory(options as Parameters<typeof Bun.serve>[0]);
    }

    const wrappedFetch: HostServeFetch = async (request, server) => {
      try {
        return await originalFetch(request, server);
      } catch (error) {
        return createHostRequestFailureResponse(surface, request, error);
      }
    };

    return baseServeFactory({
      ...options,
      fetch: wrappedFetch,
    } as Parameters<typeof Bun.serve>[0]);
  }) as typeof Bun.serve;
}
