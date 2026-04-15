export { HookDispatcher } from './dispatcher.ts';
export { ChainEngine } from './chain-engine.ts';
export { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks/activity';
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
} from '@pellux/goodvibes-sdk/platform/hooks/types';
export type { HookActivityRecord } from '@pellux/goodvibes-sdk/platform/hooks/activity';
export type { HookAuthoringAction, HookConfigInspection, HookSimulationResult } from './workbench.ts';
export type { HookExecutionMode, HookAuthority, HookPointContract } from '@pellux/goodvibes-sdk/platform/hooks/contracts';
import type { AgentManager } from '../tools/agent/index.ts';
export {
  listHookPointContracts,
  getHookPointContract,
  parseHookPath,
} from '@pellux/goodvibes-sdk/platform/hooks/contracts';

import { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks/activity';
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
