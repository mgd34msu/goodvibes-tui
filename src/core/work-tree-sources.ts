/**
 * work-tree-sources.ts, the live facts the conversation work tree reads that
 * the message snapshot does not carry.
 *
 * A message snapshot says which tools were called and what they returned. It
 * does not say when they ran, which agent a call started or how that agent is
 * doing, or which call a permission prompt is holding. Those come from here,
 * read at render time, so the work tree states them without the transcript
 * format changing. Every field is optional: with no sources the work tree
 * still draws, just without times, agent lanes or waiting beads.
 */

import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

type Message = ConversationMessageSnapshot;

export interface CallTiming {
  /** Epoch ms the call started executing. */
  readonly startedAt?: number | undefined;
  /** Set once it settled. */
  readonly durationMs?: number | undefined;
}

/** How a finished turn ended. A completed turn's header says nothing extra; the others say so. */
export type TurnOutcome = 'completed' | 'failed' | 'cancelled';

export interface TurnTiming {
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  /** Set once the turn ended. */
  readonly outcome?: TurnOutcome | undefined;
  /**
   * userMessageFingerprint() of the user message the turn answered, when
   * known. A record whose fingerprint does not match the message now at its
   * index (the transcript was compacted, reset or replaced) is not this turn's.
   */
  readonly fingerprint?: string | undefined;
}

/**
 * A short identity for a user message: its length and opening text. Enough to
 * tell whether the message at an index is still the one a record was made
 * for, without hashing whole messages on every build.
 */
export function userMessageFingerprint(message: Message | undefined): string | undefined {
  if (!message || message.role !== 'user') return undefined;
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return `${text.length}:${text.slice(0, 80)}`;
}

/** One phase of a WRFC chain: the agent that ran it and what it found. */
export interface WrfcPhaseInfo {
  readonly agentId: string;
  readonly role: 'engineer' | 'reviewer' | 'fixer' | 'integrator' | 'verifier' | 'orchestrator' | 'owner';
  readonly task: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  /** A review's findings (the latest review report's issues), when this phase is that review. */
  readonly findings?: readonly string[] | undefined;
  /** Whether this review passed, when known. */
  readonly passed?: boolean | undefined;
  /** First lines of the phase agent's report. */
  readonly output?: string | undefined;
}

/** What the work tree needs about a spawned agent to draw its lane. */
export interface AgentLaneInfo {
  readonly id: string;
  /** The template or role name ("engineer", "tester"). */
  readonly name: string;
  readonly task: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly toolCallCount: number;
  /** Real cost in dollars when priced; undefined when not. */
  readonly costUsd?: number | undefined;
  readonly error?: string | undefined;
  /** The agent's own transcript (its tool calls become beads in its lane). */
  readonly messages: readonly Message[];
  /** Set when this agent owns a WRFC chain: its lane shows the chain's phases. */
  readonly wrfcPhases?: readonly WrfcPhaseInfo[] | undefined;
  /** Whether the chain passed, for a WRFC owner. */
  readonly wrfcPassed?: boolean | undefined;
  /** The harness name for an agent run by a hosted harness ("Claude Code"): it names the lane. */
  readonly hostedLabel?: string | undefined;
}

export interface WorkTreeSources {
  readonly callTiming?: ((callId: string) => CallTiming | undefined) | undefined;
  /** Wall time of the turn answering the user message at this absolute index. */
  readonly turnTiming?: ((userMessageIndex: number) => TurnTiming | undefined) | undefined;
  readonly agent?: ((agentId: string) => AgentLaneInfo | null) | undefined;
  /** Call ids a permission prompt is holding right now. */
  readonly waitingCallIds?: (() => ReadonlySet<string>) | undefined;
  /** Whether the main conversation is working on a turn right now. */
  readonly turnActive?: (() => boolean) | undefined;
  /**
   * How the turn answering the user message at this index ended, when it is
   * known from a live turn-end event or the session's saved record. Checked
   * against the message's fingerprint by the model.
   */
  readonly turnOutcome?: ((userMessageIndex: number) => { readonly outcome: TurnOutcome; readonly fingerprint: string } | undefined) | undefined;
  readonly now?: (() => number) | undefined;
}

/** Most calls whose timing is kept; the oldest go first. */
const MAX_CALLS = 5000;
/** Most turns whose timing is kept. */
const MAX_TURNS = 1000;

/**
 * Tool and turn timings, fed by the runtime's tool and turn events. Bounded:
 * a long session keeps the most recent MAX_CALLS calls and MAX_TURNS turns,
 * and a call that falls out simply renders without a time.
 */
export class WorkTreeTimingStore {
  private readonly calls = new Map<string, { startedAt?: number; durationMs?: number }>();
  private readonly turns = new Map<number, { startedAt: number; endedAt?: number; outcome?: TurnOutcome; fingerprint?: string }>();
  private openTurn: number | undefined;

  callStarted(callId: string, startedAt: number): void {
    const known = this.calls.get(callId);
    this.calls.delete(callId);
    this.calls.set(callId, { ...known, startedAt });
    this.trim(this.calls, MAX_CALLS);
  }

  callSettled(callId: string, durationMs: number | undefined, endedAt: number): void {
    const known = this.calls.get(callId);
    const started = known?.startedAt ?? (durationMs !== undefined ? endedAt - durationMs : undefined);
    const duration = durationMs ?? (started !== undefined ? endedAt - started : undefined);
    this.calls.delete(callId);
    this.calls.set(callId, { startedAt: started, durationMs: duration });
    this.trim(this.calls, MAX_CALLS);
  }

  turnStarted(userMessageIndex: number, startedAt: number, fingerprint?: string): void {
    this.turns.delete(userMessageIndex);
    this.turns.set(userMessageIndex, fingerprint !== undefined ? { startedAt, fingerprint } : { startedAt });
    this.openTurn = userMessageIndex;
    this.trim(this.turns, MAX_TURNS);
  }

  /**
   * Close the open turn with how it ended. Returns the closed turn's index and
   * record, or undefined when no turn was open.
   */
  turnEnded(endedAt: number, outcome: TurnOutcome = 'completed'): { readonly index: number; readonly timing: TurnTiming } | undefined {
    if (this.openTurn === undefined) return undefined;
    const index = this.openTurn;
    const turn = this.turns.get(index);
    this.openTurn = undefined;
    if (!turn) return undefined;
    if (turn.endedAt === undefined) {
      turn.endedAt = endedAt;
      turn.outcome = outcome;
    }
    return { index, timing: turn };
  }

  callTiming(callId: string): CallTiming | undefined {
    return this.calls.get(callId);
  }

  turnTiming(userMessageIndex: number): TurnTiming | undefined {
    return this.turns.get(userMessageIndex);
  }

  clear(): void {
    this.calls.clear();
    this.turns.clear();
    this.openTurn = undefined;
  }

  private trim<K, V>(map: Map<K, V>, max: number): void {
    while (map.size > max) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  }
}
