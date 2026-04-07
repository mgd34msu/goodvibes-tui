import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface OAuthProviderConfig {
  readonly authUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly manualRedirectUri?: string;
  readonly scopes?: readonly string[];
  readonly audience?: string;
  readonly usePkce?: boolean;
  readonly authParams?: Readonly<Record<string, string>>;
  readonly tokenRequestEncoding?: 'form' | 'json';
  readonly includeStateInTokenRequest?: boolean;
  readonly tokenRequestExtras?: Readonly<Record<string, string | number | boolean>>;
  readonly refreshRequestEncoding?: 'form' | 'json';
  readonly refreshRequestExtras?: Readonly<Record<string, string | number | boolean>>;
  readonly refreshScopes?: readonly string[];
  readonly overrideAmbientApiKeys?: boolean;
  readonly localCallback?: {
    readonly host?: string;
    readonly port?: number;
    readonly path?: string;
    readonly autoComplete?: boolean;
  };
}

export interface PendingSubscriptionLogin {
  readonly provider: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

export interface ProviderSubscription {
  readonly provider: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
  readonly authMode: 'oauth';
  readonly overrideAmbientApiKeys: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface SubscriptionStore {
  readonly version: 1;
  readonly subscriptions: Record<string, ProviderSubscription>;
  readonly pending: Record<string, PendingSubscriptionLogin>;
}

function defaultPath(): string {
  return join(homedir(), '.goodvibes', 'tui', 'subscriptions.json');
}

function legacyProjectPath(): string {
  return join(process.cwd(), '.goodvibes', 'tui', 'subscriptions.json');
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function isSubscriptionExpired(expiresAt?: number, bufferMs = 60_000): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return Date.now() + bufferMs >= expiresAt;
}

function parseScopes(raw: unknown): readonly string[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const scopes = raw.split(' ').map((value) => value.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

export class SubscriptionManager {
  private readonly path: string;

  public constructor(path?: string) {
    this.path = path ?? defaultPath();
  }

  private read(): SubscriptionStore {
    try {
      const raw = readFileSync(this.path, 'utf-8');
      return JSON.parse(raw) as SubscriptionStore;
    } catch {
      if (this.path === defaultPath()) {
        try {
          const legacyRaw = readFileSync(legacyProjectPath(), 'utf-8');
          const parsed = JSON.parse(legacyRaw) as SubscriptionStore;
          this.write(parsed);
          return parsed;
        } catch {
          // fall through to empty store
        }
      }
      return {
        version: 1,
        subscriptions: {},
        pending: {},
      };
    }
  }

  private write(store: SubscriptionStore): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  }

  public list(): ProviderSubscription[] {
    return Object.values(this.read().subscriptions).sort((a, b) => a.provider.localeCompare(b.provider));
  }

  public listPending(): PendingSubscriptionLogin[] {
    return Object.values(this.read().pending).sort((a, b) => a.provider.localeCompare(b.provider));
  }

  public get(provider: string): ProviderSubscription | null {
    return this.read().subscriptions[provider] ?? null;
  }

  public getAccessToken(provider: string): string | null {
    const subscription = this.get(provider);
    if (!subscription?.overrideAmbientApiKeys) return null;
    return subscription.accessToken;
  }

  public async resolveAccessToken(
    provider: string,
    config: OAuthProviderConfig,
  ): Promise<string | null> {
    const subscription = this.get(provider);
    if (!subscription) return null;
    const active = isSubscriptionExpired(subscription.expiresAt)
      ? await this.refreshOAuthToken(provider, config)
      : subscription;
    return active.accessToken;
  }

  public beginOAuthLogin(provider: string, config: OAuthProviderConfig): { authorizationUrl: string; pending: PendingSubscriptionLogin } {
    const store = this.read();
    const state = randomBase64Url(24);
    const verifier = randomBase64Url(32);
    const redirectUri = config.redirectUri;
    const pending: PendingSubscriptionLogin = {
      provider,
      state,
      verifier,
      redirectUri,
      createdAt: Date.now(),
    };
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
      url.searchParams.set('code_challenge', sha256Base64Url(verifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    for (const [key, value] of Object.entries(config.authParams ?? {})) {
      url.searchParams.set(key, value);
    }
    store.pending[provider] = pending;
    this.write(store);
    return {
      authorizationUrl: url.toString(),
      pending,
    };
  }

  public async completeOAuthLogin(
    provider: string,
    config: OAuthProviderConfig,
    code: string,
  ): Promise<ProviderSubscription> {
    const store = this.read();
    const pending = store.pending[provider];
    if (!pending) {
      throw new Error(`No pending OAuth login for ${provider}. Start with /subscription login ${provider} start.`);
    }

    const tokenPayload: Record<string, string | number | boolean> = {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      redirect_uri: pending.redirectUri,
      code,
    };
    if (config.usePkce ?? true) {
      tokenPayload.code_verifier = pending.verifier;
    }
    if (config.audience) {
      tokenPayload.audience = config.audience;
    }
    if (config.includeStateInTokenRequest) {
      tokenPayload.state = pending.state;
    }
    for (const [key, value] of Object.entries(config.tokenRequestExtras ?? {})) {
      tokenPayload[key] = value;
    }

    const encoding = config.tokenRequestEncoding ?? 'form';
    const body = encoding === 'json'
      ? JSON.stringify(tokenPayload)
      : new URLSearchParams(
          Object.entries(tokenPayload).map(([key, value]) => [key, String(value)]),
        ).toString();

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': encoding === 'json'
          ? 'application/json'
          : 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth token exchange failed (${response.status}): ${text}`);
    }
    const tokenResponse = await response.json() as {
      access_token?: unknown;
      refresh_token?: unknown;
      token_type?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    if (typeof tokenResponse.access_token !== 'string' || tokenResponse.access_token.length === 0) {
      throw new Error('OAuth token exchange did not return an access token.');
    }
    const now = Date.now();
    const subscription: ProviderSubscription = {
      provider,
      accessToken: tokenResponse.access_token,
      ...(typeof tokenResponse.refresh_token === 'string' && tokenResponse.refresh_token.length > 0
        ? { refreshToken: tokenResponse.refresh_token }
        : {}),
      tokenType: typeof tokenResponse.token_type === 'string' && tokenResponse.token_type.length > 0
        ? tokenResponse.token_type
        : 'Bearer',
      ...(typeof tokenResponse.expires_in === 'number' && Number.isFinite(tokenResponse.expires_in)
        ? { expiresAt: now + (tokenResponse.expires_in * 1000) }
        : {}),
      ...(parseScopes(tokenResponse.scope) ? { scopes: parseScopes(tokenResponse.scope) } : {}),
      authMode: 'oauth',
      overrideAmbientApiKeys: config.overrideAmbientApiKeys ?? true,
      createdAt: store.subscriptions[provider]?.createdAt ?? now,
      updatedAt: now,
    };
    store.subscriptions[provider] = subscription;
    delete store.pending[provider];
    this.write(store);
    return subscription;
  }

  public async refreshOAuthToken(
    provider: string,
    config: OAuthProviderConfig,
  ): Promise<ProviderSubscription> {
    const store = this.read();
    const existing = store.subscriptions[provider];
    if (!existing) {
      throw new Error(`No stored OAuth subscription for ${provider}.`);
    }
    if (!existing.refreshToken) {
      return existing;
    }

    const tokenPayload: Record<string, string | number | boolean> = {
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken,
      client_id: config.clientId,
    };
    if (config.refreshScopes && config.refreshScopes.length > 0) {
      tokenPayload.scope = config.refreshScopes.join(' ');
    }
    for (const [key, value] of Object.entries(config.refreshRequestExtras ?? {})) {
      tokenPayload[key] = value;
    }

    const encoding = config.refreshRequestEncoding ?? config.tokenRequestEncoding ?? 'form';
    const body = encoding === 'json'
      ? JSON.stringify(tokenPayload)
      : new URLSearchParams(
          Object.entries(tokenPayload).map(([key, value]) => [key, String(value)]),
        ).toString();

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': encoding === 'json'
          ? 'application/json'
          : 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth token refresh failed (${response.status}): ${text}`);
    }

    const tokenResponse = await response.json() as {
      access_token?: unknown;
      refresh_token?: unknown;
      token_type?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    if (typeof tokenResponse.access_token !== 'string' || tokenResponse.access_token.length === 0) {
      throw new Error('OAuth token refresh did not return an access token.');
    }

    const now = Date.now();
    const refreshed: ProviderSubscription = {
      ...existing,
      accessToken: tokenResponse.access_token,
      refreshToken: typeof tokenResponse.refresh_token === 'string' && tokenResponse.refresh_token.length > 0
        ? tokenResponse.refresh_token
        : existing.refreshToken,
      tokenType: typeof tokenResponse.token_type === 'string' && tokenResponse.token_type.length > 0
        ? tokenResponse.token_type
        : existing.tokenType,
      ...(typeof tokenResponse.expires_in === 'number' && Number.isFinite(tokenResponse.expires_in)
        ? { expiresAt: now + (tokenResponse.expires_in * 1000) }
        : typeof existing.expiresAt === 'number' ? { expiresAt: existing.expiresAt } : {}),
      ...(parseScopes(tokenResponse.scope) ? { scopes: parseScopes(tokenResponse.scope) } : existing.scopes ? { scopes: existing.scopes } : {}),
      updatedAt: now,
    };

    store.subscriptions[provider] = refreshed;
    this.write(store);
    return refreshed;
  }

  public logout(provider: string): boolean {
    const store = this.read();
    const existed = provider in store.subscriptions || provider in store.pending;
    delete store.subscriptions[provider];
    delete store.pending[provider];
    this.write(store);
    return existed;
  }

  public getPending(provider: string): PendingSubscriptionLogin | null {
    return this.read().pending[provider] ?? null;
  }

  public savePending(pending: PendingSubscriptionLogin): void {
    const store = this.read();
    store.pending[pending.provider] = pending;
    this.write(store);
  }

  public clearPending(provider: string): void {
    const store = this.read();
    delete store.pending[provider];
    this.write(store);
  }

  public saveSubscription(subscription: ProviderSubscription): ProviderSubscription {
    const store = this.read();
    store.subscriptions[subscription.provider] = subscription;
    delete store.pending[subscription.provider];
    this.write(store);
    return subscription;
  }
}

let subscriptionManager: SubscriptionManager | undefined;

export function getSubscriptionManager(): SubscriptionManager {
  if (!subscriptionManager) subscriptionManager = new SubscriptionManager();
  return subscriptionManager;
}

export function _resetSubscriptionManagerForTesting(): void {
  subscriptionManager = undefined;
}
