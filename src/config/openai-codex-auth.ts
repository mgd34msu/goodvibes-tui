import {
  buildOAuthAuthorizationStart,
  exchangeOAuthAuthorizationCode,
  refreshOAuthAccessToken,
} from '../runtime/auth/oauth-core.ts';

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

export function beginOpenAICodexLogin(): OpenAICodexLoginStart {
  const started = buildOAuthAuthorizationStart({
    authUrl: OPENAI_CODEX_AUTHORIZE_URL,
    tokenUrl: OPENAI_CODEX_TOKEN_URL,
    clientId: OPENAI_CODEX_CLIENT_ID,
    redirectUri: OPENAI_CODEX_REDIRECT_URI,
    scopes: OPENAI_CODEX_SCOPE.split(' '),
    usePkce: true,
    tokenRequestEncoding: 'form',
    refreshRequestEncoding: 'form',
    authParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'pi',
    },
  });
  return {
    authorizationUrl: started.authorizationUrl,
    state: started.state,
    verifier: started.verifier,
    redirectUri: started.redirectUri,
  };
}

export async function exchangeOpenAICodexCode(code: string, verifier: string): Promise<OpenAICodexTokenResult> {
  const token = await exchangeOAuthAuthorizationCode({
    authUrl: OPENAI_CODEX_AUTHORIZE_URL,
    tokenUrl: OPENAI_CODEX_TOKEN_URL,
    clientId: OPENAI_CODEX_CLIENT_ID,
    redirectUri: OPENAI_CODEX_REDIRECT_URI,
    scopes: OPENAI_CODEX_SCOPE.split(' '),
    usePkce: true,
    tokenRequestEncoding: 'form',
    refreshRequestEncoding: 'form',
  }, {
    code,
    verifier,
    redirectUri: OPENAI_CODEX_REDIRECT_URI,
  });
  if (!token.refreshToken || typeof token.expiresAt !== 'number') {
    throw new Error('OpenAI Codex token exchange did not return a refresh token or expiresAt.');
  }
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenType: token.tokenType,
    expiresAt: token.expiresAt,
    ...(token.scopes ? { scopes: token.scopes } : {}),
  };
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OpenAICodexTokenResult> {
  const token = await refreshOAuthAccessToken({
    authUrl: OPENAI_CODEX_AUTHORIZE_URL,
    tokenUrl: OPENAI_CODEX_TOKEN_URL,
    clientId: OPENAI_CODEX_CLIENT_ID,
    redirectUri: OPENAI_CODEX_REDIRECT_URI,
    scopes: OPENAI_CODEX_SCOPE.split(' '),
    usePkce: true,
    tokenRequestEncoding: 'form',
    refreshRequestEncoding: 'form',
  }, refreshToken);
  if (!token.refreshToken || typeof token.expiresAt !== 'number') {
    throw new Error('OpenAI Codex token refresh did not return a refresh token or expiresAt.');
  }
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenType: token.tokenType,
    expiresAt: token.expiresAt,
    ...(token.scopes ? { scopes: token.scopes } : {}),
  };
}
