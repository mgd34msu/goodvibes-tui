/**
 * src/runtime/tools/index.ts — barrel and factory for the phased tool executor.
 *
 * Usage:
 * ```ts
 * import { createPhasedExecutor } from './runtime/tools/index.ts';
 *
 * const executor = createPhasedExecutor({
 *   enableHooks: true,
 *   enablePermissions: true,
 *   enableEvents: true,
 * });
 * const result = await executor.execute(call, tool, context);
 * ```
 */
export type { ToolExecutionPhase, PhaseResult, ToolExecutionRecord, ExecutorConfig } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';
export type {
  ToolRuntimeContext,
  RuntimeStoreAccess,
  TaskHooks,
} from '@pellux/goodvibes-sdk/platform/runtime/tools/context';
export { PhasedToolExecutor } from '@pellux/goodvibes-sdk/platform/runtime/tools/phased-executor';
export * from '@pellux/goodvibes-sdk/platform/runtime/tools/phases/index';

import { PhasedToolExecutor } from '@pellux/goodvibes-sdk/platform/runtime/tools/phased-executor';
import type { ExecutorConfig } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';

/** Default executor configuration. */
const DEFAULTS: ExecutorConfig = {
  enableHooks: true,
  enablePermissions: true,
  enableEvents: true,
};

/**
 * createPhasedExecutor — factory with sane defaults.
 *
 * Merges the provided partial config over the defaults so callers only
 * need to specify what they want to change.
 *
 * @param config - Optional overrides for ExecutorConfig.
 * @returns A fully configured PhasedToolExecutor instance.
 */
export function createPhasedExecutor(config?: Partial<ExecutorConfig>): PhasedToolExecutor {
  return new PhasedToolExecutor({ ...DEFAULTS, ...config });
}
