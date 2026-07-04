// ---------------------------------------------------------------------------
// fleet-read-model.ts
//
// W2.2 (Fleet tree panel) — pure, testable read-model over the SDK's live
// process registry (@pellux/goodvibes-sdk/platform/runtime/fleet, landed on
// SDK main as W2.1). No BasePanel/rendering dependency: this module owns the
// flat ProcessNode[] -> tree transformation, the honest cost/token
// aggregates, and the state->glyph/tone mapping that FleetPanel renders.
//
// Design notes:
//   - The W2.2 brief predates the real SDK API and sketched a bespoke
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
  readonly capturedAt: number;
}

// ---------------------------------------------------------------------------
// State classification — glyph/tone mapping (pure, unit-testable)
// ---------------------------------------------------------------------------

export type FleetStateTone = 'active' | 'success' | 'failure' | 'warn' | 'muted';

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
  // Wave-3 verb formalization: a distinct TERMINAL outcome from 'killed' —
  // both come from AgentManager.cancel(), but a graceful interrupt request
  // ('the operator asked nicely') is display-distinguishable from a hard
  // kill. '◌' verified free against every other glyph in this table.
  interrupted: '◌',
  idle: '·',
  queued: '…',
  // Wave-6 SDK: schedules/triggers/automation jobs report 'paused' when
  // disabled (previously mislabeled 'killed'). NOT terminal — resumable.
  // '❚' verified free against every other glyph in this table.
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
  // Wave 4 (wo703): orchestration-engine kinds (adapters/orchestration.ts).
  workstream: 'stream',
  phase: 'phase',
  'work-item': 'item',
  // Wave 5 (wo804): the repo source-tree code index (adapters/code-index.ts).
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

// ---------------------------------------------------------------------------
// Honest usage/cost helpers (W0.9 convention, ported from agent-inspector-shared.ts)
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

function compareNodes(a: ProcessNode, b: ProcessNode): number {
  const delta = (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity);
  if (delta !== 0) return delta;
  return a.id.localeCompare(b.id);
}

function appendSubtree(
  rows: FleetTreeRow[],
  node: ProcessNode,
  childrenByParent: Map<string, ProcessNode[]>,
  depth: number,
  ancestorPrefix: string,
  isLast: boolean,
  visited: Set<string>,
): void {
  if (visited.has(node.id)) return; // cycle guard
  visited.add(node.id);

  const children = (childrenByParent.get(node.id) ?? []).slice().sort(compareNodes);
  const treePrefix = depth === 0 ? '' : `${ancestorPrefix}${isLast ? '└─ ' : '├─ '}`;
  rows.push({ node, depth, treePrefix, isLastChild: isLast, hasChildren: children.length > 0 });

  const descendantPrefix = depth === 0 ? '' : `${ancestorPrefix}${isLast ? '   ' : '│  '}`;
  children.forEach((child, index) => {
    appendSubtree(rows, child, childrenByParent, depth + 1, descendantPrefix, index === children.length - 1, visited);
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

  const rows: FleetTreeRow[] = [];
  const visited = new Set<string>();

  for (const root of roots.slice().sort(compareNodes)) {
    appendSubtree(rows, root, childrenByParent, 0, '', true, visited);
  }

  // Defensive: nodes never reached because their entire ancestor chain forms
  // a cycle with no true root. Walked as pseudo-roots so they still render.
  const leftovers = nodes.filter((n) => !visited.has(n.id)).sort(compareNodes);
  for (const node of leftovers) {
    appendSubtree(rows, node, childrenByParent, 0, '', true, visited);
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
 * Wave 4 (wo703) additions — verified against adapters/orchestration.ts:
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
 * Wave 5 (wo804): 'code-index' is deliberately NOT in this set either —
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

  return { rows, totalCost, totalTokens, runningCount, capturedAt };
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
  /** Hard stop, optionally cascading to descendants. Returns the node ids acted on. */
  kill(id: string, opts?: { readonly cascade?: boolean }): readonly string[];
  /**
   * Wave-3 (W3.2): queue a human message for a live in-process agent (or a
   * wrfc-subtask's current live member), delivered at its next turn
   * boundary. Honest refusal (`{queued:false,reason}`) for anything that
   * cannot take mid-run input — see ProcessRegistry.steer's doc comment.
   */
  steer(id: string, text: string): SteerResult;
  /**
   * Wave-3 (W3.2): subscribe to the honest "the agent actually consumed this
   * steer at its turn boundary" signal (COMMUNICATION_CONSUMED on the
   * runtime bus's 'communication' domain). Returns an unsubscribe function.
   * A read-model constructed without a runtimeBus (e.g. the static factory,
   * or a test double) never invokes the listener — graceful no-op, matching
   * the steer()/steerable degrade-without-a-dep convention.
   */
  subscribeConsumed(listener: (event: SteerConsumedEvent) => void): () => void;
}

/** Narrow surface of ProcessRegistry this read-model depends on. */
export type FleetRegistryLike = Pick<ProcessRegistry, 'query' | 'subscribe' | 'interrupt' | 'kill' | 'steer'>;

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
  };
}

/** Create a static FleetReadModel for tests/goldens — no live registry, no timers. */
export function createStaticFleetReadModel(snapshot: FleetSnapshot): FleetReadModel {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    interrupt: () => false,
    kill: () => [],
    steer: () => ({ queued: false, reason: 'no live registry' }),
    subscribeConsumed: () => () => {},
  };
}
