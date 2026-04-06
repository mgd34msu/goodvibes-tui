export { HookDispatcher } from './dispatcher.ts';
export { ChainEngine } from './chain-engine.ts';
export { HookActivityTracker, getHookActivityTracker } from './activity.ts';
export { getHookWorkbench, _resetHookWorkbenchForTesting } from './workbench.ts';
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
export type { HookAuthoringAction, HookSimulationResult } from './workbench.ts';
export type { HookExecutionMode, HookAuthority, HookPointContract } from './contracts.ts';
export {
  listHookPointContracts,
  getHookPointContract,
  parseHookPath,
} from './contracts.ts';

import { HookDispatcher } from './dispatcher.ts';

let _hookDispatcher: HookDispatcher | undefined;
export function getHookDispatcher(): HookDispatcher {
  if (!_hookDispatcher) _hookDispatcher = new HookDispatcher();
  return _hookDispatcher;
}
