import type { OAuthProviderConfig } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import type { ServiceConfig } from './service-registry.ts';

export interface BuiltinSubscriptionProvider {
  readonly provider: string;
  readonly displayName: string;
  readonly authType: 'oauth';
  readonly tokenKey: string;
  readonly providerId: string;
  readonly oauth: OAuthProviderConfig;
  readonly notes: readonly string[];
}

export interface AvailableSubscriptionProvider {
  readonly provider: string;
  readonly displayName: string;
  readonly source: 'builtin' | 'service';
  readonly oauth: OAuthProviderConfig;
  readonly tokenKey: string;
  readonly providerId: string;
  readonly notes: readonly string[];
}

const OPENAI_SUBSCRIPTION_PROVIDER: BuiltinSubscriptionProvider = {
  provider: 'openai',
  displayName: 'OpenAI Codex',
  authType: 'oauth',
  tokenKey: 'OPENAI_API_KEY',
  providerId: 'openai',
  oauth: {
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirectUri: 'http://localhost:1455/auth/callback',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    usePkce: true,
    tokenRequestEncoding: 'form',
    refreshRequestEncoding: 'form',
    overrideAmbientApiKeys: false,
    authParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'pi',
    },
    localCallback: {
      host: 'localhost',
      port: 1455,
      path: '/auth/callback',
      autoComplete: true,
    },
  },
  notes: [
    'Built-in OpenAI Codex / ChatGPT subscription login path.',
    'Uses the Codex/ChatGPT OAuth flow rather than the standard OpenAI API-key path.',
  ],
};

const BUILTIN_SUBSCRIPTION_PROVIDERS: Record<string, BuiltinSubscriptionProvider> = {
  openai: OPENAI_SUBSCRIPTION_PROVIDER,
};

export function listBuiltinSubscriptionProviders(): BuiltinSubscriptionProvider[] {
  return Object.values(BUILTIN_SUBSCRIPTION_PROVIDERS)
    .slice()
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function getBuiltinSubscriptionProvider(provider: string): BuiltinSubscriptionProvider | null {
  return BUILTIN_SUBSCRIPTION_PROVIDERS[provider] ?? null;
}

export function getSubscriptionProviderConfig(
  provider: string,
  serviceConfig?: ServiceConfig | null,
): { oauth: OAuthProviderConfig; source: 'service' | 'builtin'; tokenKey: string; providerId: string } | null {
  if (serviceConfig?.authType === 'oauth' && serviceConfig.oauth) {
    return {
      oauth: serviceConfig.oauth,
      source: 'service',
      tokenKey: serviceConfig.tokenKey,
      providerId: serviceConfig.providerId ?? serviceConfig.name,
    };
  }

  const builtin = getBuiltinSubscriptionProvider(provider);
  if (!builtin) return null;
  return {
    oauth: builtin.oauth,
    source: 'builtin',
    tokenKey: builtin.tokenKey,
    providerId: builtin.providerId,
  };
}

export function listAvailableSubscriptionProviders(
  services: Record<string, ServiceConfig>,
): AvailableSubscriptionProvider[] {
  const providers = new Map<string, AvailableSubscriptionProvider>();

  for (const builtin of listBuiltinSubscriptionProviders()) {
    providers.set(builtin.provider, {
      provider: builtin.provider,
      displayName: builtin.displayName,
      source: 'builtin',
      oauth: builtin.oauth,
      tokenKey: builtin.tokenKey,
      providerId: builtin.providerId,
      notes: builtin.notes,
    });
  }

  for (const service of Object.values(services)) {
    if (service.authType !== 'oauth' || !service.oauth) continue;
    const provider = service.providerId ?? service.name;
    providers.set(provider, {
      provider,
      displayName: service.name,
      source: 'service',
      oauth: service.oauth,
      tokenKey: service.tokenKey,
      providerId: provider,
      notes: ['Configured through .goodvibes/tui/services.json'],
    });
  }

  return [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}
