import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  buildOAuthAuthorizationStart,
  createOAuthState,
  createPkceVerifier,
  exchangeOAuthAuthorizationCode,
  parseOAuthScopes,
  refreshOAuthAccessToken,
} from '../runtime/auth/oauth-core.ts';

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

function isSubscriptionExpired(expiresAt?: number, bufferMs = 60_000): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return Date.now() + bufferMs >= expiresAt;
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
    const state = createOAuthState();
    const verifier = createPkceVerifier();
    const redirectUri = config.redirectUri;
    const pending: PendingSubscriptionLogin = {
      provider,
      state,
      verifier,
      redirectUri,
      createdAt: Date.now(),
    };
    const started = buildOAuthAuthorizationStart(config, { state, verifier, redirectUri });
    store.pending[provider] = pending;
    this.write(store);
    return {
      authorizationUrl: started.authorizationUrl,
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

    const tokenResponse = await exchangeOAuthAuthorizationCode(config, {
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
      state: pending.state,
    });
    const now = Date.now();
    const subscription: ProviderSubscription = {
      provider,
      accessToken: tokenResponse.accessToken,
      ...(typeof tokenResponse.refreshToken === 'string' && tokenResponse.refreshToken.length > 0
        ? { refreshToken: tokenResponse.refreshToken }
        : {}),
      tokenType: tokenResponse.tokenType,
      ...(typeof tokenResponse.expiresAt === 'number' && Number.isFinite(tokenResponse.expiresAt)
        ? { expiresAt: tokenResponse.expiresAt }
        : {}),
      ...(tokenResponse.scopes ? { scopes: tokenResponse.scopes } : {}),
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

    const tokenResponse = await refreshOAuthAccessToken(config, existing.refreshToken);

    const now = Date.now();
    const refreshed: ProviderSubscription = {
      ...existing,
      accessToken: tokenResponse.accessToken,
      refreshToken: typeof tokenResponse.refreshToken === 'string' && tokenResponse.refreshToken.length > 0
        ? tokenResponse.refreshToken
        : existing.refreshToken,
      tokenType: typeof tokenResponse.tokenType === 'string' && tokenResponse.tokenType.length > 0
        ? tokenResponse.tokenType
        : existing.tokenType,
      ...(typeof tokenResponse.expiresAt === 'number' && Number.isFinite(tokenResponse.expiresAt)
        ? { expiresAt: tokenResponse.expiresAt }
        : typeof existing.expiresAt === 'number' ? { expiresAt: existing.expiresAt } : {}),
      ...(tokenResponse.scopes ? { scopes: tokenResponse.scopes } : existing.scopes ? { scopes: existing.scopes } : {}),
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
