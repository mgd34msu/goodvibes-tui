import type { ProviderAuthFreshness } from '@pellux/goodvibes-sdk/platform/runtime/provider-accounts/registry';
import { listBuiltinSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config/subscription-providers';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import type { ServiceInspectionQuery } from '../runtime/ui-service-queries.ts';
import type { SubscriptionEntry } from './settings-modal-types.ts';

export function buildSubscriptionEntries(
  manager: SubscriptionManager | null,
  serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'> | null,
): SubscriptionEntry[] {
  if (!manager) return [];

  const services = serviceRegistry?.getAll() ?? {};
  const providers = new Map<string, SubscriptionEntry>();
  const builtinProviders = new Set(listBuiltinSubscriptionProviders().map((builtin) => builtin.provider));

  for (const provider of builtinProviders) {
    providers.set(provider, {
      provider,
      state: 'available',
      oauthConfigured: true,
      preferredRoute: 'subscription',
      activeRoute: 'unconfigured',
      authFreshness: 'unconfigured',
      routeReason: 'Built-in subscription adapter is available, but no active subscription session is stored yet.',
      nextActions: [`Use /subscription login ${provider} start to begin browser sign-in.`],
    });
  }

  for (const service of Object.values(services)) {
    if (service.authType !== 'oauth' || !service.oauth) continue;
    const provider = service.providerId ?? service.name;
    providers.set(provider, {
      provider,
      state: 'available',
      oauthConfigured: true,
      preferredRoute: 'subscription',
      activeRoute: providers.get(provider)?.activeRoute ?? 'unconfigured',
      authFreshness: providers.get(provider)?.authFreshness ?? 'unconfigured',
      routeReason: providers.get(provider)?.routeReason ?? 'OAuth metadata is configured for this provider.',
      nextActions: providers.get(provider)?.nextActions ?? [`Use /subscription login ${provider} start to begin browser sign-in.`],
    });
  }

  for (const pending of manager.listPending()) {
    providers.set(pending.provider, {
      provider: pending.provider,
      state: 'pending',
      oauthConfigured: providers.get(pending.provider)?.oauthConfigured ?? false,
      preferredRoute: 'subscription',
      activeRoute: 'unconfigured',
      authFreshness: 'pending',
      routeReason: 'OAuth login is pending completion for this provider.',
      nextActions: [`Finish /subscription login ${pending.provider} finish <code> to activate this session.`],
    });
  }

  for (const subscription of manager.list()) {
    const freshness = determineFreshness(subscription.expiresAt);
    const issues = freshness === 'expired'
      ? ['Stored subscription session is expired and needs refresh.']
      : freshness === 'expiring'
        ? ['Stored subscription session expires within 24 hours.']
        : [];
    const nextActions = freshness === 'expired'
      ? [`Refresh or replace the ${subscription.provider} subscription session.`]
      : freshness === 'expiring'
        ? [`Verify or renew the ${subscription.provider} subscription session soon.`]
        : [];
    providers.set(subscription.provider, {
      provider: subscription.provider,
      state: 'active',
      tokenType: subscription.tokenType,
      expiresAt: subscription.expiresAt,
      oauthConfigured: providers.get(subscription.provider)?.oauthConfigured ?? builtinProviders.has(subscription.provider),
      activeRoute: freshness === 'expired' ? 'unconfigured' : 'subscription',
      preferredRoute: 'subscription',
      authFreshness: freshness,
      routeReason: subscription.overrideAmbientApiKeys
        ? 'Subscription route overrides ambient API-key resolution for this provider.'
        : 'Subscription route is stored for supported flows without automatically replacing ambient API-key resolution.',
      issues,
      nextActions,
    });
  }

  return [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

function determineFreshness(expiresAt?: number): ProviderAuthFreshness {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return 'healthy';
  if (expiresAt <= Date.now()) return 'expired';
  if (expiresAt <= Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
  return 'healthy';
}
