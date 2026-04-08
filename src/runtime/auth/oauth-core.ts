import { createHash, randomBytes } from 'node:crypto';
import type { OAuthProviderConfig } from '../../config/subscriptions.ts';

export interface OAuthStartState {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

export interface OAuthTokenPayload {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
}

export function createOAuthState(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function createPkceVerifier(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function parseOAuthScopes(raw: unknown): readonly string[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const scopes = raw.split(' ').map((value) => value.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

export function buildOAuthAuthorizationStart(
  config: OAuthProviderConfig,
  input?: {
    readonly state?: string;
    readonly verifier?: string;
    readonly redirectUri?: string;
  },
): OAuthStartState {
  const state = input?.state ?? createOAuthState();
  const verifier = input?.verifier ?? createPkceVerifier();
  const redirectUri = input?.redirectUri ?? config.redirectUri;
  const url = new URL(config.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  if (config.scopes && config.scopes.length > 0) {
    url.searchParams.set('scope', config.scopes.join(' '));
  }
  if (config.audience) {
    url.searchParams.set('audience', config.audience);
  }
  if (config.usePkce ?? true) {
    url.searchParams.set('code_challenge', createPkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(config.authParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return {
    authorizationUrl: url.toString(),
    state,
    verifier,
    redirectUri,
  };
}

async function exchangeOAuthRequest(
  url: string,
  encoding: 'form' | 'json',
  payload: Record<string, string | number | boolean>,
): Promise<OAuthTokenPayload> {
  const body = encoding === 'json'
    ? JSON.stringify(payload)
    : new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)])).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OAuth token exchange failed (${response.status}): ${text}`);
  }
  const json = await response.json() as {
    access_token?: unknown;
    refresh_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('OAuth token exchange did not return an access token.');
  }
  return {
    accessToken: json.access_token,
    ...(typeof json.refresh_token === 'string' && json.refresh_token.length > 0
      ? { refreshToken: json.refresh_token }
      : {}),
    tokenType: typeof json.token_type === 'string' && json.token_type.length > 0 ? json.token_type : 'Bearer',
    ...(typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
      ? { expiresAt: Date.now() + (json.expires_in * 1000) }
      : {}),
    ...(parseOAuthScopes(json.scope) ? { scopes: parseOAuthScopes(json.scope) } : {}),
  };
}

export async function exchangeOAuthAuthorizationCode(
  config: OAuthProviderConfig,
  input: {
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
    readonly state?: string;
  },
): Promise<OAuthTokenPayload> {
  const payload: Record<string, string | number | boolean> = {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
  };
  if (config.usePkce ?? true) payload.code_verifier = input.verifier;
  if (config.audience) payload.audience = config.audience;
  if (config.includeStateInTokenRequest && input.state) payload.state = input.state;
  for (const [key, value] of Object.entries(config.tokenRequestExtras ?? {})) {
    payload[key] = value;
  }
  return exchangeOAuthRequest(config.tokenUrl, config.tokenRequestEncoding ?? 'form', payload);
}

export async function refreshOAuthAccessToken(
  config: OAuthProviderConfig,
  refreshToken: string,
): Promise<OAuthTokenPayload> {
  const payload: Record<string, string | number | boolean> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  };
  if (config.refreshScopes && config.refreshScopes.length > 0) {
    payload.scope = config.refreshScopes.join(' ');
  }
  if (config.audience) payload.audience = config.audience;
  for (const [key, value] of Object.entries(config.refreshRequestExtras ?? {})) {
    payload[key] = value;
  }
  return exchangeOAuthRequest(config.tokenUrl, config.refreshRequestEncoding ?? config.tokenRequestEncoding ?? 'form', payload);
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
