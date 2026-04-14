import type { JsonRecord } from './route-helpers.ts';

export type {
  ChannelAccountRegistryLike,
  DaemonIntegrationRouteContext,
  IntegrationHelperServiceLike,
  MemoryEmbeddingRegistryLike,
  MemoryRegistryLike,
  ProviderRuntimeSnapshotServiceLike,
  UserAuthManagerLike,
} from '@pellux/goodvibes-sdk-beta/daemon';
export type { DaemonRuntimeEventDomain as RuntimeEventDomain } from '@pellux/goodvibes-sdk-beta/daemon';

export interface IntegrationRuntimeStoreLike {
  getState(): {
    readonly deliveries: {
      readonly deliveryAttempts: Map<string, unknown>;
    };
  };
}
