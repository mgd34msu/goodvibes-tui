/**
 * spine-adoption.ts — wiring this surface's session and memory spines to the
 * daemon it adopted.
 *
 * ── What the branch used to be, and what it is now ─────────────────────────
 *
 * There were two supported topologies and this was the one selection point
 * between them: `embedded` meant this process's own `SharedSessionBroker` WAS
 * the daemon's broker, so there was nothing to mirror to and the spine stayed
 * dormant; `external` meant a separately-running daemon this app adopted, and
 * only then did the wire mirror come up.
 *
 * `embedded` is gone. This app never hosts a daemon, so there is exactly one
 * live topology — adopted — and every other mode (`disabled`, `blocked`,
 * `incompatible`, `unavailable`) means the same honest thing: no daemon, local
 * only, nothing mirrored. The branch that remains is "adopted or not", not "who
 * is hosting".
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
 *   - the memory spine's wire transport, on the same adoption signal.
 *
 * Plus a one-time, marker-guarded fold of this project's own pre-spine
 * `control-plane/sessions.json` into the adopted daemon, so sessions that
 * predate the split are visible rather than stranded.
 */
import { createHttpTransport, type HostServiceStatus } from '@/runtime/index.ts';
import { foldLegacySpineStore, type SessionSpineClient } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

import { createTuiSpineTransport, type SpineSessionsClient } from '../session-spine-transport.ts';
import { syncMemorySpineToHostStatus, type MemorySpineActiveRef } from '../memory-spine-transport.ts';
import type { MemorySpineClient } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';

/** The inbound steer poller, as this module drives it. */
export interface InboundInputsActivation {
  activate(client: {
    listInputs(sessionId: string, options: { readonly state?: string; readonly since?: number; readonly limit?: number }): Promise<{ readonly inputs: readonly unknown[] }>;
    deliverInput(sessionId: string, inputId: string, options?: { readonly consumed?: boolean }): Promise<unknown>;
  }): void;
  deactivate(reason: string): void;
}

/** The cross-surface union read model, as this module drives it. */
export interface SessionUnionActivation {
  activate(source: { list(limit: number): Promise<readonly unknown[]> }): void;
  deactivate(reason: string): void;
}

export interface SpineAdoptionOptions {
  readonly sessionSpine: SessionSpineClient;
  readonly memorySpine: MemorySpineClient;
  readonly sessionInboundInputs: InboundInputsActivation;
  readonly sessionUnionCache: SessionUnionActivation;
  /** Where this project's pre-spine session store lives, for the one-time fold. */
  readonly legacyStorePath: string;
  readonly workingDirectory: string;
  /**
   * Extra seams driven on the same adoption signal: inbound continuation
   * dispatch, and offering this surface's conversation for rewind. Both are
   * meaningless without an adopted daemon and both must come up with one, so
   * they ride the signal that already knows.
   */
  readonly onAdopted?: ((client: {
    listInputs(sessionId: string, options: { readonly state?: string; readonly since?: number; readonly limit?: number }): Promise<{ readonly inputs: readonly unknown[] }>;
    deliverInput(sessionId: string, inputId: string, options?: { readonly consumed?: boolean }): Promise<unknown>;
  }) => void) | undefined;
  readonly onDetached?: ((reason: string) => void) | undefined;
}

/**
 * Build the "the adopted daemon changed" handler.
 *
 * Idempotent per base URL: re-running it against the same adopted daemon is a
 * no-op, so a re-probe after an autostart does not tear a live mirror down and
 * put it back up.
 */
export function createSpineAdoptionSync(options: SpineAdoptionOptions): (daemonStatus: HostServiceStatus, sharedDaemonToken: string) => void {
  let activeForBaseUrl: string | null = null;
  const memorySpineActiveRef: MemorySpineActiveRef = { value: null };

  return (daemonStatus, sharedDaemonToken) => {
    syncMemorySpineToHostStatus(options.memorySpine, daemonStatus.mode, daemonStatus.baseUrl, sharedDaemonToken, memorySpineActiveRef, logger);
    if (daemonStatus.mode !== 'external') {
      if (activeForBaseUrl !== null) {
        const reason = `daemon mode changed to '${daemonStatus.mode}'`;
        options.sessionSpine.deactivate(reason);
        options.sessionInboundInputs.deactivate(reason);
        options.onDetached?.(reason);
        activeForBaseUrl = null;
      }
      options.sessionUnionCache.deactivate(`daemon mode '${daemonStatus.mode}'`);
      logger.info(`[bootstrap] session spine: daemon mode '${daemonStatus.mode}' — local-only (no spine mirror)`);
      return;
    }
    const baseUrl = daemonStatus.baseUrl;
    if (activeForBaseUrl === baseUrl) return; // already wired to this exact adopted daemon
    const httpTransport = createHttpTransport({ baseUrl, authToken: sharedDaemonToken });
    const sessionsClient: SpineSessionsClient = {
      register: (input) => httpTransport.operator.sessions.register(input),
      close: (sessionId) => httpTransport.operator.sessions.close(sessionId),
    };
    options.sessionSpine.activate(createTuiSpineTransport(sessionsClient));
    const inboundClient = {
      listInputs: async (sessionId: string, opts: { readonly state?: string; readonly since?: number; readonly limit?: number }) => ({
        inputs: await httpTransport.operator.sessions.inputs(sessionId, opts.limit, { state: opts.state, since: opts.since }),
      }),
      deliverInput: (sessionId: string, inputId: string, opts?: { readonly consumed?: boolean }) =>
        httpTransport.operator.sessions.deliverInput(sessionId, inputId, opts),
    };
    options.sessionInboundInputs.activate(inboundClient);
    options.onAdopted?.(inboundClient);
    options.sessionUnionCache.activate({ list: (limit: number) => httpTransport.operator.sessions.list(limit) });
    activeForBaseUrl = baseUrl;
    logger.info(`[bootstrap] session spine: adopted daemon at ${baseUrl} — mirroring session identity`);
    // One-time, marker-guarded import of this project's own pre-spine sessions.
    const fold = foldLegacySpineStore(options.sessionSpine, {
      storePath: options.legacyStorePath,
      markerPath: `${options.legacyStorePath}.spine-migrated`,
      project: options.workingDirectory,
    });
    if (fold.folded > 0) {
      logger.info(`[bootstrap] session spine: folded ${fold.folded} legacy local session(s) into the adopted daemon`);
    }
  };
}
