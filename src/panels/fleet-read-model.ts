// ---------------------------------------------------------------------------
// fleet-read-model.ts
//
// (Fleet tree panel) — pure, testable read-model over the SDK's live
// process registry (@pellux/goodvibes-sdk/platform/runtime/fleet, landed on
// SDK main as). No BasePanel/rendering dependency: this module owns the
// flat ProcessNode[] -> tree transformation, the honest cost/token
// aggregates, and the state->glyph/tone mapping that FleetPanel renders.
//
// Design notes:
//   - The brief predates the real SDK API and sketched a bespoke
//     FleetRegistryNode/FleetRegistry adapter pair. The real
//     createProcessRegistry() ProcessNode already carries elapsedMs,
//     usage, costUsd, costState, and currentActivity directly, so no
//     adapter layer is needed here — this module consumes ProcessNode
//     straight from the registry and only owns the tree-walk + aggregate
//     + presentation-mapping logic the SDK does not provide.
//   - Tree-walk shape (connectors, cycle guard, leftover pass) is ported
//     from renderer/process-modal.ts's appendAgentSubtree/
//     appendAgentGroupEntries, generalized from AgentRecord to ProcessNode
//     and from WRFC-role ordering to plain startedAt ordering (ProcessNode
//     has no role concept — parentId alone expresses the hierarchy, and the
//     SDK guarantees every parentId either resolves or the node is a root).
//   - Cost/token honesty mirrors agent-inspector-shared.ts's
//     hasReportedUsage convention: an all-zero-but-present usage object is
//     treated as "no data" (never a fabricated 0/$0.00), and aggregates are
//     null only when NO node in the snapshot has real data.
//   - Two-factory shape (live/static) mirrors cockpit-read-model.ts.
// ---------------------------------------------------------------------------

import type {
  ArchivableProcessRegistry,
  ProcessAttention,
  ProcessCostState,
  ProcessKind,
  ProcessNode,
  ProcessRegistry,
  ProcessState,
  ProcessUsage,
  SteerResult,
} from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { RuntimeEventBus } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One row in the flattened, depth-first fleet tree. */
export interface FleetTreeRow {
  readonly node: ProcessNode;
  readonly depth: number;
  /** Tree-drawing prefix ('├─ ' / '└─ ' / '│  ' / '   ' segments), '' at depth 0. */
  readonly treePrefix: string;
  readonly isLastChild: boolean;
  readonly hasChildren: boolean;
}

/** Aggregate snapshot the fleet panel renders from. */
export interface FleetSnapshot {
  readonly rows: readonly FleetTreeRow[];
  /** Sum of costUsd across nodes with a real (non-unpriced) reading; null when none do. */
  readonly totalCost: number | null;
  /** Sum of reported usage tokens across nodes with real usage; null when none do. */
  readonly totalTokens: number | null;
  /** Count of nodes in an actively-working state (see isRunningProcessState). */
  readonly runningCount: number;
  /**
   * Ids of the nodes that are "blocked on me" — waiting on a user approval or
   * user input right now (see isBlockedOnUserState) — in display (row) order.
   * This is a DERIVED view over the same node states the rows already carry,
   * never a second source of truth: the panel reads it to badge/jump, it is
   * not a store. Empty when nothing is waiting on the operator.
   */
  readonly blockedNodeIds: readonly string[];
  readonly capturedAt: number;
}

// ---------------------------------------------------------------------------
// State classification — glyph/tone mapping (pure, unit-testable)
// ---------------------------------------------------------------------------

export type FleetStateTone = 'active' | 'success' | 'failure' | 'warn' | 'muted';

