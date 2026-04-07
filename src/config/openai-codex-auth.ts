import { createHash, randomBytes } from 'node:crypto';

export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OPENAI_CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OPENAI_CODEX_SCOPE = 'openid profile email offline_access';

export interface OpenAICodexLoginStart {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

export interface OpenAICodexTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: string;
  readonly expiresAt: number;
  readonly scopes?: readonly string[];
}

function base64UrlEncode(input: Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

function createVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

function createChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function createState(): string {
  return randomBytes(16).toString('hex');
}

function parseScopes(raw: unknown): readonly string[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const scopes = raw.split(' ').map((value) => value.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

async function exchangeForm(body: URLSearchParams): Promise<OpenAICodexTokenResult> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Codex token exchange failed (${response.status}): ${text}`);
  }
  const json = await response.json() as {
    access_token?: unknown;
    refresh_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('OpenAI Codex token exchange did not return an access token.');
  }
  if (typeof json.refresh_token !== 'string' || json.refresh_token.length === 0) {
    throw new Error('OpenAI Codex token exchange did not return a refresh token.');
  }
  if (typeof json.expires_in !== 'number' || !Number.isFinite(json.expires_in)) {
    throw new Error('OpenAI Codex token exchange did not return expires_in.');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenType: typeof json.token_type === 'string' && json.token_type.length > 0 ? json.token_type : 'Bearer',
    expiresAt: Date.now() + (json.expires_in * 1000),
    ...(parseScopes(json.scope) ? { scopes: parseScopes(json.scope) } : {}),
  };
}

export function beginOpenAICodexLogin(): OpenAICodexLoginStart {
  const verifier = createVerifier();
  const challenge = createChallenge(verifier);
  const state = createState();
  const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', OPENAI_CODEX_REDIRECT_URI);
  url.searchParams.set('scope', OPENAI_CODEX_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'pi');
  return {
    authorizationUrl: url.toString(),
    state,
    verifier,
    redirectUri: OPENAI_CODEX_REDIRECT_URI,
  };
}

export async function exchangeOpenAICodexCode(code: string, verifier: string): Promise<OpenAICodexTokenResult> {
  return exchangeForm(new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OPENAI_CODEX_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: OPENAI_CODEX_REDIRECT_URI,
  }));
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OpenAICodexTokenResult> {
  return exchangeForm(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OPENAI_CODEX_CLIENT_ID,
  }));
}
