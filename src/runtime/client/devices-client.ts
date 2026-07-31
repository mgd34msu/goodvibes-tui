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
 * `devices.housekeeping.run` — the four the operator contract carries. Reads
 * degrade to an empty list with the honest reason attached; a revoke or a sweep
 * against no reachable daemon REJECTS, because reporting a revocation that did
 * not happen is worse than reporting the failure.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { DaemonVerbCaller } from './operator-endpoint.ts';

/** One paired device as the daemon describes it. */
export interface DeviceNodeSummary {
  readonly nodeId: string;
  readonly nodeKind?: string | undefined;
  readonly label?: string | undefined;
  readonly platform?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
}

/** One capability grant the daemon is holding. */
export interface DeviceGrantSummary {
  readonly grantId: string;
  readonly nodeId?: string | undefined;
  readonly capability?: string | undefined;
  readonly expiresAt?: number | undefined;
}

export interface DevicesClient {
  /** Paired device nodes. Empty (with a logged reason) when the daemon cannot answer. */
  listNodes(): Promise<readonly DeviceNodeSummary[]>;
  /** Live capability grants. Empty (with a logged reason) when the daemon cannot answer. */
  listGrants(): Promise<readonly DeviceGrantSummary[]>;
  /** Revoke a grant. Rejects when no daemon is reachable — never reports a revoke that did not happen. */
  revokeGrant(grantId: string): Promise<void>;
  /** Run the grant/capture reap now. Rejects when no daemon is reachable. */
  runHousekeeping(): Promise<void>;
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
      await verbs.invoke('devices.housekeeping.run', {});
    },
    describeAvailability: () => {
      const probe = verbs.probe();
      return probe.available ? null : probe.reason;
    },
  };
}