// Design ruling: this is a DIFFERENT table from the SDK presentation
// contract's STATE_GLYPHS (@pellux/goodvibes-sdk/platform/presentation) — that
// one is a 4-state semantic alias (good/warn/bad/info) shared by the TUI and
// agent renderers; this one is a 12-state ProcessNode taxonomy specific to the
// Fleet tree panel (thinking/executing-tool/awaiting-approval/streaming/
// stalled/retrying/done/failed/killed/interrupted/idle/queued/paused), and no
// other surface (checked: the agent has no fleet-panel renderer) consumes it
// today. Per the presentation-parity brief, a table only moves to the SDK
// contract when 2+ surfaces need it — this one stays TUI-renderer-local.
const STATE_GLYPHS: Record<ProcessState, string> = {
  thinking: '◔',
  'executing-tool': '●',
  'awaiting-approval': '◐',
  streaming: '◕',
  stalled: '◒',
  retrying: '↻',
  done: '✓',
  failed: '✗',
  killed: '⊘',
  // A distinct TERMINAL outcome from 'killed' —
  // both come from AgentManager.cancel(), but a graceful interrupt request
  // ('the operator asked nicely') is display-distinguishable from a hard
  // kill. '◌' verified free against every other glyph in this table.
  interrupted: '◌',
  idle: '·',
  queued: '…',
  // SDK behavior: schedules/triggers/automation jobs report 'paused' when
  // disabled (previously mislabeled 'killed'). NOT terminal — resumable via
  // ProcessRegistry.resume() (the full pause/resume UI lives in
  // fleet-stop.ts). '❚' verified free against every other glyph in this table.
  paused: '❚',
};

const STATE_TONES: Record<ProcessState, FleetStateTone> = {
  thinking: 'active',
  'executing-tool': 'active',
  streaming: 'active',
  'awaiting-approval': 'warn',
  stalled: 'warn',
  retrying: 'warn',
  done: 'success',
  failed: 'failure',
  killed: 'muted',
  // 'warn' (amber), not 'muted' like killed — an interrupt is a deliberate
  // operator action worth noticing, not a passive/neutral outcome.
  interrupted: 'warn',
  idle: 'muted',
  queued: 'muted',
  // Deliberately parked by the operator: neutral, not alarming.
  paused: 'muted',
};

/** Terminal states — interrupt/kill are not offered; not counted as running. */
const TERMINAL_STATES = new Set<ProcessState>(['done', 'failed', 'killed', 'interrupted']);

/**
 * States that mean "this node is waiting on ME right now" via the state field
 * alone. The registry now also publishes the canonical `needsAttention`
 * projection (reason 'approval' | 'input' — see fleetNodeAttention below),
 * which every surface prefers; this set remains only as the fallback mapping
 * for nodes without the projection, so nothing regresses on older registries.
 */
const BLOCKED_ON_USER_STATES = new Set<ProcessState>(['awaiting-approval']);

/** States representing actively-working nodes (drives runningCount + follow target). */
const RUNNING_STATES = new Set<ProcessState>([
  'thinking', 'executing-tool', 'awaiting-approval', 'streaming', 'stalled', 'retrying',
]);

const KIND_TAGS: Record<ProcessKind, string> = {
  agent: 'agent',
  'wrfc-chain': 'wrfc',
  'wrfc-subtask': 'wrfc·sub',
  workflow: 'flow',
  trigger: 'trig',
  schedule: 'sched',
  watcher: 'watch',
  'background-process': 'exec',
  // Orchestration-engine kinds (adapters/orchestration.ts).
  workstream: 'stream',
  phase: 'phase',
  'work-item': 'item',
  // The repo source-tree code index (adapters/code-index.ts).
  // A single leaf node — never a rollup of other flat-list nodes (see
  // ROLLUP_KINDS below) — so no other list in this module needs updating.
  'code-index': 'index',
};

export function fleetStateGlyph(state: ProcessState): string {
  return STATE_GLYPHS[state] ?? '?';
}

export function fleetStateTone(state: ProcessState): FleetStateTone {
  return STATE_TONES[state] ?? 'muted';
}

export function fleetKindTag(kind: ProcessKind): string {
  return KIND_TAGS[kind] ?? kind;
}

