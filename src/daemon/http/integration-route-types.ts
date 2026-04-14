import type { JsonRecord } from './route-helpers.ts';

export type RuntimeEventDomain = string;

export interface IntegrationRuntimeStoreLike {
  getState(): {
    readonly deliveries: {
      readonly deliveryAttempts: Map<string, unknown>;
    };
  };
}

export interface IntegrationHelperServiceLike {
  buildReview(): unknown;
  getSessionSnapshot(): unknown;
  getTaskSnapshot(): unknown;
  getAutomationSnapshot(): unknown;
  getSessionBrokerSnapshot(): unknown;
  getDeliverySnapshot(): unknown;
  getRouteSnapshot(): unknown;
  getRemoteSnapshot(): unknown;
  getHealthSnapshot(): unknown;
  getAccountsSnapshot(): Promise<Record<string, unknown>>;
  getSettingsSnapshot(): unknown;
  getContinuitySnapshot(): unknown;
  getWorktreeSnapshot(): unknown;
  getIntelligenceSnapshot(): unknown;
  getLocalAuthSnapshot(): unknown;
  listPanels(): readonly unknown[];
  openPanel(panelId: string, pane: 'top' | 'bottom'): boolean;
  createEventStream(req: Request, domains: readonly RuntimeEventDomain[]): Response | Promise<Response>;
  getRuntimeStore(): IntegrationRuntimeStoreLike | null;
}

export interface ChannelAccountRegistryLike {
  listAccounts(): Promise<unknown[]>;
}

export interface ProviderRuntimeSnapshotServiceLike {
  listSnapshots(): Promise<readonly unknown[]>;
  getSnapshot(providerId: string): Promise<unknown | null>;
  getUsageSnapshot(providerId: string): Promise<unknown | null>;
}

export interface MemoryRegistryLike {
  doctor(): Promise<unknown>;
  vectorStats(): unknown;
  rebuildVectorsAsync(): Promise<unknown>;
}

export interface MemoryEmbeddingRegistryLike {
  setDefaultProvider(providerId: string): void;
}

export interface UserAuthManagerLike {
  addUser(username: string, password: string, roles: readonly string[]): unknown;
  deleteUser(username: string): boolean;
  rotatePassword(username: string, password: string): void;
  revokeSession(sessionId: string): boolean;
  clearBootstrapCredentialFile(): boolean;
}

export interface DaemonIntegrationRouteContext {
  readonly channelPlugins: ChannelAccountRegistryLike;
  readonly integrationHelpers: IntegrationHelperServiceLike | null;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingRegistryLike;
  readonly memoryRegistry: MemoryRegistryLike;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly providerRuntime: ProviderRuntimeSnapshotServiceLike;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly userAuth: UserAuthManagerLike;
}
