export { HookDispatcher } from './dispatcher.ts';
export { ChainEngine } from './chain-engine.ts';
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

import { HookDispatcher } from './dispatcher.ts';

let _hookDispatcher: HookDispatcher | undefined;
export function getHookDispatcher(): HookDispatcher {
  if (!_hookDispatcher) _hookDispatcher = new HookDispatcher();
  return _hookDispatcher;
}
