/**
 * Per-turn knowledge injection record rendering.
 *
 * The SDK's passive per-turn retrieval engine
 * (packages/sdk/src/platform/agents/turn-knowledge-injection.ts) stores one
 * `TurnInjectionRecord` per turn on `AgentRecord.turnInjections` (a bounded
 * ring, default 20 entries) and appends the same record to the agent's
 * session transcript as `{type:'knowledge_injection', turn, ...record}`.
 *
 * `TurnInjectionRecord` was reachable only as the element type of
 * `AgentRecord.turnInjections`, so the entry type here was derived positionally
 * from that array rather than named. The `platform/agents` barrel exports the
 * record type now, and this names it.
 *
 * Reality check (since updated): the TUI's main interactive
 * session DOES route through this engine. The SDK `Orchestrator` runs per-turn
 * passive injection on the evolving primary conversation and records each turn
 * on its own bounded ring, exposed via `Orchestrator.getTurnInjections()` — the
 * main-session counterpart to `AgentRecord.turnInjections` (there is no
 * AgentRecord for the primary conversation). `buildMainSessionTurnInjectionsText`
 * renders that ring for `/recall injections` with no agent id. Spawned agents
 * (Task-tool runs, automation-triggered runs, session continuations) still
 * record onto their own `AgentRecord.turnInjections`, rendered per-agent by
 * `buildTurnInjectionsText` when an explicit agent id is given.
 */
import type { TurnInjectionRecord } from '@pellux/goodvibes-sdk/platform/agents';

/** One per-turn injection record, under the name this renderer already used. */
export type TurnInjectionEntry = TurnInjectionRecord;

function fmtN(n: number): string {
  return n.toLocaleString();
}

/**
 * Annotate each injected id with its source. Code-index hits get a
 * ` [code]` tag; memory records are left bare so a memory-only line renders
 * byte-identically to the output from before code-index hits existed.
 * `injectedSources` is parallel to `injectedIds`; a missing/short entry
 * defaults to memory (no tag).
 */
function labelInjectedIds(entry: TurnInjectionEntry): string {
  const sources = entry.injectedSources ?? [];
  return entry.injectedIds
    .map((id, i) => (sources[i] === 'code-index' ? `${id} [code]` : id))
    .join(', ');
}

/** Honest one-clause note when a wired code index was queried but injected nothing this turn. */
function codeSkipNote(entry: TurnInjectionEntry): string {
  return entry.codeInjectionSkipped ? `, code skipped: ${entry.codeInjectionSkipped}` : '';
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
    const codeConsidered = entry.codeCandidatesConsidered ? `, code considered ${entry.codeCandidatesConsidered}` : '';
    return `  turn ${entry.turn}: ${reasonText}${backendTag} (considered ${entry.candidatesConsidered}${codeConsidered}, floor ${entry.relevanceFloor})${codeSkipNote(entry)}`;
  }
  const droppedStr = entry.droppedForBudget.length > 0
    ? `, dropped for budget: ${entry.droppedForBudget.join(', ')}`
    : '';
  // The retrieval query is part of the record's honesty contract — without it
  // an injected line can't be traced back to WHY those ids were retrieved
  // (a replay finding flagged the omission). Truncated to keep the line scannable.
  const queryStr = entry.query ? ` for ${JSON.stringify(truncateQuery(entry.query))}` : '';
  return (
    `  turn ${entry.turn}: injected ${labelInjectedIds(entry)}${queryStr} ` +
    `(~${fmtN(entry.tokenCost)}/${fmtN(entry.budgetTokens)} tok, floor ${entry.relevanceFloor})${droppedStr}${backendTag}${codeSkipNote(entry)}`
  );
}

function truncateQuery(query: string): string {
  const flat = query.replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
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

/**
 * Render the MAIN interactive session's per-turn injection ring
 * (`Orchestrator.getTurnInjections()`), most-recent-turn first, with the
 * same honest empty state as the per-agent path. The main-session counterpart
 * to {@link buildTurnInjectionsText}: no agent id, main-session-appropriate
 * wording, but the identical per-entry rendering (`formatTurnInjectionEntry`).
 *
 * As with the agent path, an empty `entries` array is deliberately ambiguous
 * about WHY it's empty (flag disabled, no turn with new input has run yet, or
 * every turn's token budget had no headroom) — the ring does not distinguish
 * these, so this renders all three possibilities rather than guessing.
 */
export function buildMainSessionTurnInjectionsText(entries: readonly TurnInjectionEntry[]): string {
  if (entries.length === 0) {
    return (
      '[recall] No per-turn injection records for the main session yet. This means one of: ' +
      'passive knowledge injection is disabled, no turn with new input has run yet, or the ' +
      'token budget had no headroom on every turn so far — there is no record either way.'
    );
  }
  const lines = [`[recall] Per-turn knowledge injections for the main session (${entries.length}, most recent first):`];
  for (const entry of [...entries].reverse()) {
    lines.push(formatTurnInjectionEntry(entry));
  }
  return lines.join('\n');
}
