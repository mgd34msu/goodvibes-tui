/**
 * phases/index.ts — barrel export for all tool execution phase functions.
 *
 * Each export is a pure async function conforming to PhaseFunction.
 * The pipeline is assembled in phased-executor.ts.
 */
export { validatePhase } from './validate.ts';
export { prehookPhase } from './prehook.ts';
export { permissionPhase } from './permission.ts';
export { budgetPhase } from './budget.ts';
export { executePhase } from './execute.ts';
export { mapOutputPhase } from './map-output.ts';
export { posthookPhase } from './posthook.ts';
