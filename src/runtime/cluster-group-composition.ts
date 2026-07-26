/**
 * cluster-group-composition.ts — this machine's membership of a LAN group.
 *
 * Leader election answers "which of us reads the inbox". This answers the
 * question underneath it: "which machines are US". Without a group, any daemon
 * that happened to be on the same network — a neighbour's, a colleague's, a
 * container someone left running — would join the same coordination and one of
 * you would silently stop receiving messages.
 *
 * The group layer owns the socket and the election rides on it: every
 * coordination datagram is wrapped in the group envelope and signed with the
 * current group key, so a datagram from outside the group never reaches the
 * election at all. That is why `createClusterComposition` is handed a transport
 * from here instead of opening one of its own.
 *
 * Key material lives ONLY in the encrypted secrets store. Never in config,
 * never in a log line, never in `/status`.
 */
import {
  ClusterGroupRuntime,
  createClusterGroupVerbs,
  createSystemClusterClock,
  readClusterSettings,
  rejoinGroup,
  resolveClusterGroupSettings,
  resolveNodeIdentity,
  stillOnRoster,
  UdpClusterTransport,
  type ClusterGroupVerbSurface,
  type ClusterSurfaceHolding,
  type GroupOperationsContext,
} from '@pellux/goodvibes-sdk/platform/cluster';
import type { ConfigManager, SecretsManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ClusterTransport } from '@pellux/goodvibes-sdk/platform/cluster';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { ShellPathService } from '@/runtime/index.ts';
import { createClusterComposition } from './cluster-composition.ts';
import type { ClusterCoordinator } from '@pellux/goodvibes-sdk/platform/cluster';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { VERSION } from '../version.ts';

