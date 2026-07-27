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
 *  - Durability housekeeping: the crash-residue reclaim the retention janitor
 *    above does NOT cover — stale liveness markers, orphaned transcript
 *    journals, `.unrecognized` quarantine files, and anchor sidecars whose
 *    session is gone (see durability-housekeeping.ts). It runs at startup AND
 *    on a repeating unref'd timer, because a long-lived process that only
 *    sweeps at boot never sweeps; the returned disposer stops that timer.
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
import { startDurabilityHousekeeping } from './durability-housekeeping.ts';
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
  /**
   * The session id this process is currently using, read at each sweep. When
   * omitted the crash-residue reap still protects live artefacts through its
   * age and liveness rules — this is the explicit belt-and-braces guard.
   */
  /**
   * Resolves the live session id, read fresh on every crash-residue sweep so
   * the running session's own transcript journal and liveness marker are
   * exempt from reaping.
   *
   * A getter, not a value: the id is reassigned in place when a recovery
   * snapshot is accepted, and this sweep repeats for the life of the process.
   *
   * Omitting it is not merely untidy. The journal reaper's other guard is the
   * liveness marker, and that marker goes stale after 150 seconds — so a host
   * that passes nothing here is trusting a heartbeat that a single long
   * blocking turn can outrun, and an in-process sweep landing in that window
   * would delete the journal of the session currently writing it. Passing this
   * makes the exemption unconditional instead of timing-dependent.
   */
  readonly currentSessionId?: () => string | null;
}

export interface DurabilityServices {
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  /**
   * Re-sweeps every registered append-only store on a cadence. The start-time
   * sweep alone never prunes again in a process that stays up, which is the
   * window in which those stores grow. Unref'd timers; teardown stop()s it.
   */
  readonly appendOnlyRetentionScheduler: InstanceType<typeof operations.AppendOnlyRetentionScheduler>;
  readonly userPermissionRuleStore: UserPermissionRuleStore;
  /**
   * Stops the repeating crash-residue sweep. The timer is unref'd, so a host
   * that never calls this is not held open by it; teardown calls it to stop
   * the work rather than to release the loop.
   */
  readonly stopDurabilityHousekeeping: () => void;
  /** Stops the live config-file watch this factory started. */
  readonly stopConfigWatch: () => void;
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
  const appendOnlyRetentionRoots = {
    workingDirectory: input.surface.workingDirectory,
    surfaceRoot: input.surface.surfaceRoot,
    homeDirectory: input.surface.homeDirectory,
    logDir: input.shellPaths.resolveUserPath('logs'),
    telemetryDir: input.shellPaths.resolveUserPath('telemetry'),
  };
  const appendOnlyRetentionConfigGet = (k: string): unknown => configManager.get(k as never);
  operations.runStartupAppendOnlySweep(appendOnlyRetentionRoots, appendOnlyRetentionConfigGet);
  // ...and again on a cadence for as long as this process lives. A start-time
  // sweep alone never prunes a long-lived session again after boot, which is
  // exactly the window in which these stores grow. Unref'd timers; the disposer
  // below stops it, same posture as storeSnapshotScheduler.
  const appendOnlyRetentionScheduler = new operations.AppendOnlyRetentionScheduler({
    roots: appendOnlyRetentionRoots,
    configGet: appendOnlyRetentionConfigGet,
  });
  appendOnlyRetentionScheduler.start();
  // Crash-residue reclaim the sweep above does not cover (liveness markers,
  // orphaned transcript journals, .unrecognized quarantine files, anchor
  // sidecars whose session file is gone). Runs once now and every few hours
  // after that; the timer is unref'd and the disposer stops it.
  const stopDurabilityHousekeeping = startDurabilityHousekeeping({
    surface: input.surface,
    currentSessionId: input.currentSessionId,
    extraQuarantineDirs: [configManager.getControlPlaneConfigDir()],
  });
  // External config edits apply LIVE through the same subscribe() pipeline an
  // in-process set() uses; the underlying watchers are unref'd. The returned
  // handle is the only way to stop them — dropping it left a 250ms poll running
  // for the life of the process after the graph that started it was gone.
  const stopConfigWatch = configManager.watchConfigFiles();

  const userPermissionRuleStore = new UserPermissionRuleStore(join(configManager.getControlPlaneConfigDir(), 'permission-rules.json'));
  void userPermissionRuleStore.init().catch((error) => logger.warn('user permission rule store init failed; asks will prompt', { error: summarizeError(error) }));

  return { storeSnapshotScheduler, appendOnlyRetentionScheduler, userPermissionRuleStore, stopDurabilityHousekeeping, stopConfigWatch };
}
