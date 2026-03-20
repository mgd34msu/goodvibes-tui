/**
 * Shared singleton ExecutionPlanManager instance.
 *
 * Import this wherever you need to read or update the active execution plan.
 * Using a module-level singleton avoids circular dependencies between the
 * orchestrator, WRFC controller, and plan manager.
 */

import { ExecutionPlanManager } from './execution-plan.ts';

export const planManager = new ExecutionPlanManager();
