import { describe, expect, test } from 'bun:test';
import { createInboxRouteResolver } from '../../../daemon/channels/routing/inbox-bridge.ts';
import {
  createRoutingResolver,
  WILDCARD_SURFACE,
  type RoutingResolver,
} from '../../../daemon/channels/routing/routing-resolver.ts';
import type { RoutingChannelRoute } from '../../../daemon/channels/routing/route-store.ts';
import type { RouteResolver } from '../../../daemon/channels/inbox/provider-adapter.ts';

// ---------------------------------------------------------------------------
// SEAM 2 — inbox <-> routing resolver bridge.
//
// The bridge maps an inbound item's provider -> surfaceKind (and an optional
// routeId refinement) onto the routing resolver, which applies the canonical
// resolution order: exact (surfaceKind+routeId) > surface-only > wildcard. A
// no-match yields undefined (never throws), preserving the offline/default
// fallback in the adapters.
// ---------------------------------------------------------------------------

function route(partial: Partial<RoutingChannelRoute> & { surfaceKind: string; profileId: string }): RoutingChannelRoute {
  return {
    assignmentId: `${partial.surfaceKind}:${partial.routeId ?? ''}:${partial.profileId}`,
    channelId: partial.routeId ? `${partial.surfaceKind}:${partial.routeId}` : partial.surfaceKind,
    surfaceKind: partial.surfaceKind,
    profileId: partial.profileId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(partial.routeId !== undefined ? { routeId: partial.routeId } : {}),
    ...(partial.label !== undefined ? { label: partial.label } : {}),
  };
}

// A resolver backed by a fixed in-memory route set (no store/disk needed).
function resolverFor(routes: RoutingChannelRoute[]): RoutingResolver {
  return createRoutingResolver({ listAll: () => routes } as unknown as Parameters<typeof createRoutingResolver>[0]);
}

// Helper to call a RouteResolver with provider as surfaceKind plus an optional
// routeId refinement on the input.
async function resolve(
  bridge: RouteResolver,
  provider: string,
  routeId?: string,
): Promise<string | undefined> {
  const input = {
    provider,
    fromDigest: 'deadbeefdeadbeef',
    kind: 'dm' as const,
    ...(routeId !== undefined ? { routeId } : {}),
  };
  return (await bridge(input as Parameters<RouteResolver>[0])) ?? undefined;
}

describe('createInboxRouteResolver resolution order', () => {
  test('exact match (surfaceKind + routeId) wins over surface-only and wildcard', async () => {
    const bridge = createInboxRouteResolver(
      resolverFor([
        route({ surfaceKind: WILDCARD_SURFACE, profileId: 'wild' }),
        route({ surfaceKind: 'slack', profileId: 'slack-default' }),
        route({ surfaceKind: 'slack', routeId: 'C123', profileId: 'slack-exact' }),
      ]),
    );
    expect(await resolve(bridge, 'slack', 'C123')).toBe('slack-exact');
  });

  test('surface-only match when no exact routeId binding exists', async () => {
    const bridge = createInboxRouteResolver(
      resolverFor([
        route({ surfaceKind: WILDCARD_SURFACE, profileId: 'wild' }),
        route({ surfaceKind: 'slack', profileId: 'slack-default' }),
      ]),
    );
    // routeId supplied but no exact binding -> falls back to surface-only.
    expect(await resolve(bridge, 'slack', 'C999')).toBe('slack-default');
    // no routeId supplied at all -> surface-only.
    expect(await resolve(bridge, 'slack')).toBe('slack-default');
  });

  test('wildcard (surfaceKind === "any") match when surface has no binding', async () => {
    const bridge = createInboxRouteResolver(
      resolverFor([route({ surfaceKind: WILDCARD_SURFACE, profileId: 'wild' })]),
    );
    expect(await resolve(bridge, 'discord')).toBe('wild');
    expect(await resolve(bridge, 'email', 'mailbox-1')).toBe('wild');
  });

  test('no match returns undefined (never throws, offline/default fallback)', async () => {
    const bridge = createInboxRouteResolver(
      resolverFor([route({ surfaceKind: 'slack', profileId: 'slack-default' })]),
    );
    expect(await resolve(bridge, 'discord')).toBeUndefined();
    expect(await resolve(bridge, 'discord', 'X')).toBeUndefined();
  });

  test('empty provider yields undefined', async () => {
    const bridge = createInboxRouteResolver(
      resolverFor([route({ surfaceKind: WILDCARD_SURFACE, profileId: 'wild' })]),
    );
    expect(await resolve(bridge, '')).toBeUndefined();
  });

  test('null profile from resolver is normalized to undefined', async () => {
    // A resolver that always returns null (no bindings at all).
    const bridge = createInboxRouteResolver(resolverFor([]));
    expect(await resolve(bridge, 'slack', 'C1')).toBeUndefined();
  });
});
