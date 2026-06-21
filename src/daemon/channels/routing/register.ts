import {
  declareOperatorMethods,
  OperatorError,
  type OperatorContext,
  type OperatorHandler,
  type OperatorMethodDescriptor,
  type SurfaceRegister,
  type Unregister,
} from '../../operator/index.ts';
import { RouteStore, type RoutingChannelRoute } from './route-store.ts';
import { createRoutingResolver, type RoutingResolver } from './routing-resolver.ts';

// ---------------------------------------------------------------------------
// Wire contracts (request/response bodies) for the channels.routing.* methods.
//
// These interfaces and the JSON Schemas below mirror the handoff's literal
// Input/Output blocks exactly. Per the handoff's "Confirmation / Effect
// Semantics" note, `channels.routing.assign` and `channels.routing.delete` are
// control-plane mutations that additionally require confirmation. That
// confirmation is NOT part of the documented Input body shape: it is a
// framework confirm-guard envelope flag (`confirm: true` on the raw request
// body, plus `explicitUserRequest` in the call metadata) enforced by
// `assertConfirmed` inside `declareOperatorMethods` when `descriptor.confirm`
// is set. We therefore keep `confirm` out of the advertised contract here and
// rely on the framework guard, so the wire Input stays a faithful match for the
// handoff rather than a strict superset.
// ---------------------------------------------------------------------------

export interface RoutingListInput {
  profileId?: string;
  surfaceKind?: string;
}
export interface RoutingListOutput {
  routes: RoutingChannelRoute[];
}

export interface RoutingAssignInput {
  channelId: string;
  profileId: string;
  label?: string;
}
export interface RoutingAssignOutput {
  assignmentId: string;
  channelId: string;
  profileId: string;
  created: boolean;
}

export interface RoutingDeleteInput {
  assignmentId: string;
}
export interface RoutingDeleteOutput {
  deleted: boolean;
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// JSON Schemas (advertised on the catalog descriptors).
// ---------------------------------------------------------------------------

const CHANNEL_ROUTE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['assignmentId', 'channelId', 'surfaceKind', 'profileId', 'createdAt', 'updatedAt'],
  properties: {
    assignmentId: { type: 'string' },
    channelId: { type: 'string' },
    surfaceKind: { type: 'string' },
    routeId: { type: 'string' },
    profileId: { type: 'string' },
    label: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

const LIST_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    profileId: { type: 'string' },
    surfaceKind: { type: 'string' },
  },
};

const LIST_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['routes'],
  properties: {
    routes: { type: 'array', items: CHANNEL_ROUTE_SCHEMA },
  },
};

const ASSIGN_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['channelId', 'profileId'],
  properties: {
    channelId: { type: 'string' },
    profileId: { type: 'string' },
    label: { type: 'string' },
  },
};

const ASSIGN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['assignmentId', 'channelId', 'profileId', 'created'],
  properties: {
    assignmentId: { type: 'string' },
    channelId: { type: 'string' },
    profileId: { type: 'string' },
    created: { type: 'boolean' },
  },
};

const DELETE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['assignmentId'],
  properties: {
    assignmentId: { type: 'string' },
  },
};

