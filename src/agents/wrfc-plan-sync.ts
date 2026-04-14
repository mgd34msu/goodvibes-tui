import type { ExecutionPlanManager } from '../core/execution-plan.ts';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

export function completePlanItemsForAgent(
  agentId: string,
  planManager: Pick<ExecutionPlanManager, 'getActive' | 'updateItem'>,
): void {
  const activePlan = planManager.getActive();
  if (!activePlan) return;

  const matchingItems = activePlan.items.filter(
    (item) => item.agentId === agentId && item.status !== 'complete' && item.status !== 'failed',
  );

  for (const item of matchingItems) {
    try {
      planManager.updateItem(activePlan.id, item.id, 'complete', agentId);
    } catch (error) {
      logger.warn('WrfcController: failed to auto-update plan item', {
        planId: activePlan.id,
        itemId: item.id,
        agentId,
        error: summarizeError(error),
      });
    }
  }
}
