export { HookDispatcher } from './dispatcher.ts';
export { ChainEngine } from './chain-engine.ts';
export { HookActivityTracker } from './activity.ts';
export { HookWorkbench, createHookWorkbench } from './workbench.ts';
export { createHookApi } from './hook-api.ts';
export type {
  CreateHookApiOptions,
  HookApi,
  HookApiDispatcher,
  HookApiWorkbenchRuntime,
  HookContractRecord,
  HookContractSource,
  HookWorkbenchApi,
} from './hook-api.ts';
export type {
  HookPhase,
  HookCategory,
  HookEventPath,
  HookEvent,
  HookResult,
  HookType,
  HookDefinition,
  ChainStep,
  HookChain,
  HooksConfig,
} from './types.ts';
export type { HookActivityRecord } from './activity.ts';
export type { HookAuthoringAction, HookConfigInspection, HookSimulationResult } from './workbench.ts';
export type { HookExecutionMode, HookAuthority, HookPointContract } from './contracts.ts';
import type { AgentManager } from '../tools/agent/index.ts';
export {
  listHookPointContracts,
  getHookPointContract,
  parseHookPath,
} from './contracts.ts';

import { HookActivityTracker } from './activity.ts';
import { HookDispatcher } from './dispatcher.ts';

export function createHookDispatcher(config: {
  readonly agentManager?: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>;
  readonly activityTracker?: HookActivityTracker;
} = {}): HookDispatcher {
  return new HookDispatcher(
    { agentManager: config.agentManager },
    config.activityTracker,
  );
}