export interface ClusterGroupComposition {
  readonly runtime: ClusterGroupRuntime;
  readonly verbs: ClusterGroupVerbSurface;
  /** The transport the leader election must use, so its traffic is group-signed. */
  readonly electionTransport: ClusterTransport;
  /** Start the group layer. Safe to call more than once. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A label for THIS machine in the member list.
 *
 * Deliberately NOT the hostname. The roster replicates to every member and the
 * group name reaches the network in a beacon, so defaulting to a hostname would
 * quietly publish "mikes-laptop" to anything listening. A short slice of the
 * node id is meaningless and safe, and `cluster nodes` shows it plainly so an
 * operator who wants a real name can see there is one to set.
 */
function defaultNodeDisplayName(nodeId: string): string {
  return `machine ${nodeId.slice(0, 8)}`;
}

/**
 * Build the group layer.
 *
 * Constructing it is inert: no socket is opened and no key material is read
 * until `start()`, so composing a runtime in a test never touches the network
 * or the secrets store.
 */
export function createClusterGroupComposition(options: {
  readonly configManager: ConfigManager;
  readonly shellPaths: ShellPathService;
  readonly secretsManager: SecretsManager;
  /**
   * The leader election's own answer to "am I the master".
   *
   * Config replication needs exactly one machine issuing revisions, and it must
   * be the SAME machine leadership already picked — two notions of master in
   * one process would disagree the moment one of them changed.
   *
   * Late-bound because the coordinator is built from this composition's
   * transport: it does not exist yet when this function runs.
   */
  readonly isMaster?: (() => boolean) | undefined;
  /**
   * Which surfaces this machine currently holds, and why.
   *
   * The per-surface election establishes this; the group layer only reports it,
   * in `cluster status` and in /status. Late-bound for the same reason
   * `isMaster` is. Absent means the group layer reports that the information is
   * unavailable rather than reporting an empty list as though this machine held
   * nothing — a distinction an operator diagnosing a silent inbox depends on.
   */
  readonly surfaceHoldings?: (() => readonly ClusterSurfaceHolding[]) | undefined;
}): ClusterGroupComposition {
  const settings = readClusterSettings(options.configManager);
  const groupSettings = resolveClusterGroupSettings(
    (options.configManager as { getCategory?: (name: string) => unknown }).getCategory?.('cluster'),
  );
  // Surface-scoped, alongside the election's node identity and this surface's
  // other durable state.
  const stateDirectory = options.shellPaths.resolveProjectPath(GOODVIBES_TUI_SURFACE_ROOT, 'cluster');
  const nodeId = resolveNodeIdentity({ stateDirectory, logger }).nodeId;

  const runtime = new ClusterGroupRuntime({
    settings: groupSettings,
    transport: new UdpClusterTransport({
      port: settings.port,
      multicastGroup: settings.multicastGroup,
      peers: settings.peers,
      logger,
    }),
    // Narrower than the SecretsManager itself: the group layer gets get/set/
    // delete on one key and nothing else.
    secrets: {
      get: (key) => options.secretsManager.get(key),
      set: (key, value) => options.secretsManager.set(key, value),
      delete: (key) => options.secretsManager.delete(key),
    },
    stateDirectory,
    nodeId,
    nodeDisplayName: defaultNodeDisplayName(nodeId),
    version: VERSION,
    clock: createSystemClusterClock(),
    logger,
    ...(options.isMaster ? { isMaster: options.isMaster } : {}),
    ...(options.surfaceHoldings ? { surfaceHoldings: options.surfaceHoldings } : {}),
    // Only daemon-owned, group-scoped keys ever reach this; the SDK's
    // replication policy decides which, and refuses anything machine-specific.
    config: {
      get: (path) => (options.configManager as unknown as {
        get(key: string): unknown;
      }).get(path),
      set: (path, value) => (options.configManager as unknown as {
        set(key: string, value: unknown): void;
      }).set(path, value),
    },
  });

  const context: GroupOperationsContext = {
    runtime,
    secrets: {
      get: (key) => options.secretsManager.get(key),
      set: (key, value) => options.secretsManager.set(key, value),
      delete: (key) => options.secretsManager.delete(key),
    },
    settings: groupSettings,
    nodeId,
    nodeDisplayName: defaultNodeDisplayName(nodeId),
    version: VERSION,
    now: () => Date.now(),
  };

  let started = false;
  return {
    runtime,
    verbs: createClusterGroupVerbs(context),
    electionTransport: runtime.electionTransport(),
    start: async () => {
      if (started) return;
      started = true;
      await runtime.start();
      await announceReturn(runtime, context, nodeId);
    },
    stop: async () => {
      started = false;
      await runtime.stop();
    },
  };
}

/**
 * Build both halves of the LAN cluster, wired to each other.
 *
 * They are mutually dependent and the dependency runs both ways, which is why
 * this exists rather than two calls at the composition root: the election
 * coordinates over the GROUP's transport, and the group's config replication
 * needs the ELECTION's answer to "am I the master". The master signal is read
 * through a closure because the coordinator does not exist yet when the group
 * layer is constructed.
 *
 * Constructing either is inert — no socket, no key material read — until
 * `startCluster` runs.
 */
export function createClusterServices(options: {
  readonly configManager: ConfigManager;
  readonly shellPaths: ShellPathService;
  readonly secretsManager: SecretsManager;
}): { readonly clusterGroup: ClusterGroupComposition; readonly clusterCoordinator: ClusterCoordinator } {
  let coordinator: ClusterCoordinator | null = null;
  const clusterGroup = createClusterGroupComposition({
    ...options,
    isMaster: () => coordinator?.isMaster ?? false,
    // The elections actually running are the only honest source for this, so
    // the group layer reads them rather than keeping a second tally that could
    // disagree. Before the coordinator exists there is nothing to report, and
    // an empty list is the truthful answer at that point: no election has been
    // held, so this machine holds nothing.
    surfaceHoldings: () => coordinator?.surfaceHoldings() ?? [],
  });
  coordinator = createClusterComposition({
    configManager: options.configManager,
    shellPaths: options.shellPaths,
    transport: clusterGroup.electionTransport,
  });
  return { clusterGroup, clusterCoordinator: coordinator };
}

/**
 * Start the LAN cluster, in the order it has to be started in.
 *
 * The group layer FIRST: it owns the socket the leader election coordinates
 * over, and starting the election against a transport whose group is not yet
 * loaded would sign its first datagrams with nothing. Both calls are
 * idempotent, so a composition root that reaches this twice is fine.
 */
export async function startClusterServices(services: {
  readonly clusterGroup: Pick<ClusterGroupComposition, 'start'>;
  readonly clusterCoordinator: { start(): Promise<void> };
}): Promise<void> {
  await services.clusterGroup.start();
  await services.clusterCoordinator.start();
}

/**
 * Ask the group to take this machine back, on start.
 *
 * This is the zero-touch return. A machine that has been switched off for
 * months — through many group-key rotations and possibly a join-key change —
 * comes up holding stale keys, says "it is still me" with a key that never
 * rotates, and is re-keyed to the current generation by whichever member
 * answers. The operator does nothing.
 *
 * It runs only when this machine still believes it is on the roster. A machine
 * that was REMOVED asks for nothing: it would be refused, and asking anyway
 * would put a pointless refusal in everyone's logs every time it started.
 */
async function announceReturn(
  runtime: ClusterGroupRuntime,
  context: GroupOperationsContext,
  nodeId: string,
): Promise<void> {
  if (runtime.membership !== 'member') return;
  if (!stillOnRoster(runtime.groupState, nodeId)) return;
  const result = await rejoinGroup(context);
  if (result.ok) {
    logger.info('cluster: rejoined the group and took the current group key', {
      group: result.data.groupName,
      members: result.data.memberCount,
    });
    return;
  }
  // Not an error. A machine that starts first, or is alone on the network, has
  // nobody to answer it and carries on with the keys it already holds.
  logger.debug('cluster: no other machine answered the return announcement', { reason: result.error });
}
