// ---------------------------------------------------------------------------
// cockpit-read-model.ts
//
// TASK-046: Cockpit agent roster slice + cost/token aggregates + stalledAgentCount
//
// Provides a thin read-model over AgentManager.list() / getStatus() so the
// CockpitPanel can display an agent roster without depending on the full
// AgentInspectorPanel object.
//
// Design notes:
//   - Per-agent cost delegates to calcSessionCost() from cost-utils.ts (canonical
//     billing formula) and requires real usage data from AgentRecord.usage.  When
//     usage is absent (agent spawned but not yet completed), cost/tokens show as n/a
//     rather than fabricated values (39327f86 honest-UX standard).
//   - stalledAgentCount delegates to countStalledAgents() from agent-inspector-shared.ts
//     (canonical stall-count function extracted from TASK-046 review) — no reimplementation.
//   - The read-model is a plain object (snapshot + subscribe) so it can be
//     wired in tests without a full runtime.
// ---------------------------------------------------------------------------

import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import { calcSessionCost } from '../export/cost-utils.ts';
import {
  AGENT_TERMINAL_STATUSES,
  AGENT_STALL_THRESHOLD_MS,
  countStalledAgents,
} from './agent-inspector-shared.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Status of a single agent in the cockpit roster. */
export type CockpitAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** A single row in the cockpit agent roster. */
export interface CockpitAgentRosterEntry {
  /** Full agent id. */
  readonly id: string;
  /** Short task description (truncated at 50 chars). */
  readonly task: string;
  /** Model identifier, or 'unknown' when not yet resolved. */
  readonly model: string;
  /** Agent lifecycle status. */
  readonly status: CockpitAgentStatus;
  /** True when the agent is non-terminal and has exceeded AGENT_STALL_THRESHOLD_MS. */
  readonly stalled: boolean;
  /** Input tokens consumed (including cache read+write), or null when unavailable. */
  readonly inputTokens: number | null;
  /** Output tokens produced, or null when unavailable. */
  readonly outputTokens: number | null;
  /** Estimated cost in USD, or null when token data is unavailable. */
  readonly cost: number | null;
}

/** Aggregate snapshot produced by the cockpit roster read-model. */
export interface CockpitRosterSnapshot {
  /** All agents in the manager, newest-first by startedAt. */
  readonly roster: readonly CockpitAgentRosterEntry[];
  /** Number of non-terminal agents running past AGENT_STALL_THRESHOLD_MS. */
  readonly stalledAgentCount: number;
  /**
   * Sum of all input tokens across agents with real usage data.
   * null when NO agent has usage data yet (avoids showing 0 when data is simply absent).
   */
  readonly totalInputTokens: number | null;
  /**
   * Sum of all output tokens across agents with real usage data.
   * null when NO agent has usage data yet.
   */
  readonly totalOutputTokens: number | null;
  /**
   * Total estimated cost in USD across agents with real pricing data.
   * null when NO agent has priceable data yet.
   */
  readonly totalCost: number | null;
}

// ---------------------------------------------------------------------------
// AgentManager minimal interface (subset used here)
// ---------------------------------------------------------------------------

export interface CockpitRosterAgentManager {
  list(): AgentRecord[];
}

// ---------------------------------------------------------------------------
// Snapshot builder — pure, testable
// ---------------------------------------------------------------------------

/**
 * Build a CockpitRosterSnapshot from a raw AgentRecord list.
 * Exported so unit tests can drive it directly without a manager stub.
 */
export function buildCockpitRosterSnapshot(
  records: AgentRecord[],
  now: number = Date.now(),
): CockpitRosterSnapshot {
  // Sort newest-first by startedAt
  const sorted = [...records].sort((a, b) => b.startedAt - a.startedAt);

  let hasUsage = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;

  const roster: CockpitAgentRosterEntry[] = sorted.map((rec) => {
    const isTerminal = AGENT_TERMINAL_STATUSES.has(rec.status);
    const elapsed = now - rec.startedAt;
    const stalled = !isTerminal && elapsed >= AGENT_STALL_THRESHOLD_MS;

    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cost: number | null = null;

    if (rec.usage) {
      hasUsage = true;
      const inp =
        rec.usage.inputTokens +
        (rec.usage.cacheReadTokens ?? 0) +
        (rec.usage.cacheWriteTokens ?? 0);
      const out = rec.usage.outputTokens;
      const agentCost = calcSessionCost(
        rec.usage.inputTokens,
        rec.usage.outputTokens,
        rec.usage.cacheReadTokens ?? 0,
        rec.usage.cacheWriteTokens ?? 0,
        rec.model ?? 'unknown',
      );

      inputTokens = inp;
      outputTokens = out;
      cost = agentCost;

      totalInputTokens += inp;
      totalOutputTokens += out;
      totalCost += agentCost;
    }

    const task = rec.task.length > 50 ? rec.task.slice(0, 47) + '...' : rec.task;

    return {
      id: rec.id,
      task,
      model: rec.model ?? 'unknown',
      status: rec.status,
      stalled,
      inputTokens,
      outputTokens,
      cost,
    };
  });

  return {
    roster,
    stalledAgentCount: countStalledAgents(sorted, now),
    totalInputTokens: hasUsage ? totalInputTokens : null,
    totalOutputTokens: hasUsage ? totalOutputTokens : null,
    totalCost: hasUsage ? totalCost : null,
  };
}

// ---------------------------------------------------------------------------
// Read-model factory
// ---------------------------------------------------------------------------

/** Minimal read-model interface matching the existing UiReadModel shape. */
export interface CockpitRosterReadModel {
  getSnapshot(): CockpitRosterSnapshot;
  /**
   * Notify all subscribers that the roster has changed and the cockpit panel
   * should re-render.  Wire this to an AgentManager event feed so live agent
   * state changes propagate:
   *
   *   const roster = createCockpitRosterReadModel(agentManager);
   *   agentEvents.subscribe(() => roster.markDirty());
   *
   * For static/test fixtures the implementation is a no-op.
   */
  markDirty(): void;
  /**
   * Subscribe to changes.  The listener is called whenever markDirty() is
   * invoked.  Returns an unsubscribe function.
   *
   * For static/test fixtures, returns a no-op unsubscribe.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * Create a live CockpitRosterReadModel backed by an AgentManager.
 *
 * The returned read-model re-derives its snapshot on every getSnapshot() call
 * so it always reflects the current agent state without needing an event bus.
 * Callers that want reactive updates should poll or wire in their own
 * event-driven markDirty() path.
 */
export function createCockpitRosterReadModel(
  agentManager: CockpitRosterAgentManager,
): CockpitRosterReadModel {
  const listeners = new Set<() => void>();

  function markDirty(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getSnapshot(): CockpitRosterSnapshot {
      return buildCockpitRosterSnapshot(agentManager.list());
    },
    markDirty,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Create a static CockpitRosterReadModel for testing.
 */
export function createStaticCockpitRosterReadModel(
  snapshot: CockpitRosterSnapshot,
): CockpitRosterReadModel {
  return {
    getSnapshot: () => snapshot,
    markDirty: () => {},
    subscribe: () => () => {},
  };
}
