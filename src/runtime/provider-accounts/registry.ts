import { listBuiltinSubscriptionProviders } from '../../config/subscription-providers.ts';
import { resolveApiKeys } from '../../config/index.ts';
import type { SecretsManager } from '../../config/secrets.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { ProviderRuntimeMetadata } from '@pellux/goodvibes-sdk/platform/providers/interface';
import { decodeJwtPayload } from '@pellux/goodvibes-sdk/platform/runtime/auth/oauth-core';
import type { ServiceRegistry } from '../../config/service-registry.ts';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';

export type ProviderAuthRoute = 'api-key' | 'subscription' | 'service-oauth' | 'unconfigured';
export type ProviderAuthFreshness = 'healthy' | 'expiring' | 'expired' | 'pending' | 'unconfigured';

export interface ProviderUsageWindow {
  readonly label: string;
  readonly detail: string;
}

export interface ProviderRouteRecord {
  readonly route: Exclude<ProviderAuthRoute, 'unconfigured'>;
  readonly usable: boolean;
  readonly freshness: ProviderAuthFreshness;
  readonly detail: string;
  readonly issues: readonly string[];
}

export interface ProviderAccountRecord {
  readonly providerId: string;
  readonly active: boolean;
  readonly modelCount: number;
  readonly configured: boolean;
  readonly oauthReady: boolean;
  readonly pendingLogin: boolean;
  readonly availableRoutes: readonly ProviderAuthRoute[];
  readonly preferredRoute: ProviderAuthRoute;
  readonly activeRoute: ProviderAuthRoute;
  readonly activeRouteReason: string;
  readonly authFreshness: ProviderAuthFreshness;
  readonly fallbackRoute?: ProviderAuthRoute;
  readonly fallbackRisk?: string;
  readonly expiresAt?: number;
  readonly tokenType?: string;
  readonly notes: readonly string[];
  readonly usageWindows: readonly ProviderUsageWindow[];
  readonly issues: readonly string[];
  readonly recommendedActions: readonly string[];
  readonly routeRecords: readonly ProviderRouteRecord[];
}

export interface ProviderAccountSnapshot {
  readonly capturedAt: number;
  readonly providers: readonly ProviderAccountRecord[];
  readonly configuredCount: number;
  readonly issueCount: number;
}

export interface ProviderAccountSnapshotDeps {
  readonly providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getCurrentModel' | 'getRegistered' | 'describeRuntime'>;
  readonly serviceRegistry: Pick<ServiceRegistry, 'getAll' | 'inspect'>;
  readonly subscriptionManager: Pick<SubscriptionManager, 'list' | 'listPending' | 'get' | 'getPending'>;
  readonly secretsManager: Pick<SecretsManager, 'get'>;
}

function builtinWindowsForProvider(providerId: string): readonly ProviderUsageWindow[] {
  if (providerId === 'openai') {
    return [
      { label: '5-hour window', detail: 'Subscription-backed Codex access may be constrained by rolling 5-hour usage limits.' },
      { label: '1-week window', detail: 'Subscription-backed Codex access may also be constrained by a rolling weekly limit.' },
    ];
  }
  return [];
}

function classifyRoutes(input: {
  providerId: string;
  hasApiKey: boolean;
  hasSubscription: boolean;
  hasServiceOAuth: boolean;
}): readonly ProviderAuthRoute[] {
  const routes: ProviderAuthRoute[] = [];
  if (input.hasApiKey) routes.push('api-key');
  if (input.hasSubscription) routes.push('subscription');
  if (input.hasServiceOAuth) routes.push('service-oauth');
  if (routes.length === 0) routes.push('unconfigured');
  return routes;
}

function determineActiveRoute(routes: readonly ProviderAuthRoute[]): ProviderAuthRoute {
  if (routes.includes('subscription')) return 'subscription';
  if (routes.includes('service-oauth')) return 'service-oauth';
  if (routes.includes('api-key')) return 'api-key';
  return 'unconfigured';
}

