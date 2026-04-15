export { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks/dispatcher';
export { ChainEngine } from '@pellux/goodvibes-sdk/platform/hooks/chain-engine';
export { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks/activity';
export { HookWorkbench, createHookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks/workbench';
export { createHookApi } from '@pellux/goodvibes-sdk/platform/hooks/hook-api';
export type {
  CreateHookApiOptions,
  HookApi,
  HookApiDispatcher,
  HookApiWorkbenchRuntime,
  HookContractRecord,
  HookContractSource,
  HookWorkbenchApi,
} from '@pellux/goodvibes-sdk/platform/hooks/hook-api';
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
export type { HookAuthoringAction, HookConfigInspection, HookSimulationResult } from '@pellux/goodvibes-sdk/platform/hooks/workbench';
export type { HookExecutionMode, HookAuthority, HookPointContract } from '@pellux/goodvibes-sdk/platform/hooks/contracts';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
export {
  listHookPointContracts,
  getHookPointContract,
  parseHookPath,
} from '@pellux/goodvibes-sdk/platform/hooks/contracts';

import { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks/activity';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks/dispatcher';

export function createHookDispatcher(config: {
  readonly agentManager?: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>;
  readonly activityTracker?: HookActivityTracker;
} = {}): HookDispatcher {
  return new HookDispatcher(
    { agentManager: config.agentManager },
    config.activityTracker,
  );
}
