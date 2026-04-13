import type { RuntimeServices } from './services.ts';
import type { UiReadModel } from './ui-read-models-base.ts';
import { createStoreBackedReadModel } from './ui-read-model-helpers.ts';
import type {
  ContinuitySnapshot as IntegrationContinuitySnapshot,
  SettingsSnapshot as IntegrationSettingsSnapshot,
  WorktreeSnapshot as IntegrationWorktreeSnapshot,
} from './integration/helpers.ts';
import type { SessionReturnContextSummary } from './session-return-context.ts';
import type { ManagedWorktreeMeta } from './worktree/registry.ts';

export interface UiSettingsSnapshot {
  readonly available: boolean;
  readonly conflictCount: number;
  readonly recentFailureCount: number;
  readonly managedLockCount: number;
  readonly hasStagedManagedBundle: boolean;
}

export interface UiContinuitySnapshot {
  readonly sessionId: string;
  readonly status: string;
  readonly recoveryState: string;
  readonly lastSessionPointer: string | null;
  readonly recoveryFilePresent: boolean;
  readonly recoveryFile: Record<string, unknown> | null;
  readonly returnContext?: SessionReturnContextSummary;
}

export interface UiWorktreeSnapshot {
  readonly summary: {
    readonly total: number;
    readonly active: number;
    readonly paused: number;
    readonly cleanupPending: number;
    readonly discard: number;
  };
  readonly records: readonly ManagedWorktreeMeta[];
}

export interface UiMaintenanceObservabilityReadModels {
  readonly settings: UiReadModel<UiSettingsSnapshot>;
  readonly continuity: UiReadModel<UiContinuitySnapshot>;
  readonly worktrees: UiReadModel<UiWorktreeSnapshot>;
}

export function createMaintenanceObservabilityReadModels(runtimeServices: RuntimeServices): UiMaintenanceObservabilityReadModels {
  return {
    settings: {
      getSnapshot() {
        const snapshot = runtimeServices.integrationHelpers.getSettingsSnapshot() as IntegrationSettingsSnapshot;
        return {
          available: snapshot.available,
          conflictCount: snapshot.available ? snapshot.conflicts.length : 0,
          recentFailureCount: snapshot.available ? snapshot.recentFailures.length : 0,
          managedLockCount: snapshot.available ? snapshot.managedLockCount : 0,
          hasStagedManagedBundle: snapshot.available ? Boolean(snapshot.stagedManagedBundle) : false,
        };
      },
      subscribe() {
        return () => {};
      },
    },
    continuity: createStoreBackedReadModel(runtimeServices, () => {
      const snapshot = runtimeServices.integrationHelpers.getContinuitySnapshot() as IntegrationContinuitySnapshot;
      return snapshot;
    }),
    worktrees: {
      getSnapshot() {
        const snapshot = runtimeServices.integrationHelpers.getWorktreeSnapshot() as IntegrationWorktreeSnapshot;
        return {
          summary: snapshot.summary,
          records: snapshot.records,
        };
      },
      subscribe() {
        return () => {};
      },
    },
  };
}
