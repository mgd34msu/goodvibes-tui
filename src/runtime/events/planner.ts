/**
 * PlannerEvent — discriminated union for adaptive planner decisions and overrides.
 */
import type { PlannerDecision, ExecutionStrategy } from '../../core/adaptive-planner.ts';

export type PlannerEvent =
  | ({
    type: 'PLAN_STRATEGY_SELECTED';
  } & PlannerDecision)
  | {
    type: 'PLAN_STRATEGY_OVERRIDDEN';
    strategy: ExecutionStrategy | null;
    clearedBy?: string;
  };

export type PlannerEventType = PlannerEvent['type'];
