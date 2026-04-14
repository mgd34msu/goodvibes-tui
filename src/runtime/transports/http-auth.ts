export type MaybePromise<T> = T | Promise<T>;

export type AuthTokenResolver = () => MaybePromise<string | null | undefined>;

export type HeaderResolver = () => MaybePromise<HeadersInit | undefined>;

function appendHeaders(target: Headers, headers: HeadersInit | undefined): void {
  if (!headers) return;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      target.set(key, value);
    });
    return;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      target.set(key, value);
    }
    return;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      target.set(key, value);
    }
  }
}

export function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) {
    appendHeaders(headers, source);
  }
  return headers;
}

export async function resolveAuthToken(
  authToken: string | null | undefined,
  getAuthToken?: AuthTokenResolver,
): Promise<string | null> {
  if (getAuthToken) {
    const resolved = await getAuthToken();
    return resolved ?? null;
  }
  return authToken ?? null;
}

export async function resolveHeaders(
  headers: HeadersInit | undefined,
  getHeaders?: HeaderResolver,
): Promise<Headers> {
  const resolved = getHeaders ? await getHeaders() : undefined;
  return mergeHeaders(headers, resolved);
}
