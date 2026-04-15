import { createProviderApi, type ProviderApi } from '@pellux/goodvibes-sdk/platform/providers/provider-api';
import type { RuntimeServices } from './services.ts';

export interface RuntimeProviderApiServices extends Pick<
  RuntimeServices,
  'benchmarkStore' | 'favoritesStore' | 'providerRegistry'
> {}

export function createRuntimeProviderApi(
  runtimeServices: RuntimeProviderApiServices,
): ProviderApi {
  return createProviderApi({
    providerRegistry: runtimeServices.providerRegistry,
    favoritesStore: runtimeServices.favoritesStore,
    benchmarkStore: runtimeServices.benchmarkStore,
  });
}

