/**
 * Composition root for the daemon handler layer — the only module that
 * `src/runtime/services.ts` imports. It assembles every surface (routing,
 * inbox+triage, drafts, calendar, email, remote) onto the SDK gateway catalog
 * and returns a single teardown plus the cross-surface handles the runtime
 * needs (routing resolver, the remote `DistributedRuntimeRouteService` the SDK
 * facade injects, and the `remote.peers.invoke` dispatch adapter).
 *
 * Surfaces are provided by the caller as `SurfaceRegister` functions so this
 * foundation module stays free of import cycles and does not author any SDK
 * descriptor or schema. Registration order is fixed; teardown runs in reverse.
 */
import type { DistributedRuntimeRouteService } from './contracts.ts';
import type { HandlerContext, SurfaceRegister } from './context.ts';
import type { Unregister } from './register.ts';

/** Routing surface handle: teardown plus the resolver other surfaces consume. */
export interface RoutingRegistration {
  readonly unregister: Unregister;
  /** Resolve an inbound channel target to a profile id (exact → wildcard → null). */
  readonly resolveProfileId: (surfaceKind: string, routeId?: string) => string | null;
}

/** Adapter the runtime wires into the published `remote.peers.invoke` route. */
export interface RemoteInvokeAdapter {
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

/** Remote surface handle: the host service the SDK facade injects + its teardown. */
export interface RemoteSurfaceRegistration {
  readonly unregister: Unregister;
  readonly service: DistributedRuntimeRouteService;
  readonly dispatch: RemoteInvokeAdapter;
}

/** Aggregate result returned to the runtime for teardown and cross-surface wiring. */
export interface DaemonHandlerSurfaces {
  readonly unregister: Unregister;
  readonly routing: RoutingRegistration;
  readonly remoteSurface: { readonly service: DistributedRuntimeRouteService };
  readonly remoteDispatch: RemoteInvokeAdapter;
}

/**
 * The surface implementations the runtime supplies. Each builds its stores and
 * attaches handlers to the SDK catalog via `registerCatalogHandler(s)`.
 *
 * Order of composition (and reverse teardown) is enforced by
 * `registerDaemonHandlers`: routing → inbox(+triage) → drafts → calendar →
 * email → remote.
 */
export interface DaemonHandlerSurfaceProviders {
  /** channels.routing.* — returns the resolver consumed by the inbox surface. */
  readonly registerRouting: (ctx: HandlerContext) => RoutingRegistration;
  /** channels.inbox.list (triage-decorated) + inbox.triage.* (daemon-internal). */
  readonly registerInbox: (ctx: HandlerContext, routing: RoutingRegistration) => Unregister;
  /** channels.drafts.* */
  readonly registerDrafts: SurfaceRegister;
  /** remote.peers.* — supplies the host DistributedRuntimeRouteService + dispatch adapter. */
  readonly registerRemote: (ctx: HandlerContext) => RemoteSurfaceRegistration;
}

/**
 * Compose all daemon handler surfaces onto the gateway catalog held by `ctx`.
 * Returns a single teardown (reverse order, best-effort) and the handles the
 * runtime must expose: the routing registration, the remote service the SDK
 * facade injects into `DaemonRemoteRouteContext.distributedRuntime`, and the
 * remote invoke dispatch adapter.
 */
export function registerDaemonHandlers(
  ctx: HandlerContext,
  providers: DaemonHandlerSurfaceProviders,
): DaemonHandlerSurfaces {
  const teardowns: Unregister[] = [];

  const routing = providers.registerRouting(ctx);
  teardowns.push(routing.unregister);

  teardowns.push(providers.registerInbox(ctx, routing));
  teardowns.push(providers.registerDrafts(ctx));
  // calendar.* and email.* are NOT registered here any more. Both are served
  // by the SDK (control-plane/routes/{calendar,email}.ts over the platform
  // CalDAV/Google and IMAP/SMTP implementations), registered through
  // registerGatewayVerbGroups in runtime/services.ts. This product used to
  // carry its own handlers for the same descriptor ids and, registering later,
  // won — two implementations behind one path, which is the drift the hoist
  // exists to end.

  const remote = providers.registerRemote(ctx);
  teardowns.push(remote.unregister);

  // Idempotent: teardown is reachable from more than one shutdown path now that
  // the runtime disposal scope owns it, and the surfaces underneath are not all
  // safe to unwind twice — the inbox surface closes a SQLite handle, which a
  // second pass would close again inside a floating promise (an unhandled
  // rejection, not a caught one). Running once is also simply the honest
  // meaning of "release these surfaces".
  let torn = false;
  const unregister: Unregister = () => {
    if (torn) return;
    torn = true;
    for (let i = teardowns.length - 1; i >= 0; i -= 1) {
      try {
        teardowns[i]!();
      } catch (error) {
        ctx.logger.warn('daemon handler surface teardown failed', { error });
      }
    }
  };

  return {
    unregister,
    routing,
    remoteSurface: { service: remote.service },
    remoteDispatch: remote.dispatch,
  };
}
