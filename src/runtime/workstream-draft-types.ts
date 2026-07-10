// ---------------------------------------------------------------------------
// workstream-draft-types.ts — the not-yet-launched proposal's data shape
//
// Extracted from workstream-services.ts purely to give the durable draft store
// (workstream-draft-store.ts) a type to persist WITHOUT importing back into the
// service construction module — that back-edge would form an import cycle the
// architecture check rejects. workstream-services.ts re-exports both types, so
// every existing importer (the /workstream command, the tests) keeps importing
// them from there unchanged.
// ---------------------------------------------------------------------------

import type { CreateWorkstreamInput } from '@pellux/goodvibes-sdk/platform/orchestration';
import type { DecompositionGate, PlanProposal } from '@pellux/goodvibes-sdk/platform/core';

/**
 * Honest provenance for how a draft's decomposition was produced. Derived from
 * the SDK decomposition service's outcome so the draft render can state plainly
 * whether a planning agent decomposed the goal, or the heuristic path did (and
 * if so, why).
 */
export interface WorkstreamDraftProvenance {
  readonly kind: 'agent' | 'heuristic-configured' | 'gate-declined' | 'fallback';
  readonly itemCount: number;
  readonly agentCostUsd?: number | undefined;
  readonly agentTokens?: number | undefined;
  readonly elapsedMs?: number | undefined;
  readonly fallbackReason?: string | undefined;
}

/** A not-yet-launched /workstream proposal. TUI-owned (the engine has no draft concept) and journaled to disk via workstream-draft-store.ts so it survives a restart. See workstream-services.ts's header doc. */
export interface WorkstreamDraft {
  readonly id: string;
  task: string;
  spec: CreateWorkstreamInput;
  readonly gate: DecompositionGate;
  /** The engine-agnostic decomposition proposal (model- or heuristic-produced). */
  proposal: PlanProposal;
  /** How that proposal came to be, for honest rendering. */
  provenance: WorkstreamDraftProvenance;
  approved: boolean;
  readonly createdAt: number;
}
