/**
 * Conversation domain state — tracks the active turn lifecycle,
 * message buffer, streaming deltas, and tool dispatch state.
 */

import type { TurnStopReason } from '@pellux/goodvibes-sdk/platform/runtime/events/turn';

/** States for the turn lifecycle machine. */
export type TurnState =
  | 'idle'
  | 'preflight'
  | 'streaming'
  | 'tool_dispatch'
  | 'post_hooks'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** States for the tool execution machine. */
export type ToolExecutionState =
  | 'received'
  | 'validated'
  | 'prehooked'
  | 'permissioned'
  | 'executing'
  | 'mapped'
  | 'posthooked'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** A lightweight record of an in-progress or recently completed tool call. */
export interface ActiveToolCall {
  /** Tool call ID from the provider. */
  callId: string;
  /** Tool name. */
  toolName: string;
  /** Serialized arguments (JSON string). */
  args: string;
  /** Current execution state. */
  state: ToolExecutionState;
  /** Epoch ms when this call entered the current state. */
  stateEnteredAt: number;
  /** Phase timestamps keyed by ToolExecutionState. */
  phaseTimestamps: Partial<Record<ToolExecutionState, number>>;
  /** Error message if state === 'failed'. */
  error?: string;
}

/** Token usage accumulated for the current or most recent turn. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

/** Streaming progress for the current turn. */
export interface StreamProgress {
  /** Accumulated text content so far. */
  accumulated: string;
  /** Latest reasoning delta (if any). */
  reasoningAccumulated: string;
  /** Compact preview of the most recent partial tool call streamed so far. */
  partialToolPreview?: string;
  /** Number of delta events received. */
  deltaCount: number;
  /** Epoch ms of the first delta. */
  firstDeltaAt?: number;
  /** Epoch ms of the most recent delta. */
  lastDeltaAt?: number;
}

export interface TurnReconciliationRecord {
  count: number;
  callIds: string[];
  toolNames: string[];
  reason: string;
  timestamp: number;
  isMalformed: boolean;
}

/**
 * ConversationDomainState — turn lifecycle and streaming state.
 */
export interface ConversationDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Turn lifecycle ─────────────────────────────────────────────────────────
  /** Current state of the turn lifecycle machine. */
  turnState: TurnState;
  /** Unique ID of the current turn (undefined when idle). */
  currentTurnId?: string;
  /** Epoch ms when the current turn started (undefined when idle). */
  turnStartedAt?: number;
  /** Epoch ms when the current turn completed/failed (undefined while active). */
  turnEndedAt?: number;
  /** Error from the most recent failed turn. */
  lastTurnError?: string;
  /** Explicit terminal reason for the most recently finished turn. */
  lastTurnStopReason?: TurnStopReason;
  /** Final assistant response for the most recently completed turn. */
  lastTurnResponse?: string;
  /** Most recent preflight failure message, if any. */
  lastPreflightFailure?: string;
  /** Total number of turns completed in this session. */
  totalTurns: number;

  // ── Streaming ──────────────────────────────────────────────────────────────
  /** Live streaming progress (populated during 'streaming' state). */
  stream: StreamProgress;

  // ── Tool dispatch ──────────────────────────────────────────────────────────
  /** Map of callId → ActiveToolCall for all in-flight tool calls. */
  activeToolCalls: Map<string, ActiveToolCall>;
  /** Count of tool calls dispatched in the current turn. */
  toolCallsThisTurn: number;
  /** Most recent reconciliation record for unresolved or malformed tool calls. */
  lastToolReconciliation?: TurnReconciliationRecord;

  // ── Token accounting ───────────────────────────────────────────────────────
  /** Usage for the current or most recent turn. */
  currentTurnUsage: TurnUsage;
  /** Cumulative usage across all turns in this session. */
  sessionUsage: TurnUsage;

  // ── Context window ─────────────────────────────────────────────────────────
  /** Estimated token count of the current context window. */
  estimatedContextTokens: number;
  /** Whether a context warning threshold has been crossed. */
  contextWarningActive: boolean;
  /** Message count in the current session conversation. */
  messageCount: number;
}

function makeEmptyUsage(): TurnUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

/**
 * Returns the default initial state for the conversation domain.
 */
export function createInitialConversationState(): ConversationDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    turnState: 'idle',
    currentTurnId: undefined,
    turnStartedAt: undefined,
    turnEndedAt: undefined,
    lastTurnError: undefined,
    lastTurnStopReason: undefined,
    lastTurnResponse: undefined,
    lastPreflightFailure: undefined,
    totalTurns: 0,
    stream: {
      accumulated: '',
      reasoningAccumulated: '',
      partialToolPreview: undefined,
      deltaCount: 0,
      firstDeltaAt: undefined,
      lastDeltaAt: undefined,
    },
    activeToolCalls: new Map(),
    toolCallsThisTurn: 0,
    lastToolReconciliation: undefined,
    currentTurnUsage: makeEmptyUsage(),
    sessionUsage: makeEmptyUsage(),
    estimatedContextTokens: 0,
    contextWarningActive: false,
    messageCount: 0,
  };
}
