// ---------------------------------------------------------------------------
// fleet-gateway.ts
//
// The async, daemon-backed verb surface the Fleet panel's waiting-on-human acts
// drive — a best-of-N winner pick (fleet.attempts.list / fleet.attempts.pick),
// a merge-conflict resolution (fleet.conflicts.resolve), and a worktree discard
// (worktrees.discard). These are gateway verbs with no named facade on the
// in-process OperatorClient, so — exactly like /ci and /worktree setup — they
// go over the generic operator invoke path (operator-rpc.ts's resolveOperatorRpc
// -> sdk.operator.invoke), reaching the SAME daemon the command layer does.
//
// The panel never types an id: it derives the workstream/work-item id from the
// selected node's namespaced id (workstream:<id> / work-item:<id>, the SDK's own
// fleet-adapter id scheme) and drives the verbs from there. The interface is
// injectable so the panel's act flow round-trips against a mocked daemon in
// tests; the live builder (createFleetGateway) is wired in builtin/operations.ts.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';
import { resolveOperatorRpc } from '../input/commands/operator-rpc.ts';

/** fleet.attempts.list output — the held-merge groups awaiting a winner pick. */
export type FleetAttemptsList = OperatorMethodOutput<'fleet.attempts.list'>;
/** One held-merge group (candidates + their diffs + optional model judgment). */
export type FleetHeldMergeGroup = FleetAttemptsList['groups'][number];
/** One candidate attempt within a group. */
export type FleetAttemptCandidate = FleetHeldMergeGroup['candidates'][number];
/** fleet.attempts.pick output — the confirm preview (applied:false) OR the applied receipt (applied:true). */
export type FleetPickResult = OperatorMethodOutput<'fleet.attempts.pick'>;
/** fleet.conflicts.resolve output — the seeded resolution session stamped on the kept tree. */
export type FleetConflictResolution = OperatorMethodOutput<'fleet.conflicts.resolve'>;
/** worktrees.discard output — the honest receipt: dir removed, branch KEPT, dirty state preserved as a commit. */
export type FleetWorktreeDiscardReceipt = OperatorMethodOutput<'worktrees.discard'>;
/** fleet.graph.get output — the surface-facing task graph of one workstream (nodes/edges/pool). */
export type FleetGraphSnapshot = OperatorMethodOutput<'fleet.graph.get'>;
/** fleet.observed.steer output — queued:true with a messageId, or queued:false with an honest reason. */
export type FleetObservedSteerResult = OperatorMethodOutput<'fleet.observed.steer'>;

/**
 * The narrow async verb surface the Fleet panel's acts drive. Every method is a
 * real daemon round-trip in production (createFleetGateway) and a mocked shape
 * in tests. `armFixSessionAttach` is the ONLY sync member — it hands a spawned
 * session id to the shared one-key jump affordance (the CI fix-session
 * machinery), never a separate attach path.
 */
export interface FleetGateway {
  /** List the held-merge groups (candidates + diffs) for one workstream. */
  listAttempts(workstreamId: string): Promise<FleetAttemptsList>;
  /**
   * Drive fleet.attempts.pick. `confirm:false` returns the confirm PREVIEW
   * (applied:false, the group carried for the surface to render); `confirm:true`
   * merges the winner, cleans the losers, and returns the applied receipt.
   */
  pick(input: { readonly groupId: string; readonly winnerItemId: string; readonly confirm: boolean }): Promise<FleetPickResult>;
  /** Resolve a merge conflict: spawn the seeded resolution session inside the kept tree. */
  resolveConflict(itemId: string): Promise<FleetConflictResolution>;
  /** Discard a worktree directory (branch kept, dirty state preserved as a commit). */
  discardWorktree(path: string): Promise<FleetWorktreeDiscardReceipt>;
  /** Fetch the task graph (nodes/edges/pool) for one workstream — the observability graph view. */
  getGraph(workstreamId: string): Promise<FleetGraphSnapshot>;
  /** Steer an observed foreign agent over its own channel (tmux send-keys); the daemon honestly refuses a channel-less row. */
  steerObserved(input: { readonly id: string; readonly text: string }): Promise<FleetObservedSteerResult>;
  /** Route a spawned session through the shared one-key jump/attach affordance. */
  armFixSessionAttach(sessionId: string): void;
}

const WORKSTREAM_NODE_PREFIX = 'workstream:';
const WORK_ITEM_NODE_PREFIX = 'work-item:';

/** The raw workstream id behind a `workstream:<id>` fleet node id, or null for any other node. */
export function workstreamIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(WORKSTREAM_NODE_PREFIX) ? nodeId.slice(WORKSTREAM_NODE_PREFIX.length) : null;
}

/** The raw work-item id behind a `work-item:<id>` fleet node id, or null for any other node. */
export function workItemIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(WORK_ITEM_NODE_PREFIX) ? nodeId.slice(WORK_ITEM_NODE_PREFIX.length) : null;
}

/**
 * Why the gateway could not be built (daemon disabled / no control-plane URL),
 * surfaced verbatim so an act can print an honest "not available" line rather
 * than guessing — mirrors OperatorRpcUnavailable.reason.
 */
export type FleetGatewayResolution =
  | { readonly available: true; readonly gateway: FleetGateway }
  | { readonly available: false; readonly reason: string };

export interface FleetGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  /** Hand a spawned session id to the shared one-key jump affordance (late-bound: the affordance is patched onto the command context after bootstrap). */
  readonly armFixSessionAttach: (sessionId: string) => void;
}

/**
 * Build the live Fleet gateway over the generic operator invoke path — the same
 * daemon resolution the command layer uses (resolveOperatorRpc). Returns an
 * honest unavailable reason when no daemon is reachable, so the panel acts can
 * refuse cleanly instead of throwing into the render loop.
 */
export function createFleetGateway(deps: FleetGatewayDeps): FleetGatewayResolution {
  const rpc = resolveOperatorRpc({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return { available: false, reason: rpc.reason };
  const { sdk } = rpc;
  const gateway: FleetGateway = {
    listAttempts: (workstreamId) => sdk.operator.invoke('fleet.attempts.list', { workstreamId }),
    pick: (input) => sdk.operator.invoke('fleet.attempts.pick', input),
    resolveConflict: (itemId) => sdk.operator.invoke('fleet.conflicts.resolve', { itemId }),
    discardWorktree: (path) => sdk.operator.invoke('worktrees.discard', { path }),
    getGraph: (workstreamId) => sdk.operator.invoke('fleet.graph.get', { workstreamId }),
    steerObserved: (input) => sdk.operator.invoke('fleet.observed.steer', input),
    armFixSessionAttach: deps.armFixSessionAttach,
  };
  return { available: true, gateway };
}
