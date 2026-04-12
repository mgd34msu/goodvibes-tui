import { SecretsManager } from '../config/secrets.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import { listBuiltinSubscriptionProviders } from '../config/subscription-providers.ts';
import { SubscriptionManager } from '../config/subscriptions.ts';
import type { ProviderAuthRouteDescriptor } from './interface.ts';

export interface StandardProviderAuthOptions {
  readonly providerId: string;
  readonly apiKeyEnvVars?: readonly string[];
  readonly secretKeys?: readonly string[];
  readonly serviceNames?: readonly string[];
  readonly subscriptionProviderId?: string;
  readonly allowAnonymous?: boolean;
  readonly anonymousConfigured?: boolean;
  readonly anonymousDetail?: string;
}

export interface StandardProviderAuthRouteDeps {
  readonly secretsManager?: Pick<SecretsManager, 'listDetailed'>;
  readonly serviceRegistry?: Pick<ServiceRegistry, 'getAll' | 'inspect'>;
  readonly subscriptionManager?: Pick<SubscriptionManager, 'get' | 'getPending'>;
}

function determineFreshness(expiresAt?: number): 'healthy' | 'expiring' | 'expired' {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return 'healthy';
  if (expiresAt <= Date.now()) return 'expired';
  if (expiresAt <= Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
  return 'healthy';
}

export async function buildStandardProviderAuthRoutes(
  options: StandardProviderAuthOptions,
  deps: StandardProviderAuthRouteDeps = {},
): Promise<readonly ProviderAuthRouteDescriptor[]> {
  const secrets = deps.secretsManager ?? new SecretsManager();
  const serviceRegistry = deps.serviceRegistry ?? new ServiceRegistry();
  const subscriptionManager = deps.subscriptionManager ?? new SubscriptionManager();
  const secretKeys = [...new Set([...(options.secretKeys ?? []), ...(options.apiKeyEnvVars ?? [])])];
  const detailedSecrets = await secrets.listDetailed();
  const matchingSecretRecords = detailedSecrets.filter((record) => secretKeys.includes(record.key) && record.source !== 'env');
  const hasSecretRef = matchingSecretRecords.some((record) => Boolean(record.refSource));
  const hasStoredDirectSecret = matchingSecretRecords.some((record) => !record.refSource);
  const hasEnv = (options.apiKeyEnvVars ?? []).some((envVar) => {
    const value = process.env[envVar];
    return typeof value === 'string' && value.length > 0;
  });
  const builtinSubscriptions = new Set(listBuiltinSubscriptionProviders().map((entry) => entry.provider));
  const subscriptionProviderId = options.subscriptionProviderId ?? options.providerId;
  const subscription = subscriptionManager.get(subscriptionProviderId);
  const pendingSubscription = subscriptionManager.getPending(subscriptionProviderId);
  const hasSubscriptionRoute = builtinSubscriptions.has(subscriptionProviderId) || subscription != null || pendingSubscription != null;
  const subscriptionFreshness = pendingSubscription
    ? 'pending'
    : subscription
      ? determineFreshness(subscription.expiresAt)
      : 'unconfigured';
  const serviceNames = options.serviceNames && options.serviceNames.length > 0
    ? [...new Set(options.serviceNames)]
    : Object.values(serviceRegistry.getAll())
      .filter((service) => service.authType === 'oauth' && (service.providerId ?? service.name) === options.providerId)
      .map((service) => service.name);
  const serviceInspections = await Promise.all(serviceNames.map(async (name) => ({
    name,
    inspection: await serviceRegistry.inspect(name),
  })));
  const hasServiceConfig = serviceInspections.some(({ inspection }) => inspection?.config.authType === 'oauth');
  const hasUsableServiceOauth = serviceInspections.some(({ inspection }) => Boolean(inspection?.hasPrimaryCredential));

  const routes: ProviderAuthRouteDescriptor[] = [];
  if ((options.apiKeyEnvVars?.length ?? 0) > 0 || secretKeys.length > 0) {
    routes.push({
      route: 'api-key',
      label: 'Ambient API key',
      configured: hasEnv || hasStoredDirectSecret,
      usable: hasEnv || hasStoredDirectSecret,
      freshness: hasEnv || hasStoredDirectSecret ? 'healthy' : 'unconfigured',
      detail: hasEnv
        ? 'Environment-backed API key is available.'
        : hasStoredDirectSecret
          ? 'GoodVibes secret store contains a direct API key value.'
          : 'No direct API key is configured.',
      ...(options.apiKeyEnvVars?.length ? { envVars: options.apiKeyEnvVars } : {}),
      ...(secretKeys.length > 0 ? { secretKeys } : {}),
      repairHints: [
        ...(options.apiKeyEnvVars?.length
          ? [`Set ${options.apiKeyEnvVars.join(' or ')} or store one of those keys in /secrets.`]
          : ['Store the provider API key in /secrets or the process environment.']),
      ],
    });
    routes.push({
      route: 'secret-ref',
      label: 'SecretRef-backed API key',
      configured: hasSecretRef,
      usable: hasSecretRef,
      freshness: hasSecretRef ? 'healthy' : 'unconfigured',
      detail: hasSecretRef
        ? 'A GoodVibes SecretRef is configured for this provider.'
        : 'No SecretRef-backed credential is configured.',
      ...(secretKeys.length > 0 ? { secretKeys } : {}),
      repairHints: [
        'Use /secrets link <KEY> <secret-ref> to attach Bitwarden, Vaultwarden, BWS, or another supported SecretRef.',
      ],
    });
  }

  if (hasServiceConfig || serviceNames.length > 0) {
    routes.push({
      route: 'service-oauth',
      label: 'Service OAuth',
      configured: hasServiceConfig,
      usable: hasUsableServiceOauth,
      freshness: hasUsableServiceOauth ? 'healthy' : 'unconfigured',
      detail: hasUsableServiceOauth
        ? 'A service-owned OAuth credential is available for this provider.'
        : 'Service OAuth metadata exists, but the credential path is incomplete.',
      ...(serviceNames.length > 0 ? { serviceNames } : {}),
      repairHints: ['Repair the provider service credential in /services or the settings surface.'],
    });
  }

  if (hasSubscriptionRoute) {
    routes.push({
      route: 'subscription-oauth',
      label: 'Subscription OAuth',
      configured: subscription != null || pendingSubscription != null || builtinSubscriptions.has(subscriptionProviderId),
      usable: subscriptionFreshness !== 'expired' && subscriptionFreshness !== 'unconfigured',
      freshness: subscriptionFreshness,
      detail: pendingSubscription
        ? 'Subscription OAuth login is pending completion.'
        : subscription
          ? 'A stored subscription OAuth session is available for this provider.'
          : 'A built-in subscription OAuth adapter is available, but no session is stored yet.',
      providerId: subscriptionProviderId,
      repairHints: [`Use /subscription login ${subscriptionProviderId} start or refresh the stored subscription session.`],
    });
  }

  if (options.allowAnonymous) {
    routes.push({
      route: 'anonymous',
      label: 'Anonymous / local access',
      configured: Boolean(options.anonymousConfigured),
      usable: Boolean(options.anonymousConfigured),
      freshness: options.anonymousConfigured ? 'healthy' : 'unconfigured',
      detail: options.anonymousDetail ?? 'This provider can be used without an API key.',
    });
  }

  if (routes.length === 0) {
    return [{
      route: 'none',
      label: 'No auth route declared',
      configured: false,
      usable: false,
      freshness: 'unconfigured',
      detail: 'The provider did not declare any runtime auth routes.',
    }];
  }

  return routes;
}
