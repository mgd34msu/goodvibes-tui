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
 *  - Start-time retention janitor: one best-effort append-only sweep over
 *    EVERY root the composition knows (working dir, surface root, home,
 *    logDir, telemetryDir) — omitting logDir/telemetryDir/home would silently
 *    skip the activity-log, telemetry-ledger, and recovery-snapshot stores.
 *  - Live config-file watch: external edits to the settings file apply through
 *    the same subscribe() pipeline an in-process set() uses — no restart. The
 *    underlying watchers are unref'd, so this never pins the event loop.
 */
import { join } from 'node:path';
import { operations } from '@pellux/goodvibes-sdk/platform/runtime';
import { resolveMemoryVectorDbPath } from '@pellux/goodvibes-sdk/platform/state';
import { StoreSnapshotScheduler } from '@pellux/goodvibes-sdk/platform/state/store-snapshots';
import { UserPermissionRuleStore } from '@pellux/goodvibes-sdk/platform/permissions';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { SessionSurface } from '@/runtime/index.ts';

export interface DurabilityServicesInput {
  readonly configManager: {
    getControlPlaneConfigDir(): string;
    get(key: never): unknown;
    watchConfigFiles(options?: { intervalMs?: number }): () => void;
  };
  readonly secretsManager: { onDidChange(listener: (key: string) => void): () => void };
  readonly providerRegistry: { refreshProviderCredentials(): Promise<void> };
  readonly memoryDbPath: string;
  readonly codeIndexDbPath: string;
  /**
   * The app's declare-once storage handle. The retention-sweep roots below
   * are read straight off it rather than re-declared here, so the janitor can
   * never sweep a different scope than the one sessions and recovery
   * snapshots are actually written to.
   */
  readonly surface: SessionSurface;
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
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

  // Start-time retention janitor: pass EVERY root the composition knows so the
  // activity-log, telemetry-ledger, and recovery-snapshot stores are all swept.
  // Best-effort — a retention failure never takes startup down (the sweep
  // swallows its own errors).
  operations.runStartupAppendOnlySweep(
    {
      workingDirectory: input.surface.workingDirectory,
      surfaceRoot: input.surface.surfaceRoot,
      homeDirectory: input.surface.homeDirectory,
      logDir: input.shellPaths.resolveUserPath('logs'),
      telemetryDir: input.shellPaths.resolveUserPath('telemetry'),
    },
    (k: string) => configManager.get(k as never),
  );
  // External config edits apply LIVE through the same subscribe() pipeline an
  // in-process set() uses; the underlying watchers are unref'd.
  configManager.watchConfigFiles();

  const userPermissionRuleStore = new UserPermissionRuleStore(join(configManager.getControlPlaneConfigDir(), 'permission-rules.json'));
  void userPermissionRuleStore.init().catch((error) => logger.warn('user permission rule store init failed; asks will prompt', { error: summarizeError(error) }));

  return { storeSnapshotScheduler, userPermissionRuleStore };
}
