/**
 * devices-client.ts — the paired-phone surface, as a client.
 *
 * ── What moved and what did not ────────────────────────────────────────────
 *
 * The device-posture RUNTIME — the grants ledger, the capture store, the
 * housekeeping sweeps, the capability service every `device.*` setting governs
 * — was composed in this process and is now the daemon's. It has to be: a phone
 * pairs with the daemon, the grant it is given must outlive whichever terminal
 * window happened to approve it, and the sweep that reaps a grant whose phone is
 * gone must run whether or not anyone is at a keyboard.
 *
 * What stays here is the `phone` TOOL. A tool is called by the conversation
 * loop, the loop runs in this process, so the tool is registered in this
 * process's registry — and every capability it exercises goes to the daemon over
 * the `devices.*` verbs rather than to an in-process service. That is the split
 * the seam map prescribes for Phase A: the tool follows the loop, the runtime
 * follows the daemon.
 *
 * ── The verbs ─────────────────────────────────────────────────────────────
 *
 * `devices.nodes.list`, `devices.grants.list`, `devices.grants.revoke`,
 * `devices.housekeeping.run`, and — the ones that make the tool actually able
 * to DO something — `devices.capability.request`, `devices.artifacts.list` and
 * `devices.artifacts.read`.
 *
 * Reads degrade to an empty list with the honest reason attached; a revoke, a
 * sweep or a capability request against no reachable daemon REJECTS, because
 * reporting a revocation or a capture that did not happen is worse than
 * reporting the failure.
 *
 * ── What a capability request is NOT ──────────────────────────────────────
 *
 * It is not a decision made here. The daemon's runtime owns the confirmation
 * prompt, the durable-grant lookup, the `device.*` config gates, the input
 * check, the retention window and the disclosure. This module shapes the call
 * and returns the outcome verbatim — including a refusal, which comes back as
 * `ok: false` with the runtime's own code and detail rather than as a thrown
 * error, because a person declining their camera is an answer.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { DaemonVerbCaller } from './operator-endpoint.ts';

/**
 * One paired device as the daemon describes it.
 *
 * `supported` is the field the verb actually returns — the capabilities this
 * node offers AND this host understands. Named as the wire names it rather than
 * renamed to something tidier: a rename here is a place the two can disagree,
 * and the disagreement would show up as "no paired phone offers this" for a
 * phone that offers it.
 */
export interface DeviceNodeSummary extends Record<string, unknown> {
  readonly nodeId: string;
  readonly nodeKind?: string | undefined;
  readonly label?: string | undefined;
  readonly platform?: string | undefined;
  readonly supported?: readonly string[] | undefined;
}

/** One capability grant the daemon is holding. */
export interface DeviceGrantSummary {
  readonly grantId: string;
  readonly nodeId?: string | undefined;
  readonly capability?: string | undefined;
  readonly expiresAt?: number | undefined;
}

/** One retained capture, as the daemon describes it. */
export interface DeviceArtifactSummary extends Record<string, unknown> {
  readonly artifactId: string;
  readonly nodeId?: string | undefined;
  readonly capabilityId?: string | undefined;
  readonly mediaType?: string | undefined;
  readonly byteLength?: number | undefined;
  /** A path on the DAEMON's filesystem. Reported, never opened from here. */
  readonly daemonPath?: string | undefined;
}

/**
 * The runtime's answer to a capability request, verbatim.
 *
 * `ok: false` carries `refusal` (the runtime's code) and `detail` (its own
 * words). That is a real outcome, not a transport failure, so it arrives as a
 * value rather than a throw.
 */
export interface DeviceCapabilityOutcomeWire extends Record<string, unknown> {
  readonly ok: boolean;
  readonly nodeId?: string | undefined;
  readonly capabilityId?: string | undefined;
  readonly capabilityTitle?: string | undefined;
  readonly authority?: string | undefined;
  readonly grantId?: string | null | undefined;
  readonly data?: unknown;
  readonly artifact?: DeviceArtifactSummary | null | undefined;
  readonly refusal?: string | undefined;
  readonly detail?: string | undefined;
}

