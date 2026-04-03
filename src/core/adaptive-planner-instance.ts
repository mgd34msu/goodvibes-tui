/**
 * Shared singleton AdaptivePlanner instance.
 *
 * Import this wherever you need to consult or update the execution strategy.
 * The singleton pattern avoids prop-drilling through the orchestrator.
 */

import { AdaptivePlanner } from './adaptive-planner.ts';

export const adaptivePlanner = new AdaptivePlanner();
