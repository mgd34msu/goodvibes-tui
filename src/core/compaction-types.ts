/**
 * compaction-types.ts
 *
 * Shared types for the prompt compaction engine.
 */

import type { ProviderMessage } from '../providers/interface.ts';
import type { SessionMemory } from './session-memory.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import type { WrfcChain } from '../agents/wrfc-types.ts';
import type { ExecutionPlan } from './execution-plan.ts';

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

/** A single compacted output section. */
export interface CompactionSection {
  /** Unique identifier for this section (e.g. 'handoff-header', 'current-task'). */
  id: string;
  /** Section heading text (e.g. '## Current Task'). Empty string for the handoff header. */
  header: string;
  /** Body content for this section. */
  content: string;
  /** Estimated token count for this section. */
  tokens: number;
}

/** Per-section token budgets and threshold configuration. */
export interface CompactionConfig {
  /** Max tokens for recent conversation gather (default: 3000). */
  recentConversationBudget: number;
  /** Max tokens for tool results section (default: 1500). */
  toolResultsBudget: number;
  /** Max tokens for agent activity table (default: 1500). */
  agentActivityBudget: number;
  /** Max tokens for older agent summary (default: 500). */
  olderAgentSummaryBudget: number;
  /** Max tokens for resolved problems section (default: 300). */
  resolvedProblemsBudget: number;
  /** Overall ceiling for entire compacted output (default: 6500). */
  totalCeiling: number;
}

/** Default compaction configuration. */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  recentConversationBudget: 3000,
  toolResultsBudget: 1500,
  agentActivityBudget: 1500,
  olderAgentSummaryBudget: 500,
  resolvedProblemsBudget: 300,
  totalCeiling: 6500,
};

// ---------------------------------------------------------------------------
// Session memory (re-exported for consumers of this module)
// ---------------------------------------------------------------------------

export type { SessionMemory };

// ---------------------------------------------------------------------------
// Token estimation utility (here to avoid circular imports)
// ---------------------------------------------------------------------------

/** Rough token estimate for a string: 4 chars ≈ 1 token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Context data sources (read-only, passed in as plain data — no singletons)
// ---------------------------------------------------------------------------

/** All data sources needed for compaction. Accept as plain data; do not import singletons. */
export interface CompactionContext {
  /** Current conversation messages (as sent to LLM — no system messages). */
  messages: ProviderMessage[];

  /** Pinned session memories (survive all compactions). */
  sessionMemories: readonly SessionMemory[];

  /** All agent records from AgentManager.list(). */
  agents: AgentRecord[];

  /** All WRFC chains from WrfcController.listChains(). */
  wrfcChains: WrfcChain[];

  /** Active execution plan, or null if none. */
  activePlan: ExecutionPlan | null;

  /** Append-only session lineage log entries (one per prior compaction). */
  lineageEntries: string[];

  /** Original task description for lineage. Set on first compaction. */
  originalTask?: string;

  /** Number of compactions performed so far (including this one). */
  compactionCount: number;

  /** Context window size for the current model (used for threshold scaling). */
  contextWindow: number;

  /** Whether this compaction was triggered automatically or manually. */
  trigger: 'auto' | 'manual';

  /** Model ID used for LLM extraction calls. */
  extractionModelId: string;

  /** Optional provider name for extraction model disambiguation. */
  extractionProvider?: string;
}

// ---------------------------------------------------------------------------
// Compaction events and results
// ---------------------------------------------------------------------------

/** Record of a completed compaction event. */
export interface CompactionEvent {
  timestamp: number;
  messagesBeforeCompaction: number;
  messagesAfterCompaction: number;
  tokensBeforeEstimate: number;
  tokensAfterEstimate: number;
  modelId: string;
  trigger: 'auto' | 'manual';
  /** Sections included in this compaction (IDs). */
  sectionsIncluded?: string[];
  /** Whether post-compaction validation passed. */
  validationPassed?: boolean;
}

/** Result of a compaction operation. */
export interface CompactionResult {
  /** The new compacted message list (single user message containing the handoff). */
  messages: ProviderMessage[];
  /** The full compacted context text. */
  summary: string;
  /** Token estimates before and after compaction. */
  tokensBeforeEstimate: number;
  tokensAfterEstimate: number;
  /** The compaction event record for tracking. */
  event: CompactionEvent;
  /** Sections that were included (for debugging). */
  sections: CompactionSection[];
  /** Post-compaction validation warnings (empty = all checks passed). */
  validationWarnings: string[];
}
