// ---------------------------------------------------------------------------
// Daemon operator-surface integration root.
//
// `registerDaemonOperatorSurfaces(ctx)` is the single call the runtime services
// layer (src/runtime/services.ts) makes to publish every daemon operator
// surface against the shared GatewayMethodCatalog. Each surface module owns its
// own method declarations; this module only composes their register entry
// points and aggregates teardown.
//
// Surfaces wired here:
//   - channels.routing.*        (routing/register.ts)
//   - channels.inbox.list +     (triage/integration.ts -> registerTriagedInbox,
//     inbox.triage.*             which registers the inbox surface through a
//                                catalog proxy that overlays triage scores, plus
//                                the inbox.triage.list / .tag methods)
//   - channels.drafts.*         (channels/drafts/register.ts)
//   - calendar.* (CalDAV)       (calendar/register.ts)
//   - email.*                   (email/register.ts)
//   - remote.peers.register +   (remote/register.ts) — the register method is
//     remote dispatch adapter    published on the catalog and the dispatch
//                                adapter for the existing remote.peers.invoke
//                                route is exposed on the returned handle.
//
// Every surface initializes its stores lazily (on first method invocation), so
// this composition is synchronous and never blocks daemon bootstrap on disk I/O.
// The remote peer-registry store is the one async initializer; it is kicked off
// in the background and the dispatch adapter awaits it implicitly on first use.
// ---------------------------------------------------------------------------

import type { OperatorContext, Unregister } from './types.ts';
import { registerRoutingMethods, type RoutingRegistration } from '../channels/routing/register.ts';
import { createInboxRouteResolver } from '../channels/routing/inbox-bridge.ts';
import { registerTriagedInbox } from '../triage/integration.ts';
import { registerDraftsMethods } from '../channels/drafts/register.ts';
import { registerCalendarMethods } from '../calendar/register.ts';
import { registerEmailMethods } from '../email/register.ts';
import {
  createRemoteSurface,
  type RemoteSurface,
  type RemoteInvokeAdapter,
} from '../remote/register.ts';

/**
 * Handles returned to the integrator. `unregister()` tears every surface down in
 * reverse registration order. `remoteDispatch` is the invoke adapter the daemon
 * server attaches to the existing `remote.peers.invoke` route; `remoteSurface`
 * exposes the underlying peer registry / dispatcher for advanced wiring.
 */
export interface DaemonOperatorSurfaces {
  /** Tear down every registered operator surface (reverse order). */
  readonly unregister: Unregister;
  /** Routing registration handle (store + resolver reuse). */
  readonly routing: RoutingRegistration;
  /** Remote execution surface (peer registry + dispatcher). */
  readonly remoteSurface: RemoteSurface;
  /** Dispatch adapter for the existing remote.peers.invoke route. */
  readonly remoteDispatch: RemoteInvokeAdapter;
}

/**
 * Register every daemon operator surface against the catalog in `ctx`.
 *
 * Synchronous: surfaces defer their disk I/O until first invocation. The only
 * async initializer (the remote peer registry) is started in the background and
 * its failure is logged rather than thrown so daemon bootstrap is never blocked.
 */
export function registerDaemonOperatorSurfaces(ctx: OperatorContext): DaemonOperatorSurfaces {
  const teardowns: Unregister[] = [];
  const pushTeardown = (fn: Unregister): void => {
    teardowns.push(fn);
  };

  // Aggregate teardown invoked in reverse registration order; best-effort so one
  // failing teardown never strands the rest.
  const unregister: Unregister = () => {
    for (let i = teardowns.length - 1; i >= 0; i -= 1) {
      try {
        teardowns[i]?.();
      } catch (error) {
        ctx.logger.warn('operator surface teardown failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  try {
    // 1. Routing control plane (channels.routing.list/assign/delete).
    const routing = registerRoutingMethods(ctx);
    pushTeardown(routing);

    // 2. Triaged inbox: channels.inbox.list (triage-enriched) + inbox.triage.*.
    //    Bridge routing's resolver into the inbox so inbound items resolve their
    //    routeId via the channel<->profile bindings (exact > surface-only >
    //    wildcard). The resolver is best-effort: a null lookup leaves the item
    //    unrouted (offline/default fallback) and never throws.
    pushTeardown(
      registerTriagedInbox(ctx, {
        inbox: { resolveRouteId: createInboxRouteResolver(routing.resolver) },
      }),
    );

    // 3. Channel drafts mirror (channels.drafts.list/get/save/delete).
    pushTeardown(registerDraftsMethods(ctx));

    // 4. Calendar (CalDAV) operator methods.
    pushTeardown(registerCalendarMethods(ctx));

    // 5. Email operator surface (read/list/draft/send).
    pushTeardown(registerEmailMethods(ctx));

    // 6. Remote execution surface: publish remote.peers.register and build the
    //    dispatch adapter for the existing remote.peers.invoke route.
    const remoteSurface = createRemoteSurface(ctx);
    const unregisterRemoteMethod = remoteSurface.register();
    const remoteDispatch = remoteSurface.registerDispatch();
    pushTeardown(() => {
      try {
        unregisterRemoteMethod();
      } finally {
        remoteSurface.close();
      }
    });
    // Background-init the peer registry store; never block bootstrap on it.
    void remoteSurface.init().catch((error: unknown) => {
      ctx.logger.error('remote surface peer-registry init failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

    return { unregister, routing, remoteSurface, remoteDispatch };
  } catch (error) {
    // Roll back any surfaces registered before the failure.
    unregister();
    throw error;
  }
}
