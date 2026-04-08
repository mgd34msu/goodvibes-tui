import { getSecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { getSubscriptionManager, type ProviderSubscription } from '../../config/subscriptions.ts';
import { getSubscriptionProviderConfig } from '../../config/subscription-providers.ts';

export type AuthInspectionFreshness = 'healthy' | 'expiring' | 'expired' | 'pending' | 'available' | 'unconfigured';

export interface ProviderAuthInspection {
  readonly provider: string;
  readonly configured: boolean;
  readonly source?: 'service' | 'builtin';
  readonly freshness: AuthInspectionFreshness;
  readonly redirectUri?: string;
  readonly callbackMode: 'local' | 'manual';
  readonly localCallback?: string;
  readonly activeSubscription: boolean;
  readonly pendingLogin: boolean;
  readonly overrideAmbientApiKeys: boolean;
  readonly tokenType?: string;
  readonly expiresAt?: number;
  readonly issues: readonly string[];
  readonly nextActions: readonly string[];
}

export interface AuthInspectionSnapshot {
  readonly generatedAt: number;
  readonly secretKeyCount: number;
  readonly activeSubscriptions: number;
  readonly pendingSubscriptions: number;
  readonly providers: readonly ProviderAuthInspection[];
}

function determineFreshness(subscription: ProviderSubscription | null, pending: boolean, configured: boolean): AuthInspectionFreshness {
  if (pending) return 'pending';
  if (!subscription) return configured ? 'available' : 'unconfigured';
  if (typeof subscription.expiresAt !== 'number' || !Number.isFinite(subscription.expiresAt)) return 'healthy';
  if (subscription.expiresAt <= Date.now()) return 'expired';
  if (subscription.expiresAt <= Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
  return 'healthy';
}

export async function inspectProviderAuth(provider: string): Promise<ProviderAuthInspection> {
  const services = new ServiceRegistry();
  const manager = getSubscriptionManager();
  const service = services.get(provider);
  const resolved = getSubscriptionProviderConfig(provider, service);
  const subscription = manager.get(provider);
  const pending = manager.getPending(provider);
  const configured = resolved != null;
  const freshness = determineFreshness(subscription, pending != null, configured);
  const issues: string[] = [];
  const nextActions: string[] = [];

  if (!configured) {
    issues.push('No provider OAuth configuration is available.');
    nextActions.push(`Add provider OAuth config or a built-in adapter before using /subscription login ${provider} start.`);
  }
  if (freshness === 'expired') {
    issues.push('Stored provider session is expired.');
    nextActions.push(`Refresh or replace the stored ${provider} session.`);
  } else if (freshness === 'expiring') {
    issues.push('Stored provider session expires within 24 hours.');
    nextActions.push(`Verify or renew the stored ${provider} session soon.`);
  } else if (freshness === 'pending') {
    issues.push('OAuth login has started but has not been completed.');
    nextActions.push(`Finish /subscription login ${provider} finish <code-or-url>.`);
  } else if (freshness === 'available') {
    nextActions.push(`Start /subscription login ${provider} start to create a stored session.`);
  }

  const callbackMode = resolved?.oauth.localCallback ? 'local' : 'manual';
  const localCallback = resolved?.oauth.localCallback
    ? `${resolved.oauth.localCallback.host ?? 'localhost'}:${resolved.oauth.localCallback.port ?? 80}${resolved.oauth.localCallback.path ?? '/'}`
    : undefined;

  return Object.freeze({
    provider,
    configured,
    ...(resolved ? { source: resolved.source } : {}),
    freshness,
    ...(resolved ? { redirectUri: resolved.oauth.redirectUri } : {}),
    callbackMode,
    ...(localCallback ? { localCallback } : {}),
    activeSubscription: subscription != null,
    pendingLogin: pending != null,
    overrideAmbientApiKeys: subscription?.overrideAmbientApiKeys ?? false,
    ...(subscription?.tokenType ? { tokenType: subscription.tokenType } : {}),
    ...(subscription?.expiresAt ? { expiresAt: subscription.expiresAt } : {}),
    issues,
    nextActions,
  });
}

export async function buildAuthInspectionSnapshot(): Promise<AuthInspectionSnapshot> {
  const secrets = await getSecretsManager().list();
  const subscriptions = getSubscriptionManager();
  const services = new ServiceRegistry().getAll();
  const providerIds = new Set<string>([
    ...Object.values(services)
      .filter((service) => service.authType === 'oauth' && service.oauth)
      .map((service) => service.providerId ?? service.name),
    ...subscriptions.list().map((entry) => entry.provider),
    ...subscriptions.listPending().map((entry) => entry.provider),
  ]);
  const providers = await Promise.all([...providerIds].sort((a, b) => a.localeCompare(b)).map((provider) => inspectProviderAuth(provider)));
  return Object.freeze({
    generatedAt: Date.now(),
    secretKeyCount: secrets.length,
    activeSubscriptions: subscriptions.list().length,
    pendingSubscriptions: subscriptions.listPending().length,
    providers,
  });
}
