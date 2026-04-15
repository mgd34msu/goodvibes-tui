/**
 * Planner emitters — typed emission wrappers for adaptive planner events.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '../events/index.ts';
import type { EmitterContext } from './index.ts';
import type { PlannerDecision, ExecutionStrategy } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';

export function emitPlanStrategySelected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  decision: PlannerDecision
): void {
  bus.emit('planner', createEventEnvelope('PLAN_STRATEGY_SELECTED', { type: 'PLAN_STRATEGY_SELECTED', ...decision }, ctx));
}

export function emitPlanStrategyOverridden(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { strategy: ExecutionStrategy | null; clearedBy?: string }
): void {
  bus.emit('planner', createEventEnvelope('PLAN_STRATEGY_OVERRIDDEN', { type: 'PLAN_STRATEGY_OVERRIDDEN', ...data }, ctx));
}
