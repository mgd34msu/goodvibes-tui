// Channel-to-Profile Routing Control Plane — surface barrel.
//
// Integration wires this surface by calling `register(ctx)` (or
// `registerRoutingMethods(ctx)` when it needs the returned store/resolver).
// The inbox surface reuses `resolveProfile` / `createRoutingResolver` for
// identical online/offline routing resolution.

export { register, registerRoutingMethods } from './register.ts';
export type {
  RoutingRegistration,
  RoutingListInput,
  RoutingListOutput,
  RoutingAssignInput,
  RoutingAssignOutput,
  RoutingDeleteInput,
  RoutingDeleteOutput,
} from './register.ts';

export {
  RouteStore,
  parseChannelId,
  buildChannelId,
} from './route-store.ts';
export type {
  RoutingChannelRoute,
  ParsedChannelId,
  RouteUpsertInput,
  RouteUpsertResult,
  RouteListFilter,
} from './route-store.ts';

export {
  resolveProfile,
  createRoutingResolver,
  WILDCARD_SURFACE,
} from './routing-resolver.ts';
export type { RoutingResolver } from './routing-resolver.ts';

export { createInboxRouteResolver } from './inbox-bridge.ts';
