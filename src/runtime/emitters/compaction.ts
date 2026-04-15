/**
 * emitters/compaction.ts
 *
 * Typed emission wrappers for the CompactionEvent domain.
 *
 * All emitter functions follow the same signature pattern as other domain
 * emitters: (bus, ctx, data) → void.
 */

import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '../events/index.ts';
import type { EmitterContext } from './index.ts';

/** Emit COMPACTION_CHECK when a threshold check is triggered. */
export function emitCompactionCheck(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; tokenCount: number; threshold: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_CHECK', { type: 'COMPACTION_CHECK', ...data }, ctx),
  );
}

/** Emit COMPACTION_MICROCOMPACT after a micro-compaction run. */
export function emitCompactionMicrocompact(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; turnCount: number; tokensBefore: number; tokensAfter: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_MICROCOMPACT', { type: 'COMPACTION_MICROCOMPACT', ...data }, ctx),
  );
}

/** Emit COMPACTION_COLLAPSE after a collapse compaction run. */
export function emitCompactionCollapse(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; messageCount: number; tokensBefore: number; tokensAfter: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_COLLAPSE', { type: 'COMPACTION_COLLAPSE', ...data }, ctx),
  );
}

/** Emit COMPACTION_AUTOCOMPACT when auto-compaction is triggered. */
export function emitCompactionAutocompact(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; strategy: string; tokensBefore: number; tokensAfter: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_AUTOCOMPACT', { type: 'COMPACTION_AUTOCOMPACT', ...data }, ctx),
  );
}

/** Emit COMPACTION_REACTIVE when reactive compaction is triggered. */
export function emitCompactionReactive(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; tokenCount: number; limit: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_REACTIVE', { type: 'COMPACTION_REACTIVE', ...data }, ctx),
  );
}

/** Emit COMPACTION_BOUNDARY_COMMIT when a boundary commit is persisted. */
export function emitCompactionBoundaryCommit(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; checkpointId: string },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope(
      'COMPACTION_BOUNDARY_COMMIT',
      { type: 'COMPACTION_BOUNDARY_COMMIT', ...data },
      ctx,
    ),
  );
}

/** Emit COMPACTION_DONE when a compaction lifecycle run completes successfully. */
export function emitCompactionDone(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; strategy: string; tokensBefore: number; tokensAfter: number; durationMs: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_DONE', { type: 'COMPACTION_DONE', ...data }, ctx),
  );
}

/** Emit COMPACTION_RESUME_REPAIR after a session resume repair pipeline run. */
export function emitCompactionResumeRepair(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; repaired: boolean; actionsCount: number; safeToResume: boolean },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope(
      'COMPACTION_RESUME_REPAIR',
      { type: 'COMPACTION_RESUME_REPAIR', ...data },
      ctx,
    ),
  );
}

/** Emit COMPACTION_QUALITY_SCORE after scoring a strategy run. */
export function emitCompactionQualityScore(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    sessionId: string;
    strategy: string;
    score: number;
    grade: string;
    compressionRatio: number;
    retentionScore: number;
    isLowQuality: boolean;
    description: string;
  },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_QUALITY_SCORE', { type: 'COMPACTION_QUALITY_SCORE', ...data }, ctx),
  );
}

/** Emit COMPACTION_STRATEGY_SWITCH when auto-escalation changes strategy due to low quality. */
export function emitCompactionStrategySwitch(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; fromStrategy: string; toStrategy: string; reason: string; score: number },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_STRATEGY_SWITCH', { type: 'COMPACTION_STRATEGY_SWITCH', ...data }, ctx),
  );
}

/** Emit COMPACTION_FAILED when a compaction lifecycle run fails. */
export function emitCompactionFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sessionId: string; strategy: string; error: string },
): void {
  bus.emit(
    'compaction',
    createEventEnvelope('COMPACTION_FAILED', { type: 'COMPACTION_FAILED', ...data }, ctx),
  );
}
