// ---------------------------------------------------------------------------
// provider-health-routes.ts
//
// Single-source auth-route posture for the provider console (merge of
// the retired accounts panel into provider-health). All route data flows from
// ProviderRuntimeInspectionQuery.inspectAll() snapshots; this module only
// normalizes descriptors (synthesizing them for providers that do not declare
// routes) and derives the active/preferred route, freshness, issues, and
// repair hints. It intentionally keeps the full descriptor list so the panel
// can render per-route detail (absorbed from the accounts panel) instead of a
// lossy summary record.
// ---------------------------------------------------------------------------

import type { ProviderAuthRouteDescriptor } from '@pellux/goodvibes-sdk/platform/providers';

export type ProviderPanelAuthRoute = ProviderAuthRouteDescriptor['route'] | 'unconfigured';
export type ProviderPanelAuthFreshness = NonNullable<ProviderAuthRouteDescriptor['freshness']> | 'unconfigured';

/** Auth metadata shape carried by ProviderRuntimeInspectionQuery snapshots. */
export interface ProviderRuntimeAuthMetadata {
  readonly mode: 'api-key' | 'oauth' | 'anonymous' | 'none';
  readonly configured: boolean;
  readonly detail?: string;
  readonly envVars?: readonly string[];
  readonly routes?: readonly ProviderAuthRouteDescriptor[];
}

/** Minimal inspectAll() snapshot shape consumed by the provider console. */
export interface ProviderRuntimeSnapshotLike {
  readonly providerId: string;
  readonly active: boolean;
  readonly modelCount: number;
  readonly runtime: {
    readonly auth?: ProviderRuntimeAuthMetadata;
  };
}

/** Derived per-provider account/auth posture for console rendering. */
export interface ProviderAccountPosture {
  readonly providerId: string;
  readonly active: boolean;
  readonly modelCount: number;
  /** Normalized route descriptors (declared or synthesized). */
  readonly routes: readonly ProviderAuthRouteDescriptor[];
  readonly activeRoute: ProviderPanelAuthRoute;
  readonly preferredRoute: ProviderPanelAuthRoute;
  readonly activeRouteReason: string;
  readonly authFreshness: ProviderPanelAuthFreshness;
  /** True when any route is expiring (or already expired/pending). */
  readonly expiringSoon: boolean;
  readonly issues: readonly string[];
  /** Repair hints sourced from ProviderAuthRouteDescriptor.repairHints. */
  readonly repairHints: readonly string[];
}

const AUTH_ROUTE_PRIORITY: readonly ProviderPanelAuthRoute[] = [
  'subscription-oauth',
  'service-oauth',
  'secret-ref',
  'api-key',
  'anonymous',
  'none',
  'unconfigured',
] as const;

export function routePriority(route: ProviderPanelAuthRoute): number {
  const priority = AUTH_ROUTE_PRIORITY.indexOf(route);
  return priority >= 0 ? priority : AUTH_ROUTE_PRIORITY.length;
}

/**
 * Synthesize route descriptors for providers that only declare legacy auth
 * metadata. Keeps the console on a single ProviderAuthRouteDescriptor shape.
 */
export function buildSyntheticAuthRoutes(
  auth: ProviderRuntimeAuthMetadata | undefined,
): readonly ProviderAuthRouteDescriptor[] {
  if (!auth) return [];
  switch (auth.mode) {
    case 'none':
      return [{
        route: 'none',
        label: 'No auth required',
        configured: true,
        usable: true,
        freshness: 'healthy',
        detail: auth.detail ?? 'Provider does not require interactive credentials.',
      }];
    case 'anonymous':
      return [{
        route: 'anonymous',
        label: 'Anonymous / local access',
        configured: auth.configured,
        usable: auth.configured,
        freshness: auth.configured ? 'healthy' : 'unconfigured',
        detail: auth.detail ?? 'Provider can be used without stored credentials.',
      }];
    case 'api-key':
      return [{
        route: 'api-key',
        label: 'Ambient API key',
        configured: auth.configured,
        usable: auth.configured,
        freshness: auth.configured ? 'healthy' : 'unconfigured',
        detail: auth.detail ?? 'Provider expects a configured API key.',
        ...(auth.envVars?.length ? { envVars: auth.envVars } : {}),
        ...(auth.envVars?.length
          ? { repairHints: [`Set ${auth.envVars.join(' or ')} in the environment or secrets store.`] }
          : {}),
      }];
    case 'oauth':
      return [{
        route: 'service-oauth',
        label: 'OAuth session',
        configured: auth.configured,
        usable: auth.configured,
        freshness: auth.configured ? 'healthy' : 'unconfigured',
        detail: auth.detail ?? 'Provider expects an OAuth-backed credential.',
        repairHints: ['Refresh or repair the provider OAuth session before relying on it.'],
      }];
    default:
      return [];
  }
}

