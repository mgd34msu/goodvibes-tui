/**
 * spine-adoption.ts — wiring this surface's session and memory spines to the
 * daemon it adopted, over the SDK's adoption policy.
 *
 * ── What moved to the SDK, and what stays here ────────────────────────────
 *
 * The SDK's `@pellux/goodvibes-sdk/platform/runtime/client` now owns WHEN the
 * wire comes up and goes down: idempotent per base URL, torn down on a
 * change, the one-time legacy-store fold. This module owns WHAT the wire is —
 * this terminal's own `createHttpTransport` + `createTuiSpineTransport` +
 * `createTuiMemorySpineTransport`, injected as the SDK's `connect(baseUrl,
 * authToken)` callback — because building the actual HTTP client is the same
 * connection-resolution concern the verb caller already keeps product-side.
 *
 * `activation: 'adopt-on-status'` is passed explicitly: this terminal gates
 * adoption on its boot discovery probe's `external` verdict (it can render
 * "no daemon" honestly), rather than wiring live-immediately the moment it is
 * handed a base URL.
 *
 * ── What crosses the wire ──────────────────────────────────────────────────
 *
 * Session IDENTITY, not session execution. Per Phase A of the daemon split the
 * conversation itself still runs here; what the daemon holds is the register —
 * which sessions exist, which surface is live on each, and the inputs queued
 * against them. Concretely, on adoption this wires:
 *
 *   - `sessions.register` / `sessions.close` — the identity mirror, deliberately
 *     fire-and-forget so a slow daemon never shows up in a keystroke.
 *   - `sessions.inputs.list` / `sessions.inputs.deliver` — the inbound steer
 *     path, so a message another surface queued for THIS session lands in the
 *     turn machinery here and is acknowledged on the wire.
 *   - `sessions.list` — the cross-surface union the panels read, interval-
 *     refreshed and served synchronously.
 *   - the memory spine's wire transport, folded into the same handler by the
 *     SDK — this module's own `syncMemorySpineToHostStatus` call is retired;
 *     supplying `memoryTransport` in the bundle and `memorySpine` in the
 *     options is what activates it now.
 *
 * Plus a one-time, marker-guarded fold of this project's own pre-spine
 * `control-plane/sessions.json` into the adopted daemon, done by the SDK.
 *
 * ── Why this module's exported shape does not change ──────────────────────
 *
 * `bootstrap.ts` gates on `HostServiceStatus` and hands a bare
 * `(daemonStatus, sharedDaemonToken)` pair to whatever this returns. The SDK's
 * handler takes a narrower `{ mode, baseUrl }` signal instead, so the adapting
 * happens inside this module rather than at the call site.
 */
import { createHttpTransport, type HostServiceStatus } from '@/runtime/index.ts';
import { createSpineAdoptionSync as createSdkSpineAdoptionSync } from '@pellux/goodvibes-sdk/platform/runtime/client';
import type { SpineAdoptionOptions as SdkSpineAdoptionOptions } from '@pellux/goodvibes-sdk/platform/runtime/client';

import { createTuiSpineTransport, type SpineSessionsClient } from '../session-spine-transport.ts';
import { createTuiMemorySpineTransport } from '../memory-spine-transport.ts';

/** This module's own options: the SDK's shape minus the two fields it builds itself. */
export type SpineAdoptionOptions = Omit<SdkSpineAdoptionOptions, 'connect' | 'activation'>;

/**
 * Build the "the adopted daemon changed" handler.
 *
 * Idempotent per base URL (the SDK's own guarantee): re-running it against the
 * same adopted daemon is a no-op, so a re-probe after an autostart does not
 * tear a live mirror down and put it back up.
 */
export function createSpineAdoptionSync(
  options: SpineAdoptionOptions,
): (daemonStatus: HostServiceStatus, sharedDaemonToken: string) => void {
  const sync = createSdkSpineAdoptionSync({
    ...options,
    // This terminal has a boot discovery probe and can render "no daemon"
    // honestly, so it gates on the probe's verdict rather than wiring the
    // moment it is handed a base URL.
    activation: 'adopt-on-status',
    connect: (baseUrl, authToken) => {
      const httpTransport = createHttpTransport({ baseUrl, authToken });
      const sessionsClient: SpineSessionsClient = {
        register: (input) => httpTransport.operator.sessions.register(input),
        close: (sessionId) => httpTransport.operator.sessions.close(sessionId),
      };
      return {
        sessionTransport: createTuiSpineTransport(sessionsClient),
        inboundInputs: {
          listInputs: async (sessionId, opts) => ({
            inputs: await httpTransport.operator.sessions.inputs(sessionId, opts.limit, { state: opts.state, since: opts.since }),
          }),
          deliverInput: (sessionId, inputId, opts) =>
            httpTransport.operator.sessions.deliverInput(sessionId, inputId, opts),
        },
        sessionList: { list: (limit: number) => httpTransport.operator.sessions.list(limit) },
        memoryTransport: createTuiMemorySpineTransport({ baseUrl, authToken }),
      };
    },
  });

  return (daemonStatus, sharedDaemonToken) => {
    sync({ mode: daemonStatus.mode, baseUrl: daemonStatus.baseUrl }, sharedDaemonToken);
  };
}
