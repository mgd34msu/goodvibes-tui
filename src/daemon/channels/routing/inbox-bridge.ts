// ---------------------------------------------------------------------------
// Inbox <-> Routing resolver bridge.
//
// The inbox provider adapters expose a best-effort `RouteResolver` seam
// (provider-adapter.ts): given an inbound item's `{ provider, fromDigest, kind }`
// they ask "which daemon route binding handles this item?" and stamp the answer
// onto `item.routeId` when one resolves. The routing control plane owns the
// channel<->profile bindings and exposes a `RoutingResolver` whose
// `getProfileForChannel(surfaceKind, routeId?)` applies the canonical resolution
// order:
//
//   1. exact     — surfaceKind AND routeId both match
//   2. surface   — surfaceKind matches, route has no routeId
//   3. wildcard  — a route with surfaceKind === 'any' (no routeId)
//
// This module bridges the two shapes. The bridge maps an inbound item's
// `provider` to the routing `surfaceKind` and forwards an optional `routeId`
// refinement; `fromDigest`/`kind` are NOT used as routing keys (the routing
// store is keyed by surfaceKind + optional routeId only, never by sender digest
// or message kind — see RoutingChannelRoute). When no binding matches the
// resolver returns null and the bridge yields `undefined`, so the adapter falls
// back to leaving the item unrouted (offline/default behaviour intact). The
// bridge NEVER throws: route-util.ts already swallows resolver errors, and the
// underlying resolver is a pure in-memory lookup.
// ---------------------------------------------------------------------------

import type { RouteResolver } from '../inbox/provider-adapter.ts';
import type { RoutingResolver } from './routing-resolver.ts';

/**
 * Optional input fields the bridge consults for routeId refinement. The
 * published {@link RouteResolver} input does not currently carry a routeId, so
 * surface-only / wildcard resolution is the effective path today; should the
 * inbox seam grow a routeId (e.g. a Slack channel id or email mailbox tag) the
 * bridge will pass it through to enable exact (surfaceKind+routeId) matches
 * without any further change here.
 */
type RouteResolverInput = Parameters<RouteResolver>[0] & { routeId?: unknown };

/**
 * Build a {@link RouteResolver} backed by the routing surface's
 * {@link RoutingResolver}. Maps `provider -> surfaceKind` and forwards an
 * optional `routeId` refinement, then applies the canonical
 * exact > surface-only > wildcard resolution order via
 * `getProfileForChannel`. Returns the resolved profileId (the daemon route
 * binding) or `undefined` when nothing matches.
 */
export function createInboxRouteResolver(resolver: RoutingResolver): RouteResolver {
  return (input: RouteResolverInput): string | undefined => {
    const surfaceKind = typeof input.provider === 'string' ? input.provider : '';
    if (surfaceKind.length === 0) return undefined;
    const routeId = typeof input.routeId === 'string' && input.routeId.length > 0 ? input.routeId : undefined;
    // getProfileForChannel applies exact (surfaceKind+routeId) > surface-only >
    // wildcard ('any') and returns null when no assignment matches.
    const profileId = resolver.getProfileForChannel(surfaceKind, routeId);
    return profileId ?? undefined;
  };
}
