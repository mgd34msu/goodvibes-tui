import type { RoutingChannelRoute } from './route-store.ts';
import { RouteStore } from './route-store.ts';

/** Wildcard surfaceKind that matches any surface as a last resort. */
export const WILDCARD_SURFACE = 'any';

/**
 * Pure resolution of a profileId from a set of routes, applying the EXACT same
 * order as the agent-side `getProfileForChannel()` so offline and online
 * routing produce identical results:
 *
 *   1. exact match    — surfaceKind AND routeId both match
 *   2. surface-only   — surfaceKind matches, route has no routeId
 *   3. wildcard       — a route with surfaceKind === 'any' (no routeId)
 *
 * Returns the matching profileId, or `null` when nothing matches.
 */
export function resolveProfile(
  routes: readonly RoutingChannelRoute[],
  surfaceKind: string,
  routeId?: string,
): string | null {
  const surface = typeof surfaceKind === 'string' ? surfaceKind.trim() : '';
  if (surface.length === 0) return null;
  const route = typeof routeId === 'string' && routeId.trim().length > 0 ? routeId.trim() : undefined;

  // 1. Exact match (surfaceKind + routeId). Only attempted when a routeId is
  //    supplied by the caller.
  if (route !== undefined) {
    const exact = routes.find(
      (entry) => entry.surfaceKind === surface && entry.routeId === route,
    );
    if (exact) return exact.profileId;
  }

  // 2. Surface-only match (surfaceKind, no routeId on the route).
  const surfaceOnly = routes.find(
    (entry) => entry.surfaceKind === surface && (entry.routeId === undefined || entry.routeId === ''),
  );
  if (surfaceOnly) return surfaceOnly.profileId;

  // 3. Wildcard match (surfaceKind === 'any', no routeId).
  const wildcard = routes.find(
    (entry) => entry.surfaceKind === WILDCARD_SURFACE && (entry.routeId === undefined || entry.routeId === ''),
  );
  if (wildcard) return wildcard.profileId;

  return null;
}

/** Resolver bound to a live {@link RouteStore}. */
export interface RoutingResolver {
  /**
   * Resolve the profileId that should handle an inbound message on the given
   * surface/route, applying the agent resolution order. Returns null when no
   * assignment matches (caller falls back to the default session).
   */
  getProfileForChannel(surfaceKind: string, routeId?: string): string | null;
  /** Alias of {@link getProfileForChannel}, exported for inbox surface reuse. */
  resolveProfile(surfaceKind: string, routeId?: string): string | null;
}

/**
 * Create a resolver backed by a {@link RouteStore}. The store must already be
 * initialized; each call reads the current route set so assignments take effect
 * immediately after a mutation.
 */
export function createRoutingResolver(store: RouteStore): RoutingResolver {
  const resolve = (surfaceKind: string, routeId?: string): string | null =>
    resolveProfile(store.listAll(), surfaceKind, routeId);
  return {
    getProfileForChannel: resolve,
    resolveProfile: resolve,
  };
}