function determineSubscriptionFreshness(expiresAt?: number): ProviderAuthFreshness {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return 'healthy';
  if (expiresAt <= Date.now()) return 'expired';
  if (expiresAt <= Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
  return 'healthy';
}

export async function buildProviderAccountSnapshot(
  deps: ProviderAccountSnapshotDeps,
): Promise<ProviderAccountSnapshot> {
  const providerRegistry = deps.providerRegistry;
  const allModels = providerRegistry.listModels();
  const currentModel = providerRegistry.getCurrentModel?.();
  const apiKeys = await resolveApiKeys(deps.secretsManager);
  const subscriptions = deps.subscriptionManager;
  const builtinSubscriptionProviders = new Set(listBuiltinSubscriptionProviders().map((entry) => entry.provider));
  const serviceRegistry = deps.serviceRegistry;
  const serviceConfigs = serviceRegistry.getAll();
  const services = Object.values(serviceConfigs);
  const serviceInspections = await Promise.all(Object.keys(serviceConfigs).map(async (name) => ({
    name,
    inspection: await serviceRegistry.inspect(name),
  })));
  const serviceOauthByProvider = new Map<string, { configured: boolean; usable: boolean }>();
  for (const { inspection } of serviceInspections) {
    if (!inspection || inspection.config.authType !== 'oauth') continue;
    const providerId = inspection.config.providerId ?? inspection.config.name;
    const existing = serviceOauthByProvider.get(providerId);
    serviceOauthByProvider.set(providerId, {
      configured: true,
      usable: Boolean(existing?.usable || inspection.hasPrimaryCredential),
    });
  }
  const providerIds = new Set<string>([
    ...allModels.map((model) => model.provider),
    ...Object.keys(apiKeys),
    ...subscriptions.list().map((entry) => entry.provider),
    ...subscriptions.listPending().map((entry) => entry.provider),
    ...services.map((service) => service.providerId ?? service.name),
    ...builtinSubscriptionProviders,
  ]);
  const providers = await Promise.all([...providerIds]
    .sort((a, b) => a.localeCompare(b))
    .map(async (providerId) => {
      const subscription = subscriptions.get(providerId);
      const pending = subscriptions.getPending(providerId);
      const jwtPayload = subscription ? decodeJwtPayload(subscription.accessToken) : null;
      const serviceOauth = serviceOauthByProvider.get(providerId);
      let runtimeMetadata: ProviderRuntimeMetadata | undefined;
      try {
        runtimeMetadata = await providerRegistry.describeRuntime(providerId) ?? undefined;
      } catch {
        runtimeMetadata = undefined;
      }
      const subscriptionFreshness = subscription ? determineSubscriptionFreshness(subscription.expiresAt) : 'unconfigured';
      const routes = classifyRoutes({
        providerId,
        hasApiKey: providerId in apiKeys,
        hasSubscription: subscription != null,
        hasServiceOAuth: Boolean(serviceOauth?.configured),
      });
      const usableRoutes = classifyRoutes({
        providerId,
        hasApiKey: providerId in apiKeys,
        hasSubscription: subscription != null && subscriptionFreshness !== 'expired',
        hasServiceOAuth: Boolean(serviceOauth?.usable),
      });
      const issues: string[] = [];
      const notes: string[] = [];
      const recommendedActions: string[] = [];
      const routeRecords: ProviderRouteRecord[] = [];
      const preferredRoute = determineActiveRoute(routes);
      const activeRoute = determineActiveRoute(usableRoutes);
      let activeRouteReason = 'No usable auth route is configured for this provider.';
      let authFreshness: ProviderAuthFreshness = 'unconfigured';

      if (providerId in apiKeys) {
        routeRecords.push({
          route: 'api-key',
          usable: true,
          freshness: 'healthy',
          detail: 'Ambient API key is available for direct provider access.',
          issues: [],
        });
      }

      if (subscription) {
        const subscriptionIssues: string[] = [];
        if (subscriptionFreshness === 'expired') {
          subscriptionIssues.push('Stored subscription session is expired.');
        } else if (subscriptionFreshness === 'expiring') {
          subscriptionIssues.push('Stored subscription session expires within 24 hours.');
        }
        routeRecords.push({
          route: 'subscription',
          usable: subscriptionFreshness !== 'expired',
          freshness: pending ? 'pending' : subscriptionFreshness,
          detail: subscription.overrideAmbientApiKeys
            ? 'Subscription route is configured to override ambient API-key resolution.'
            : 'Subscription route is configured, but ambient API keys remain active unless selected explicitly.',
          issues: subscriptionIssues,
        });
      }

      if (serviceOauth?.configured) {
        const serviceOauthIssues = serviceOauth.usable
          ? []
          : ['Service OAuth path is configured but has no usable stored credential.'];
        routeRecords.push({
          route: 'service-oauth',
          usable: serviceOauth.usable,
          freshness: serviceOauth.usable ? 'healthy' : 'unconfigured',
          detail: serviceOauth.usable
            ? 'Service OAuth credential is available for this provider.'
            : 'Service OAuth metadata exists, but the credential path is incomplete.',
          issues: serviceOauthIssues,
        });
      }

      if (routes.includes('subscription') && routes.includes('api-key')) {
        issues.push('Provider has both subscription and API-key auth paths; routing must remain explicit.');
        recommendedActions.push('Review provider routing before switching models or auth paths.');
      }
      if (subscriptionFreshness === 'expired') {
        issues.push('Stored subscription session is expired and needs refresh.');
        recommendedActions.push(`Refresh or replace the ${providerId} subscription session before relying on it.`);
      } else if (subscriptionFreshness === 'expiring') {
        issues.push('Stored subscription session is nearing expiry.');
        recommendedActions.push(`Renew or verify the ${providerId} subscription session soon to avoid route drift.`);
      }
      if (pending) {
        issues.push('Provider has a pending OAuth login that has not been completed yet.');
        recommendedActions.push(`Finish /subscription login ${providerId} finish <code> or clear the pending login.`);
      }
      if (serviceOauth?.configured && !serviceOauth.usable) {
        issues.push('Service OAuth is configured but missing a usable credential.');
        recommendedActions.push(`Repair service OAuth credentials for ${providerId} in /services or /settings.`);
      }
      if (!routes.includes('api-key') && !routes.includes('subscription') && !routes.includes('service-oauth')) {
        recommendedActions.push(`Configure an API key or OAuth-backed route for ${providerId}.`);
      } else if (activeRoute === 'unconfigured') {
        recommendedActions.push(`No currently usable auth path exists for ${providerId}; repair the preferred route.`);
      }
      if (preferredRoute !== 'unconfigured' && activeRoute !== preferredRoute && activeRoute !== 'unconfigured') {
        issues.push(`Preferred ${preferredRoute} path is unavailable; current usable route is ${activeRoute}.`);
        recommendedActions.push(`Review why ${providerId} fell back from ${preferredRoute} to ${activeRoute}.`);
      }
      if (jwtPayload && typeof jwtPayload['iss'] === 'string') {
        notes.push(`issuer=${jwtPayload['iss']}`);
      }
      if (runtimeMetadata?.notes) {
        notes.push(...runtimeMetadata.notes);
      }
      if (runtimeMetadata?.usage?.notes) {
        notes.push(...runtimeMetadata.usage.notes);
      }
      if (runtimeMetadata?.policy?.notes) {
        notes.push(...runtimeMetadata.policy.notes);
      }
      if (builtinSubscriptionProviders.has(providerId)) {
        notes.push('Built-in subscription adapter available.');
        if (!subscription && !pending) {
          recommendedActions.push(`Start /subscription login ${providerId} start to enable the built-in subscription path.`);
        }
      }
      for (const route of runtimeMetadata?.auth?.routes ?? []) {
        if (!route.usable || !route.configured) {
          for (const hint of route.repairHints ?? []) {
            recommendedActions.push(hint);
          }
        }
      }
      if (pending) {
        authFreshness = 'pending';
        activeRouteReason = 'OAuth login is pending completion.';
      } else if (activeRoute === 'subscription') {
        authFreshness = subscriptionFreshness;
        activeRouteReason = subscriptionFreshness === 'expiring'
          ? 'Subscription route is active but nearing expiry.'
          : 'Subscription route is the preferred usable path.';
      } else if (activeRoute === 'service-oauth') {
        authFreshness = 'healthy';
        activeRouteReason = preferredRoute === 'subscription'
          ? 'Subscription route is unavailable, so service OAuth is the current usable path.'
          : 'Service OAuth is the current usable route.';
      } else if (activeRoute === 'api-key') {
        authFreshness = 'healthy';
        activeRouteReason = preferredRoute === 'subscription'
          ? 'Subscription route is unavailable, so ambient API-key access is the current usable path.'
          : preferredRoute === 'service-oauth'
            ? 'Service OAuth is unavailable, so ambient API-key access is the current usable path.'
            : 'Ambient API-key access is the current usable route.';
      }
      const fallbackRoute = preferredRoute !== activeRoute && activeRoute !== 'unconfigured'
        ? activeRoute
        : undefined;
      const fallbackRisk = fallbackRoute
        ? `Provider is using ${fallbackRoute} because the preferred ${preferredRoute} path is not currently usable.`
        : undefined;
      if (!pending && routes.includes('subscription') && !subscription && builtinSubscriptionProviders.has(providerId)) {
        authFreshness = 'unconfigured';
      }
      return Object.freeze({
        providerId,
        active: currentModel?.provider === providerId,
        modelCount: allModels.filter((model) => model.provider === providerId).length,
        configured: routes[0] !== 'unconfigured',
        oauthReady: builtinSubscriptionProviders.has(providerId) || Boolean(serviceOauth?.configured),
        pendingLogin: pending != null,
        availableRoutes: routes,
        preferredRoute,
        activeRoute,
        activeRouteReason,
        authFreshness,
        ...(fallbackRoute ? { fallbackRoute } : {}),
        ...(fallbackRisk ? { fallbackRisk } : {}),
        ...(subscription?.expiresAt ? { expiresAt: subscription.expiresAt } : {}),
        ...(subscription?.tokenType ? { tokenType: subscription.tokenType } : {}),
        notes,
        usageWindows: builtinWindowsForProvider(providerId),
        issues,
        recommendedActions: [...new Set(recommendedActions)],
        routeRecords,
      }) satisfies ProviderAccountRecord;
    }));

  return Object.freeze({
    capturedAt: Date.now(),
    providers,
    configuredCount: providers.filter((provider) => provider.configured).length,
    issueCount: providers.reduce((sum, provider) => sum + provider.issues.length, 0),
  });
}
