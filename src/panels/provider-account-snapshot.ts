import { listBuiltinSubscriptionProviders } from '../config/subscription-providers.ts';
import type {
  ProviderAccountInspectionQuery,
} from '../runtime/ui-service-queries.ts';

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

export interface ProviderAccountSnapshotDeps extends ProviderAccountInspectionQuery {}

export interface ProviderAccountSnapshotQuery {
  readonly loadSnapshot: () => Promise<ProviderAccountSnapshot>;
}

export function createProviderAccountSnapshotQuery(
  deps: ProviderAccountSnapshotDeps,
): ProviderAccountSnapshotQuery {
  return {
    loadSnapshot: () => buildProviderAccountSnapshot(deps),
  };
}

function determineActiveRoute(routes: readonly ProviderAuthRoute[]): ProviderAuthRoute {
  if (routes.includes('subscription')) return 'subscription';
  if (routes.includes('service-oauth')) return 'service-oauth';
  if (routes.includes('api-key')) return 'api-key';
  return 'unconfigured';
}

function isExpired(expiresAt?: number): boolean {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function determineFreshness(input: {
  readonly hasSubscription: boolean;
  readonly expiresAt?: number;
  readonly pending: boolean;
  readonly hasServiceOAuth: boolean;
  readonly hasApiKey: boolean;
}): ProviderAuthFreshness {
  if (input.hasSubscription) {
    if (isExpired(input.expiresAt)) return 'expired';
    if (input.expiresAt && input.expiresAt <= Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
    if (input.pending) return 'pending';
    return 'healthy';
  }
  if (input.hasServiceOAuth || input.hasApiKey) return 'healthy';
  return 'unconfigured';
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

export async function buildProviderAccountSnapshot(
  deps: ProviderAccountSnapshotDeps,
): Promise<ProviderAccountSnapshot> {
  const models = deps.providerModels.listModels();
  const services = deps.services.getAll();
  const subscriptions = deps.subscriptions;
  const builtinSubscriptionProviders = new Set(listBuiltinSubscriptionProviders().map((entry) => entry.provider));
  const serviceInspections = await Promise.all(Object.keys(services).map(async (name) => ({
    name,
    inspection: await deps.services.inspect(name),
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
    ...models.map((model) => model.provider),
    ...Object.keys(services),
    ...subscriptions.list().map((entry) => entry.provider),
    ...subscriptions.listPending().map((entry) => entry.provider),
    ...builtinSubscriptionProviders,
  ]);

  const providers = await Promise.all([...providerIds].sort((a, b) => a.localeCompare(b)).map(async (providerId) => {
    const subscription = subscriptions.get(providerId);
    const pending = subscriptions.getPending(providerId);
    const serviceConfig = Object.values(services).find((entry) => (entry.providerId ?? entry.name) === providerId) ?? null;
    const serviceOauth = serviceOauthByProvider.get(providerId);
    const hasApiKey = Boolean(serviceConfig?.tokenKey && deps.environment.hasEnvironmentVariable(serviceConfig.tokenKey));
    const hasSubscription = subscription != null;
    const hasServiceOAuth = Boolean(serviceOauth?.configured);
    const routes: ProviderAuthRoute[] = [];
    if (hasApiKey) routes.push('api-key');
    if (hasSubscription) routes.push('subscription');
    if (hasServiceOAuth) routes.push('service-oauth');
    if (routes.length === 0) routes.push('unconfigured');

    const usableRoutes: Exclude<ProviderAuthRoute, 'unconfigured'>[] = [];
    if (hasApiKey) usableRoutes.push('api-key');
    if (hasSubscription && !isExpired(subscription.expiresAt)) usableRoutes.push('subscription');
    if (hasServiceOAuth) usableRoutes.push('service-oauth');

    const activeRoute = determineActiveRoute(usableRoutes.length > 0 ? usableRoutes : routes);
    const preferredRoute = determineActiveRoute(routes);
    const freshness = determineFreshness({
      hasSubscription,
      expiresAt: subscription?.expiresAt,
      pending: pending != null,
      hasServiceOAuth,
      hasApiKey,
    });
    const usageWindows = builtinWindowsForProvider(providerId);
    const routeRecords: ProviderRouteRecord[] = [];

    if (hasApiKey) {
      routeRecords.push({
        route: 'api-key',
        usable: true,
        freshness: 'healthy',
        detail: 'Ambient API key is available for direct provider access.',
        issues: [],
      });
    }
    if (hasSubscription) {
      routeRecords.push({
        route: 'subscription',
        usable: !isExpired(subscription?.expiresAt),
        freshness: pending ? 'pending' : isExpired(subscription?.expiresAt) ? 'expired' : 'healthy',
        detail: subscription?.overrideAmbientApiKeys
          ? 'Subscription route is configured to override ambient API-key resolution.'
          : 'Subscription route is configured, but ambient API keys remain active unless selected explicitly.',
        issues: isExpired(subscription?.expiresAt) ? ['Stored subscription session is expired.'] : [],
      });
    }
    if (hasServiceOAuth) {
      routeRecords.push({
        route: 'service-oauth',
        usable: true,
        freshness: 'healthy',
        detail: 'Service OAuth credential is available for this provider.',
        issues: [],
      });
    }

    const issues: string[] = [];
    const notes: string[] = [`${models.filter((model) => model.provider === providerId).length} model${models.filter((model) => model.provider === providerId).length === 1 ? '' : 's'} registered`];
    if (serviceConfig) notes.push(`service config: ${serviceConfig.authType}`);
    const recommendedActions: string[] = [];
    if (routes.length === 1 && routes[0] === 'unconfigured') {
      issues.push('Provider has no configured auth route.');
      recommendedActions.push(`Configure API keys, subscriptions, or service OAuth for ${providerId}.`);
    }
    if (hasSubscription && isExpired(subscription?.expiresAt)) {
      issues.push('Stored subscription session is expired and needs refresh.');
      recommendedActions.push(`Refresh or replace the ${providerId} subscription session before relying on it.`);
    } else if (hasSubscription && subscription?.expiresAt && subscription.expiresAt <= Date.now() + 24 * 60 * 60 * 1000) {
      issues.push('Stored subscription session is nearing expiry.');
      recommendedActions.push(`Renew or verify the ${providerId} subscription session soon to avoid route drift.`);
    }
    if (pending) {
      issues.push('Provider has a pending OAuth login that has not been completed yet.');
      recommendedActions.push(`Finish /subscription login ${providerId} finish <code> or clear the pending login.`);
    }
    if (hasSubscription && hasApiKey) {
      issues.push('Provider has both subscription and API-key auth paths; routing must remain explicit.');
      recommendedActions.push('Review provider routing before switching models or auth paths.');
    }
    if (hasServiceOAuth && !serviceOauth?.usable) {
      issues.push('Service OAuth is configured but missing a usable credential.');
      recommendedActions.push(`Repair service OAuth credentials for ${providerId} in /services or /settings.`);
    }

    return {
      providerId,
      active: activeRoute !== 'unconfigured',
      modelCount: models.filter((model) => model.provider === providerId).length,
      configured: hasApiKey || hasSubscription || hasServiceOAuth || models.some((model) => model.provider === providerId),
      oauthReady: Boolean(serviceConfig?.oauth),
      pendingLogin: Boolean(pending),
      availableRoutes: routes,
      preferredRoute,
      activeRoute,
      activeRouteReason: activeRoute === 'subscription'
        ? 'Subscription route is currently preferred.'
        : activeRoute === 'service-oauth'
          ? 'Service OAuth route is currently preferred.'
          : activeRoute === 'api-key'
            ? 'Ambient API-key route is currently preferred.'
            : 'No usable auth route is configured for this provider.',
      authFreshness: freshness,
      fallbackRoute: activeRoute !== preferredRoute ? preferredRoute : undefined,
      fallbackRisk: hasSubscription && hasApiKey ? 'Both subscription and API key are present; check route priority.' : undefined,
      expiresAt: subscription?.expiresAt,
      tokenType: subscription?.tokenType,
      notes,
      usageWindows,
      issues,
      recommendedActions,
      routeRecords,
    };
  }));

  return {
    capturedAt: Date.now(),
    providers,
    configuredCount: providers.filter((provider) => provider.configured).length,
    issueCount: providers.reduce((sum, provider) => sum + provider.issues.length, 0),
  };
}