export function isRouteUsable(route: ProviderAuthRouteDescriptor): boolean {
  return route.usable ?? route.configured;
}

function pickRoute(
  routes: readonly ProviderAuthRouteDescriptor[],
): ProviderAuthRouteDescriptor | null {
  if (routes.length === 0) return null;
  return [...routes].sort((left, right) => routePriority(left.route) - routePriority(right.route))[0] ?? null;
}

/**
 * Derive the console's account/auth posture for one inspectAll() snapshot.
 * This is the only route-posture derivation in the TUI (the retired accounts
 * panel's parallel snapshot model was deleted with).
 */
export function buildAccountPosture(snapshot: ProviderRuntimeSnapshotLike): ProviderAccountPosture {
  const auth = snapshot.runtime.auth;
  const routes = auth?.routes?.length ? auth.routes : buildSyntheticAuthRoutes(auth);
  const configuredRoutes = routes.filter((route) => route.configured);
  const usableRoutes = routes.filter(isRouteUsable);
  const preferredRoute = pickRoute(configuredRoutes.length > 0 ? configuredRoutes : routes);
  const activeRoute = pickRoute(usableRoutes.length > 0 ? usableRoutes : (preferredRoute ? [preferredRoute] : []));
  const activeRouteId: ProviderPanelAuthRoute = activeRoute?.route ?? 'unconfigured';
  const preferredRouteId: ProviderPanelAuthRoute = preferredRoute?.route ?? activeRouteId;
  const authFreshness: ProviderPanelAuthFreshness =
    activeRoute?.freshness ?? (activeRouteId === 'none' ? 'healthy' : 'unconfigured');

  const issueSet = new Set<string>();
  const hintSet = new Set<string>();

  if (activeRouteId === 'unconfigured' && auth?.mode !== 'none') {
    issueSet.add('Provider has no usable auth route configured.');
  }

  for (const route of routes) {
    if (route.freshness === 'expired') {
      issueSet.add(route.detail ?? `${route.label} is expired.`);
    } else if (route.freshness === 'pending') {
      issueSet.add(route.detail ?? `${route.label} is pending completion.`);
    } else if (route.configured && !isRouteUsable(route)) {
      issueSet.add(route.detail ?? `${route.label} is configured but not currently usable.`);
    }
    for (const hint of route.repairHints ?? []) {
      if (hint.trim().length > 0) hintSet.add(hint);
    }
  }

  if (usableRoutes.length > 1) {
    issueSet.add('Multiple auth routes are simultaneously usable; verify route priority before switching providers.');
  }
  if (issueSet.size > 0 && hintSet.size === 0 && activeRouteId !== 'none') {
    hintSet.add(`Review ${snapshot.providerId} provider credentials and routing metadata.`);
  }

  const expiringSoon = authFreshness === 'expiring'
    || authFreshness === 'expired'
    || authFreshness === 'pending'
    || routes.some((route) => route.freshness === 'expiring' || route.freshness === 'expired' || route.freshness === 'pending');

  return {
    providerId: snapshot.providerId,
    active: snapshot.active,
    modelCount: snapshot.modelCount,
    routes,
    activeRoute: activeRouteId,
    preferredRoute: preferredRouteId,
    activeRouteReason: activeRoute?.detail
      ?? auth?.detail
      ?? (activeRouteId === 'none'
        ? 'Provider does not require interactive credentials.'
        : 'No usable auth route is configured for this provider.'),
    authFreshness,
    expiringSoon,
    issues: [...issueSet],
    repairHints: [...hintSet],
  };
}
