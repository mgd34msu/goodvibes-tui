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
} from '@pellux/goodvibes-sdk/platform/runtime/fleet';

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
  idle: '·',
  queued: '…',
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
  idle: 'muted',
  queued: 'muted',
};

/** Terminal states — interrupt/kill are not offered; not counted as running. */
const TERMINAL_STATES = new Set<ProcessState>(['done', 'failed', 'killed']);

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

/** Build the full FleetSnapshot (rows + honest aggregates) from a flat node list. */
export function buildFleetSnapshot(nodes: readonly ProcessNode[], capturedAt: number = Date.now()): FleetSnapshot {
  const rows = buildFleetRows(nodes);

  let totalCost: number | null = null;
  let totalTokens: number | null = null;
  let runningCount = 0;

  for (const node of nodes) {
    if (hasFleetCost(node.costUsd, node.costState)) {
      totalCost = (totalCost ?? 0) + (node.costUsd as number);
    }
    const tokens = fleetUsageTokens(node.usage);
    if (tokens !== null) {
      totalTokens = (totalTokens ?? 0) + tokens;
    }
    if (isRunningProcessState(node.state)) runningCount++;
  }

  return { rows, totalCost, totalTokens, runningCount, capturedAt };
}

// ---------------------------------------------------------------------------
// Read-model — two-factory shape (live / static), mirrors cockpit-read-model.ts
// ---------------------------------------------------------------------------

export interface FleetReadModel {
  getSnapshot(): FleetSnapshot;
  /** Subscribe to fleet changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Graceful interruption where the source supports one. Returns true when accepted. */
  interrupt(id: string): boolean;
  /** Hard stop, optionally cascading to descendants. Returns the node ids acted on. */
  kill(id: string, opts?: { readonly cascade?: boolean }): readonly string[];
}

/** Narrow surface of ProcessRegistry this read-model depends on. */
export type FleetRegistryLike = Pick<ProcessRegistry, 'query' | 'subscribe' | 'interrupt' | 'kill'>;

/** Create a live FleetReadModel backed by the SDK's ProcessRegistry. */
export function createFleetReadModel(registry: FleetRegistryLike): FleetReadModel {
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
  };
}

/** Create a static FleetReadModel for tests/goldens — no live registry, no timers. */
export function createStaticFleetReadModel(snapshot: FleetSnapshot): FleetReadModel {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    interrupt: () => false,
    kill: () => [],
  };
}