const DELETE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['deleted'],
  properties: {
    deleted: { type: 'boolean' },
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Handle returned by {@link registerRoutingMethods}: tears down the catalog
 * methods and closes the underlying SQLite store. Also exposes the resolver so
 * integration / the inbox surface can reuse routing resolution without going
 * through the catalog.
 */
export interface RoutingRegistration extends Unregister {
  (): void;
  readonly store: RouteStore;
  readonly resolver: RoutingResolver;
}

/**
 * Register the channel-to-profile routing control-plane methods against the
 * operator catalog:
 *   - channels.routing.list   (read-only)
 *   - channels.routing.assign (confirmed local-state mutation)
 *   - channels.routing.delete (confirmed local-state mutation)
 *
 * The store is lazily initialized on first method invocation (the SurfaceRegister
 * contract is synchronous), so registration never blocks on disk I/O.
 */
export function registerRoutingMethods(ctx: OperatorContext): RoutingRegistration {
  const store = new RouteStore({ workingDirectory: ctx.workingDirectory });
  const resolver = createRoutingResolver(store);

  let initPromise: Promise<void> | null = null;
  const ensureInit = async (): Promise<void> => {
    if (!initPromise) {
      initPromise = store.init().catch((error) => {
        // Allow a later invocation to retry initialization.
        initPromise = null;
        throw error;
      });
    }
    await initPromise;
  };

  const listHandler: OperatorHandler<RoutingListInput, RoutingListOutput> = async (input) => {
    await ensureInit();
    const body = asObject(input.body);
    const routes = store.list({
      profileId: optionalString(body.profileId),
      surfaceKind: optionalString(body.surfaceKind),
    });
    return { routes };
  };

  const assignHandler: OperatorHandler<RoutingAssignInput, RoutingAssignOutput> = async (input) => {
    await ensureInit();
    const body = asObject(input.body);
    const channelId = optionalString(body.channelId);
    const profileId = optionalString(body.profileId);
    if (channelId === undefined) {
      throw new OperatorError('channelId is required', 'ROUTING_INVALID_CHANNEL_ID', 400);
    }
    if (profileId === undefined) {
      throw new OperatorError('profileId is required', 'ROUTING_INVALID_PROFILE_ID', 400);
    }
    const { route, created } = await store.upsert({
      channelId,
      profileId,
      label: optionalString(body.label),
    });
    ctx.logger.info('channels.routing.assign', {
      assignmentId: route.assignmentId,
      channelId: route.channelId,
      profileId: route.profileId,
      created,
      principalId: input.context.principalId,
    });
    return {
      assignmentId: route.assignmentId,
      channelId: route.channelId,
      profileId: route.profileId,
      created,
    };
  };

  const deleteHandler: OperatorHandler<RoutingDeleteInput, RoutingDeleteOutput> = async (input) => {
    await ensureInit();
    const body = asObject(input.body);
    const assignmentId = optionalString(body.assignmentId);
    if (assignmentId === undefined) {
      throw new OperatorError('assignmentId is required', 'ROUTING_INVALID_ASSIGNMENT_ID', 400);
    }
    const deleted = await store.delete(assignmentId);
    ctx.logger.info('channels.routing.delete', {
      assignmentId,
      deleted,
      principalId: input.context.principalId,
    });
    return { deleted };
  };

  const listDescriptor: OperatorMethodDescriptor = {
    id: 'channels.routing.list',
    title: 'List channel routes',
    description: 'List channel-to-profile routing assignments, optionally filtered by profile or surface.',
    category: 'channels',
    source: 'daemon',
    access: 'authenticated',
    transport: ['ws', 'internal'],
    scopes: ['channels:routing:read'],
    effect: 'read-only',
    inputSchema: LIST_INPUT_SCHEMA,
    outputSchema: LIST_OUTPUT_SCHEMA,
  };

  const assignDescriptor: OperatorMethodDescriptor = {
    id: 'channels.routing.assign',
    title: 'Assign channel to profile',
    description: 'Create or update the profile that handles inbound messages on a channel.',
    category: 'channels',
    source: 'daemon',
    access: 'authenticated',
    transport: ['ws', 'internal'],
    scopes: ['channels:routing:write'],
    effect: 'local-state-mutation',
    confirm: true,
    inputSchema: ASSIGN_INPUT_SCHEMA,
    outputSchema: ASSIGN_OUTPUT_SCHEMA,
  };

  const deleteDescriptor: OperatorMethodDescriptor = {
    id: 'channels.routing.delete',
    title: 'Delete channel route',
    description: 'Remove a channel-to-profile routing assignment by assignmentId.',
    category: 'channels',
    source: 'daemon',
    access: 'authenticated',
    transport: ['ws', 'internal'],
    scopes: ['channels:routing:write'],
    effect: 'local-state-mutation',
    confirm: true,
    inputSchema: DELETE_INPUT_SCHEMA,
    outputSchema: DELETE_OUTPUT_SCHEMA,
  };

  const unregister = declareOperatorMethods(ctx, [
    { descriptor: listDescriptor, handler: listHandler as OperatorHandler<unknown, unknown> },
    { descriptor: assignDescriptor, handler: assignHandler as OperatorHandler<unknown, unknown> },
    { descriptor: deleteDescriptor, handler: deleteHandler as OperatorHandler<unknown, unknown> },
  ]);

  // Build the callable teardown handle, then attach the store/resolver as
  // read-only properties so callers (integration, the inbox surface) can reuse
  // routing resolution without going through the catalog.
  const teardown = (): void => {
    unregister();
    store.close();
  };
  return Object.assign(teardown, { store, resolver }) as RoutingRegistration;
}

/** SurfaceRegister contract entry point (integration calls this). */
export const register: SurfaceRegister = (ctx) => registerRoutingMethods(ctx);