export interface DevicesClient {
  /** Paired device nodes. Empty (with a logged reason) when the daemon cannot answer. */
  listNodes(): Promise<readonly DeviceNodeSummary[]>;
  /** Live capability grants. Empty (with a logged reason) when the daemon cannot answer. */
  listGrants(): Promise<readonly DeviceGrantSummary[]>;
  /** Revoke a grant. Rejects when no daemon is reachable — never reports a revoke that did not happen. */
  revokeGrant(grantId: string): Promise<void>;
  /** Run the grant/capture reap now. Rejects when no daemon is reachable. */
  runHousekeeping(): Promise<Record<string, unknown>>;
  /**
   * Ask one paired device for one capability. Rejects only on a TRANSPORT
   * failure; a refusal by the person or the policy comes back as `ok: false`.
   */
  requestCapability(input: {
    readonly nodeId: string;
    readonly capabilityId: string;
    readonly reason: string;
    readonly input?: Record<string, unknown> | undefined;
    readonly sessionId?: string | undefined;
    readonly timeoutMs?: number | undefined;
  }): Promise<DeviceCapabilityOutcomeWire>;
  /** Retained captures, newest first. Empty (with a logged reason) when unreachable. */
  listArtifacts(options?: { readonly nodeId?: string; readonly limit?: number }): Promise<{
    readonly artifacts: readonly DeviceArtifactSummary[];
    readonly retained: number;
    readonly retentionHours: number;
  }>;
  /** Fetch a capture's bytes, base64-encoded. Rejects when it cannot be served. */
  readArtifact(artifactId: string): Promise<{
    readonly artifact: DeviceArtifactSummary;
    readonly dataBase64: string;
  }>;
  /** Whether a daemon is reachable at all, with the honest reason when not. */
  describeAvailability(): string | null;
}

function readArray<T>(payload: unknown, key: string): readonly T[] {
  if (Array.isArray(payload)) return payload as readonly T[];
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as readonly T[];
  }
  return [];
}

export function createDevicesClient(verbs: DaemonVerbCaller): DevicesClient {
  const requireDaemon = (action: string): void => {
    const probe = verbs.probe();
    if (!probe.available) throw new Error(`cannot ${action}: ${probe.reason}`);
  };

  const readList = async <T,>(methodId: string, key: string): Promise<readonly T[]> => {
    try {
      return readArray<T>(await verbs.invoke(methodId, {}), key);
    } catch (error) {
      logger.debug(`[devices] ${methodId} did not answer`, { error: summarizeError(error) });
      return [];
    }
  };

  return {
    listNodes: () => readList<DeviceNodeSummary>('devices.nodes.list', 'nodes'),
    listGrants: () => readList<DeviceGrantSummary>('devices.grants.list', 'grants'),
    revokeGrant: async (grantId) => {
      requireDaemon(`revoke device grant '${grantId}'`);
      await verbs.invoke('devices.grants.revoke', { grantId });
    },
    runHousekeeping: async () => {
      requireDaemon('run device housekeeping');
      return await verbs.invoke<Record<string, unknown>>('devices.housekeeping.run', {}) ?? {};
    },

    requestCapability: async (input) => {
      requireDaemon(`ask ${input.nodeId} for ${input.capabilityId}`);
      // No try/catch around the outcome: a refusal is already `ok: false` in
      // the body, so anything that throws here is a genuine transport or
      // argument failure and belongs to the caller to report as one.
      return await verbs.invoke<DeviceCapabilityOutcomeWire>('devices.capability.request', {
        nodeId: input.nodeId,
        capabilityId: input.capabilityId,
        reason: input.reason,
        ...(input.input === undefined ? {} : { input: input.input }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
    },

    listArtifacts: async (options = {}) => {
      try {
        const result = await verbs.invoke<{
          artifacts?: readonly DeviceArtifactSummary[];
          retained?: number;
          retentionHours?: number;
        }>('devices.artifacts.list', {
          ...(options.nodeId ? { nodeId: options.nodeId } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
        });
        return {
          artifacts: result?.artifacts ?? [],
          retained: result?.retained ?? 0,
          retentionHours: result?.retentionHours ?? 0,
        };
      } catch (error) {
        logger.debug('[devices] the retained captures could not be listed', { error: summarizeError(error) });
        return { artifacts: [], retained: 0, retentionHours: 0 };
      }
    },

    readArtifact: async (artifactId) => {
      requireDaemon(`read capture ${artifactId}`);
      // A swept, expired or digest-mismatched capture comes back 404 with the
      // daemon's own sentence. That IS the failure — there are no bytes — so it
      // propagates rather than becoming an empty success.
      return await verbs.invoke<{ artifact: DeviceArtifactSummary; dataBase64: string }>(
        'devices.artifacts.read',
        { artifactId },
      );
    },
    describeAvailability: () => {
      const probe = verbs.probe();
      return probe.available ? null : probe.reason;
    },
  };
}
