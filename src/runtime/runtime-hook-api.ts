import { createHookApi, type HookApi } from '../hooks/hook-api.ts';

export function createRuntimeHookApi(options: Parameters<typeof createHookApi>[0]): HookApi {
  return createHookApi(options);
}
