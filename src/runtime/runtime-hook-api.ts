import { createHookApi, type HookApi } from '@pellux/goodvibes-sdk/platform/hooks/hook-api';

export function createRuntimeHookApi(options: Parameters<typeof createHookApi>[0]): HookApi {
  return createHookApi(options);
}
