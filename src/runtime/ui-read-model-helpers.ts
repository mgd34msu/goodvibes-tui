import type { RuntimeServices } from './services.ts';
import type { UiReadModel } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-base';

export function combineSubscriptions(...teardowns: Array<() => void>): () => void {
  return () => {
    for (const teardown of teardowns) {
      teardown();
    }
  };
}

export function createStoreBackedReadModel<TSnapshot>(
  runtimeServices: RuntimeServices,
  getSnapshot: () => TSnapshot,
): UiReadModel<TSnapshot> {
  return {
    getSnapshot,
    subscribe(listener) {
      return runtimeServices.runtimeStore.subscribe(listener);
    },
  };
}

export function listProviderIds(runtimeServices: RuntimeServices): readonly string[] {
  const providerIds = new Set<string>(
    runtimeServices.providerRegistry.listProviders().map((provider) => provider.name),
  );
  for (const model of runtimeServices.providerRegistry.listModels()) {
    providerIds.add(model.provider);
  }
  return [...providerIds].sort();
}
