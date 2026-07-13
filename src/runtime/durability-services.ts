/**
 * durability-services.ts — the data-safety and remembered-decision stores the
 * daemon composition wires (mirrors the SDK's own createRuntimeServices):
 *
 *  - StoreSnapshotScheduler: a daily snapshot of every SQLite store this
 *    runtime writes (memory store, memory vector index, code index store),
 *    bounded by the retention engine. Timers are unref'd so an undisposed
 *    scheduler cannot pin the event loop; hosts that tear down a runtime
 *    stop() it themselves.
 *  - UserPermissionRuleStore: durable user-origin permission rules
 *    (remembered approvals) — one store per project, shared by every
 *    PermissionManager built on this runtime; permissions.rules.*
 *    lists/deletes. Background init is fail-safe (asks just prompt).
 *  - One credential chain (env -> secrets -> subscription): boot applies
 *    secrets-backed keys; every secrets write/delete re-registers builtins
 *    LIVE (no restart) — badges/picker/chat read the same instances.
 */
import { join } from 'node:path';
import { resolveMemoryVectorDbPath } from '@pellux/goodvibes-sdk/platform/state';
import { StoreSnapshotScheduler } from '@pellux/goodvibes-sdk/platform/state/store-snapshots';
import { UserPermissionRuleStore } from '@pellux/goodvibes-sdk/platform/permissions';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export interface DurabilityServicesInput {
  readonly configManager: { getControlPlaneConfigDir(): string };
  readonly secretsManager: { onDidChange(listener: (key: string) => void): () => void };
  readonly providerRegistry: { refreshProviderCredentials(): Promise<void> };
  readonly memoryDbPath: string;
  readonly codeIndexDbPath: string;
}

export interface DurabilityServices {
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  readonly userPermissionRuleStore: UserPermissionRuleStore;
}

export function createDurabilityServices(input: DurabilityServicesInput): DurabilityServices {
  const { configManager, secretsManager, providerRegistry } = input;
  secretsManager.onDidChange(() => void providerRegistry.refreshProviderCredentials().catch((error) => logger.warn('live credential refresh failed', { error: summarizeError(error) })));
  void providerRegistry.refreshProviderCredentials().catch((error) => logger.warn('boot credential refresh failed', { error: summarizeError(error) }));

  const storeSnapshotScheduler = new StoreSnapshotScheduler({
    stores: [
      { name: 'memory store', dbPath: input.memoryDbPath },
      { name: 'memory vector index', dbPath: resolveMemoryVectorDbPath(input.memoryDbPath) },
      { name: 'code index store', dbPath: input.codeIndexDbPath },
    ],
  });
  storeSnapshotScheduler.start();

  const userPermissionRuleStore = new UserPermissionRuleStore(join(configManager.getControlPlaneConfigDir(), 'permission-rules.json'));
  void userPermissionRuleStore.init().catch((error) => logger.warn('user permission rule store init failed; asks will prompt', { error: summarizeError(error) }));

  return { storeSnapshotScheduler, userPermissionRuleStore };
}
