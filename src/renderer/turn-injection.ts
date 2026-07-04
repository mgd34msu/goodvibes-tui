/**
 * Per-turn knowledge injection record rendering (Wave-5 W5.2, wo803).
 *
 * The SDK's passive per-turn retrieval engine (wo801, W5.1 —
 * packages/sdk/src/platform/agents/turn-knowledge-injection.ts) stores one
 * `TurnInjectionRecord` per turn on `AgentRecord.turnInjections` (a bounded
 * ring, default 20 entries) and appends the same record to the agent's
 * session transcript as `{type:'knowledge_injection', turn, ...record}`.
 *
 * `TurnInjectionRecord` itself is not re-exported from the SDK's
 * `platform/agents` barrel (only `AgentRecord.turnInjections` carries its
 * structural shape through the already-public `platform/tools` barrel), so
 * the entry type here is DERIVED from `AgentRecord` rather than imported by
 * name — this needs no SDK export change.
 *
 * Reality check (wo803): the TUI's main interactive session does not
 * currently route through this engine at all — `runAgentTask` (where the
 * per-turn injection call lives) only ever runs for agents spawned via
 * `AgentManager.spawn()` (Task-tool runs, automation-triggered runs, session
 * continuations). The main session's system prompt is built directly in
 * `runtime/bootstrap.ts` (`runtime.systemPrompt` + guardrails + tier
 * supplement) with no knowledge injection, spawn-time or per-turn. So
 * `turnInjections` will only ever be populated for spawned agents; callers
 * must not claim otherwise for the main session (see the usage text in
 * `/recall injections`, recall-review.ts).
 */
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';

/** One TurnInjectionRecord entry, derived from AgentRecord (see module doc). */
export type TurnInjectionEntry = NonNullable<AgentRecord['turnInjections']>[number];

function fmtN(n: number): string {
  return n.toLocaleString();
}

/** Render a single TurnInjectionRecord as one readable line. */
export function formatTurnInjectionEntry(entry: TurnInjectionEntry): string {
  const backendTag = entry.embeddingBackend === 'fallback-lexical' ? ' [lexical fallback]' : '';
  if (entry.injectedIds.length === 0) {
    // Honest empty state: the engine ran this turn but injected nothing —
    // distinct from "the engine never ran" (see buildTurnInjectionsText).
    const reasonText = entry.reason === 'no records cleared relevance floor'
      ? 'nothing injected this turn — nothing cleared the relevance floor'
      : `nothing injected this turn — ${entry.reason ?? 'unknown reason'}`;
    return `  turn ${entry.turn}: ${reasonText}${backendTag} (considered ${entry.candidatesConsidered}, floor ${entry.relevanceFloor})`;
  }
  const droppedStr = entry.droppedForBudget.length > 0
    ? `, dropped for budget: ${entry.droppedForBudget.join(', ')}`
    : '';
  return (
    `  turn ${entry.turn}: injected ${entry.injectedIds.join(', ')} ` +
    `(~${fmtN(entry.tokenCost)}/${fmtN(entry.budgetTokens)} tok, floor ${entry.relevanceFloor})${droppedStr}${backendTag}`
  );
}

/**
 * Render the full per-turn injection history for one agent, most-recent-turn
 * first, with an honest empty state when nothing has been recorded yet.
 *
 * An empty `entries` array is deliberately ambiguous about WHY it's empty
 * (flag disabled, no turn with new input has run yet, or every turn's token
 * budget had no headroom) — the SDK does not distinguish these cases in the
 * ring itself, so this renders all three possibilities rather than guessing.
 */
export function buildTurnInjectionsText(agentId: string, entries: readonly TurnInjectionEntry[]): string {
  if (entries.length === 0) {
    return (
      `[recall] No per-turn injection records for agent ${agentId} yet. This means one of: ` +
      'passive knowledge injection is disabled, no turn with new input has run yet, or the ' +
      'token budget had no headroom on every turn so far — there is no record either way.'
    );
  }
  const lines = [`[recall] Per-turn knowledge injections for agent ${agentId} (${entries.length}, most recent first):`];
  for (const entry of [...entries].reverse()) {
    lines.push(formatTurnInjectionEntry(entry));
  }
  return lines.join('\n');
}