export function isTerminalProcessState(state: ProcessState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isRunningProcessState(state: ProcessState): boolean {
  return RUNNING_STATES.has(state);
}

/** True when a node is waiting on a user approval or user input right now — "blocked on me". */
export function isBlockedOnUserState(state: ProcessState): boolean {
  return BLOCKED_ON_USER_STATES.has(state);
}

/**
 * The node's waiting-on-human classification, preferring the SDK's canonical
 * `needsAttention` projection (reason 'approval' | 'input' — broader than the
 * awaiting-approval state alone: it also covers a session waiting on user
 * input). Falls back to the state-derived mapping for registries that predate
 * the projection, so nothing regresses. This is THE membership every
 * "blocked on me" surface (badge, sort, jump) derives from.
 */
export function fleetNodeAttention(node: ProcessNode): ProcessAttention | null {
  if (node.needsAttention) return node.needsAttention;
  if (isBlockedOnUserState(node.state)) return { reason: 'approval' };
  return null;
}

/** True when the node is waiting on the operator right now (approval or input). */
export function isBlockedOnUserNode(node: ProcessNode): boolean {
  return fleetNodeAttention(node) !== null;
}

/** The literal badge text for a waiting-on-human node, by reason. */
export function fleetAttentionText(attention: ProcessAttention): string {
  return attention.reason === 'input' ? 'needs your input' : 'blocked on you';
}

/**
 * The stall marker for a row — 'quiet Nm' (or 'quiet NhMm' past an hour),
 * derived from the read-model's stall tell (pure timestamp comparison on the
 * registry side; a live node whose last observable output is older than the
 * threshold). Null when the node is not stalled-quiet.
 */
export function fleetStallMarker(node: ProcessNode): string | null {
  const stall = node.stall;
  if (!stall) return null;
  const minutes = Math.max(1, Math.floor(stall.quietForMs / 60_000));
  if (minutes < 60) return `quiet ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `quiet ${hours}h${rest}m` : `quiet ${hours}h`;
}

// ---------------------------------------------------------------------------
// Honest usage/cost helpers (convention, ported from agent-inspector-shared.ts)
// ---------------------------------------------------------------------------

/**
 * True when a ProcessUsage carries real reported token data rather than
 * being present-but-all-zero. Mirrors hasReportedUsage() in
 * agent-inspector-shared.ts, applied to the SDK's ProcessUsage shape.
 */
export function hasFleetUsage(usage: ProcessUsage | undefined): usage is ProcessUsage {
  if (!usage) return false;
  return usage.inputTokens > 0 || usage.outputTokens > 0
    || usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0;
}

/** Total token count (input + output + cache) for a node's usage, or null when no real usage has landed. */
export function fleetUsageTokens(usage: ProcessUsage | undefined): number | null {
  if (!hasFleetUsage(usage)) return null;
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Whether a node's costUsd is a real reading, never a fabricated placeholder. */
export function hasFleetCost(costUsd: number | null | undefined, costState: ProcessCostState): boolean {
  return costState !== 'unpriced' && typeof costUsd === 'number';
}

// ---------------------------------------------------------------------------
// Tree builder — pure, testable (ported tree-walk shape from process-modal.ts)
// ---------------------------------------------------------------------------

/**
 * Sibling comparator. `blockedSubtree` is the set of node ids whose own subtree
 * contains a node blocked on the user (see collectBlockedSubtrees) — those
 * siblings sort to the TOP of their level so a blocked node (and the family
 * that leads to it) floats up the tree, at every depth, without breaking the
 * parent/child structure. Ties fall back to startedAt then id, unchanged.
 */
function makeCompareNodes(blockedSubtree: ReadonlySet<string>): (a: ProcessNode, b: ProcessNode) => number {
  return (a, b) => {
    const aBlocked = blockedSubtree.has(a.id) ? 0 : 1;
    const bBlocked = blockedSubtree.has(b.id) ? 0 : 1;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;
    const delta = (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  };
}

/**
 * The set of node ids whose subtree (the node itself or any descendant) holds a
 * node currently blocked on the user. Post-order DFS with a memo + visiting
 * guard so a defensive parentId cycle terminates. Drives the blocked-first
 * sibling ordering; purely derived from the live node states.
 */
function collectBlockedSubtrees(
  nodes: readonly ProcessNode[],
  childrenByParent: Map<string, ProcessNode[]>,
): Set<string> {
  const blocked = new Set<string>();
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const dfs = (node: ProcessNode): boolean => {
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    if (visiting.has(node.id)) return false; // cycle guard
    visiting.add(node.id);
    let has = isBlockedOnUserNode(node);
    for (const child of childrenByParent.get(node.id) ?? []) {
      if (dfs(child)) has = true;
    }
    visiting.delete(node.id);
    memo.set(node.id, has);
    if (has) blocked.add(node.id);
    return has;
  };
  for (const node of nodes) dfs(node);
  return blocked;
}

function appendSubtree(
  rows: FleetTreeRow[],
  node: ProcessNode,
  childrenByParent: Map<string, ProcessNode[]>,
  depth: number,
  ancestorPrefix: string,
  isLast: boolean,
  visited: Set<string>,
  compare: (a: ProcessNode, b: ProcessNode) => number,
): void {
  if (visited.has(node.id)) return; // cycle guard
  visited.add(node.id);

  const children = (childrenByParent.get(node.id) ?? []).slice().sort(compare);
  const treePrefix = depth === 0 ? '' : `${ancestorPrefix}${isLast ? '└─ ' : '├─ '}`;
  rows.push({ node, depth, treePrefix, isLastChild: isLast, hasChildren: children.length > 0 });

  const descendantPrefix = depth === 0 ? '' : `${ancestorPrefix}${isLast ? '   ' : '│  '}`;
  children.forEach((child, index) => {
    appendSubtree(rows, child, childrenByParent, depth + 1, descendantPrefix, index === children.length - 1, visited, compare);
  });
}

/**
 * Flatten a ProcessNode[] into a stable depth-first FleetTreeRow[] list.
 * Root-level rows (depth 0) carry an empty treePrefix (multi-root forest —
 * each top-level process family renders without a connector to its
 * unrelated siblings); connectors appear starting at depth 1. Defensive
 * cycle guard: a self-referencing or looping parentId chain is walked once
 * via the leftover pass below rather than recursing forever (the SDK
 * guarantees every parentId resolves or the node is a root, so this is
 * belt-and-suspenders, not a supported shape).
 */
export function buildFleetRows(nodes: readonly ProcessNode[]): FleetTreeRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenByParent = new Map<string, ProcessNode[]>();
  const roots: ProcessNode[] = [];

  for (const node of nodes) {
    if (node.parentId && byId.has(node.parentId)) {
      const siblings = childrenByParent.get(node.parentId) ?? [];
      siblings.push(node);
      childrenByParent.set(node.parentId, siblings);
    } else {
      roots.push(node);
    }
  }

  // Blocked-on-user nodes (and the families that lead to them) float to the top
  // at every level — see makeCompareNodes / collectBlockedSubtrees. Derived from
  // the live node states on this same pass; never a stored flag.
  const blockedSubtree = collectBlockedSubtrees(nodes, childrenByParent);
  const compare = makeCompareNodes(blockedSubtree);

  const rows: FleetTreeRow[] = [];
  const visited = new Set<string>();

  for (const root of roots.slice().sort(compare)) {
    appendSubtree(rows, root, childrenByParent, 0, '', true, visited, compare);
  }

  // Defensive: nodes never reached because their entire ancestor chain forms
  // a cycle with no true root. Walked as pseudo-roots so they still render.
  const leftovers = nodes.filter((n) => !visited.has(n.id)).sort(compare);
  for (const node of leftovers) {
    appendSubtree(rows, node, childrenByParent, 0, '', true, visited, compare);
  }

  return rows;
}

/**
 * Kinds whose usage/costUsd (and, for 'running', whose derived state) are the
 * SDK's OWN rollup of *other* nodes that ALSO appear individually in the flat
 * list — summing across every flat node would therefore double-count them.
 * Per registry.ts assemble() + wrfc.ts adaptChain/adaptSubtask:
 *   - 'wrfc-chain': usage/costUsd = sum over the chain's member agents
 *     (chain.allAgentIds minus the owner) via adaptChain's aggregateCost/
 *     sumUsage — those member agents are pushed onto the flat node list as
 *     their own 'agent' nodes too. The chain's derived ProcessState ('running'
 *     while any phase is active) likewise just mirrors its members' states.
 *   - 'wrfc-subtask': never carries usage/cost (adaptSubtask always sets
 *     usage: undefined, costUsd: null, costState: 'unpriced') and its
 *     'running' phase state mirrors whichever agent is currently working the
 *     subtask. Excluded for the same "grouping construct, not an actor"
 *     reason as the chain, even though today it can never contribute a
 *     nonzero cost/token reading (defense in depth against a future adapter
 *     change, not load-bearing).
 *
 * Orchestration-engine additions — verified against adapters/orchestration.ts:
 *   - 'workstream': adaptWorkstream SUMS every work-item's usage/costUsd
 *     exactly once (sumWorkItemUsage/aggregateWorkItemCost), the same
 *     "rollup of nodes that also appear individually" shape as adaptChain —
 *     each work item ALSO appears as its own 'work-item' node in the flat
 *     list, so summing over every flat node would double-count. Its derived
 *     state likewise mirrors its items' states, so it is excluded from
 *     runningCount for the same non-double-counting reason as 'wrfc-chain'.
 *   - 'phase': adaptPhase reports NO usage/cost (mirrors adaptSubtask's
 *     "report nothing" choice exactly — usage: undefined, costUsd: null,
 *     costState: 'unpriced') and its 'running' state mirrors whichever
 *     work-item currently occupies it. Same defense-in-depth inclusion as
 *     'wrfc-subtask': never contributes today, excluded anyway in case a
 *     future adapter change gives it one.
 *   - 'work-item' is deliberately NOT in this set: unlike a phase, a work
 *     item carries its OWN direct usage/cost (item.usage, cumulative across
 *     every phase it has visited) — it is the leaf contributor, the
 *     'wrfc-subtask'-for-capabilities analogue but the 'agent'-for-usage
 *     analogue. Excluding it would silently zero out real cost/token totals.
 *
 * 'code-index' is deliberately NOT in this set either —
 * adaptCodeIndex yields exactly one standalone ProcessNode per registry
 * (never a parent whose children ALSO appear individually in the flat
 * list), so it is a leaf like 'agent'/'work-item', not a grouping construct.
 * It reports no usage/cost (an index build has no LLM turn), so it never
 * contributes to totalCost/totalTokens regardless — its running state DOES
 * count toward runningCount while building, which is correct: it is a real,
 * distinct unit of work, not an arithmetic sum of other rows.
 */
const ROLLUP_KINDS = new Set<ProcessKind>(['wrfc-chain', 'wrfc-subtask', 'workstream', 'phase']);

/**
 * True for the WRFC owner agent's node specifically: an 'agent'-kind node
 * whose source AgentRecord has wrfcRole === 'owner'. The owner runs no LLM
 * turn itself — at chain completion the SDK backfills owner.usage from
 * aggregateChainUsage(chain) (wrfc-controller.ts completeOwnerAgent), which
 * is the SAME phase-children total already carried by the chain node AND by
 * each phase-child agent's own node. Detected via the opaque `raw` field
 * (the AgentRecord) since ProcessNode itself has no wrfcRole — this is the
 * one place fleet-read-model reaches into `raw` for aggregation honesty
 * rather than drill-down display.
 */
function isWrfcOwnerAgentNode(node: ProcessNode): boolean {
  if (node.kind !== 'agent') return false;
  const raw = node.raw;
  return typeof raw === 'object' && raw !== null && (raw as { wrfcRole?: unknown }).wrfcRole === 'owner';
}

/**
 * Nodes whose usage/costUsd would double-count against other nodes already
 * in the same flat list (see ROLLUP_KINDS / isWrfcOwnerAgentNode above).
 * Excluded from totalCost/totalTokens. NOT excluded from runningCount by
 * this predicate alone — see isFleetRunningLeaf.
 */
function isFleetAggregateRollupNode(node: ProcessNode): boolean {
  return ROLLUP_KINDS.has(node.kind) || isWrfcOwnerAgentNode(node);
}

/**
 * Nodes that count toward runningCount. Excludes ROLLUP_KINDS (a running
 * wrfc-chain/wrfc-subtask reflects the very same unit of work as its running
 * member agent, which is already counted) but — unlike the cost/token
 * exclusion above — does NOT exclude the WRFC owner agent: the owner is a
 * real, distinct supervising process (not an arithmetic sum of other rows),
 * so counting it as "running" alongside its phase children is not a double
 * count in the way summing its rolled-up usage/cost would be.
 */
function isFleetRunningLeaf(node: ProcessNode): boolean {
  return !ROLLUP_KINDS.has(node.kind) && isRunningProcessState(node.state);
}

/** Build the full FleetSnapshot (rows + honest aggregates) from a flat node list. */
export function buildFleetSnapshot(nodes: readonly ProcessNode[], capturedAt: number = Date.now()): FleetSnapshot {
  const rows = buildFleetRows(nodes);

  let totalCost: number | null = null;
  let totalTokens: number | null = null;
  let runningCount = 0;

  for (const node of nodes) {
    if (!isFleetAggregateRollupNode(node)) {
      if (hasFleetCost(node.costUsd, node.costState)) {
        totalCost = (totalCost ?? 0) + (node.costUsd as number);
      }
      const tokens = fleetUsageTokens(node.usage);
      if (tokens !== null) {
        totalTokens = (totalTokens ?? 0) + tokens;
      }
    }
    if (isFleetRunningLeaf(node)) runningCount++;
  }

  // Blocked ids in display (row) order so the panel's jump key steps through
  // them top-to-bottom exactly as they appear on screen.
  const blockedNodeIds = rows
    .filter((row) => isBlockedOnUserNode(row.node))
    .map((row) => row.node.id);

  return { rows, totalCost, totalTokens, runningCount, blockedNodeIds, capturedAt };
}

/**
 * The fleet's honest leaf cost total — the SAME figure as
 * FleetSnapshot.totalCost, but computed in one pass WITHOUT building the display
 * rows, for cheap per-frame use (the always-visible footer). Excludes rollup
 * aggregates (chain/subtask/workstream/phase) AND the WRFC owner (its usage is a
 * mixed-model rollup of its children), so it is a true leaf-sum with no
 * double-count. Null when nothing priced. Add this to the main session cost for
 * the true "you + fleet" total.
 */
export function fleetLeafCostTotal(nodes: readonly ProcessNode[]): number | null {
  let total: number | null = null;
  for (const node of nodes) {
    if (isFleetAggregateRollupNode(node)) continue;
    if (!hasFleetCost(node.costUsd, node.costState)) continue;
    total = (total ?? 0) + (node.costUsd as number);
  }
  return total;
}

/**
 * The fleet cost figure for the always-visible footer: fleetLeafCostTotal over a
 * fresh registry query, but ONLY while a fleet is live — the idle single-session
 * path must never pay the aggregate-on-read query() scan. Query failures degrade to
 * null (honest "no fleet cost"), never a throw into the render loop.
 */
export function footerFleetCost(queryNodes: () => readonly ProcessNode[], hasLiveFleet: boolean): number | null {
  if (!hasLiveFleet) return null;
  try {
    return fleetLeafCostTotal(queryNodes());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read-model — two-factory shape (live / static), mirrors cockpit-read-model.ts
// ---------------------------------------------------------------------------

/** Payload of a `COMMUNICATION_CONSUMED` runtime-bus event, narrowed for FleetReadModel consumers. */
export interface SteerConsumedEvent {
  readonly messageId: string;
  readonly agentId: string;
  readonly turn: number;
}

export interface FleetReadModel {
  getSnapshot(): FleetSnapshot;
  /** Subscribe to fleet changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Graceful interruption where the source supports one. Returns true when accepted. */
  interrupt(id: string): boolean;
  /**
   * Re-arm a `paused` node (a disabled trigger/schedule,
   * or an automation job). The inverse of interrupt()'s pause. Returns true when
   * accepted; false for a node that is not currently `paused` or whose kind has
   * no resume path (honest refusal).
   */
  resume(id: string): boolean;
  /** Hard stop, optionally cascading to descendants. Returns the node ids acted on. */
  kill(id: string, opts?: { readonly cascade?: boolean }): readonly string[];
  /**
   * Queue a human message for a live in-process agent (or a
   * wrfc-subtask's current live member), delivered at its next turn
   * boundary. Honest refusal (`{queued:false,reason}`) for anything that
   * cannot take mid-run input — see ProcessRegistry.steer's doc comment.
   */
  steer(id: string, text: string): SteerResult;
  /**
   * Subscribe to the honest "the agent actually consumed this
   * steer at its turn boundary" signal (COMMUNICATION_CONSUMED on the
   * runtime bus's 'communication' domain). Returns an unsubscribe function.
   * A read-model constructed without a runtimeBus (e.g. the static factory,
   * or a test double) never invokes the listener — graceful no-op, matching
   * the steer()/steerable degrade-without-a-dep convention.
   */
  subscribeConsumed(listener: (event: SteerConsumedEvent) => void): () => void;
  /** Rows snapshot of ARCHIVED subtrees (empty when the runtime has no archive layer). */
  getArchivedSnapshot(): FleetSnapshot;
  /** Move a finished subtree to the session archive. Honest refusal reason when it cannot be. */
  archive(id: string): { readonly archived: boolean; readonly count: number; readonly reason?: string };
  /** Archive every fully-finished root subtree. Returns the number of nodes archived. */
  archiveFinished(): number;
  /** Return an archived subtree to the live view. Returns the number of nodes restored. */
  unarchive(id: string): number;
}

/**
 * Narrow surface of ProcessRegistry this read-model depends on. The archive
 * methods are optional: a runtime whose registry lacks the archive layer
 * (or a bare test double) degrades to "no archive" instead of crashing.
 */
export type FleetRegistryLike = Pick<ProcessRegistry, 'query' | 'subscribe' | 'interrupt' | 'resume' | 'kill' | 'steer'>
  & Partial<Pick<ArchivableProcessRegistry, 'archive' | 'archiveFinished' | 'unarchive' | 'listArchived'>>;

/**
 * Create a live FleetReadModel backed by the SDK's ProcessRegistry.
 * `runtimeBus` is optional (narrowed to just `onDomain`) — without it,
 * `subscribeConsumed` degrades to a no-op, same shape as the registry's own
 * messageBus-optional degrade for steer()/steerable.
 */
export function createFleetReadModel(
  registry: FleetRegistryLike,
  runtimeBus?: Pick<RuntimeEventBus, 'onDomain'>,
): FleetReadModel {
  return {
    getSnapshot(): FleetSnapshot {
      const snapshot = registry.query();
      return buildFleetSnapshot(snapshot.nodes, snapshot.capturedAt);
    },
    subscribe(listener: () => void): () => void {
      return registry.subscribe(() => listener());
    },
    interrupt(id: string): boolean {
      return registry.interrupt(id);
    },
    resume(id: string): boolean {
      return registry.resume(id);
    },
    kill(id: string, opts?: { readonly cascade?: boolean }): readonly string[] {
      return registry.kill(id, opts);
    },
    steer(id: string, text: string): SteerResult {
      return registry.steer(id, text);
    },
    subscribeConsumed(listener: (event: SteerConsumedEvent) => void): () => void {
      if (!runtimeBus) return () => {};
      return runtimeBus.onDomain('communication', (envelope) => {
        const event = envelope.payload;
        if (event.type === 'COMMUNICATION_CONSUMED') {
          listener({ messageId: event.messageId, agentId: event.agentId, turn: event.turn });
        }
      });
    },
    getArchivedSnapshot(): FleetSnapshot {
      if (!registry.listArchived) return buildFleetSnapshot([]);
      const snapshot = registry.listArchived();
      return buildFleetSnapshot(snapshot.nodes, snapshot.capturedAt);
    },
    archive(id: string) {
      if (!registry.archive) return { archived: false, count: 0, reason: 'this runtime has no fleet archive' };
      return registry.archive(id);
    },
    archiveFinished(): number {
      return registry.archiveFinished?.() ?? 0;
    },
    unarchive(id: string): number {
      return registry.unarchive?.(id) ?? 0;
    },
  };
}

/** Create a static FleetReadModel for tests/goldens — no live registry, no timers. */
export function createStaticFleetReadModel(snapshot: FleetSnapshot): FleetReadModel {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    interrupt: () => false,
    resume: () => false,
    kill: () => [],
    steer: () => ({ queued: false, reason: 'no live registry' }),
    subscribeConsumed: () => () => {},
    getArchivedSnapshot: () => buildFleetSnapshot([]),
    archive: () => ({ archived: false, count: 0, reason: 'no live registry' }),
    archiveFinished: () => 0,
    unarchive: () => 0,
  };
}
