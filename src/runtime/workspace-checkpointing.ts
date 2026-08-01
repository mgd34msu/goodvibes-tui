import { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import { withCheckpointGuardSettings } from '../config/tui-extension-settings.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { RuntimeEventBus, SessionSurface } from '@/runtime/index.ts';

/**
 * createWorkspaceCheckpointing — build the per-workspace checkpoint manager and
 * kick off its initialization. Extracted from services.ts so the (load-bearing)
 * failure-mode notes below live with the code they describe.
 */
export function createWorkspaceCheckpointing(opts: {
  workspaceRoot: string;
  /**
   * The app's declare-once storage handle. Passing it resolves the checkpoint
   * git store to `surface.checkpointsDir` (`<workingDirectory>/.goodvibes/tui/
   * checkpoints`) instead of the unscoped `<workspaceRoot>/.goodvibes/
   * checkpoints` every product using this SDK would otherwise share. The SDK
   * migrates an existing legacy store into the scoped location on first use.
   */
  surface: SessionSurface;
  runtimeBus: RuntimeEventBus;
  configManager: ConfigManager;
}): WorkspaceCheckpointManager {
  // Checkpoint root-guard from the user's `checkpoints.*` config (docs/configuration.md;
  // inert until the platform SDK's checkpoint manager exposes the keys — see the reader's note).
  const manager = new WorkspaceCheckpointManager(
    withCheckpointGuardSettings({ workspaceRoot: opts.workspaceRoot, surface: opts.surface, runtimeBus: opts.runtimeBus }, opts.configManager),
  );
  // Fire-and-forget: subscriptions go live immediately if init() succeeds.
  // If it rejects, WorkspaceCheckpointManager caches that rejection on
  // `initPromise` and never clears it, so every later call (create/list/
  // diff/restore — each awaits init() first) re-throws the same error
  // forever: checkpointing becomes entirely unavailable for the rest of the
  // session, not "degraded to manual-only". The `.catch(() => {})` here only
  // exists to prevent an unhandled rejection at startup; the checkpoint
  // commands (checkpoint-runtime.ts) are what actually catch and report the
  // failure to the user, on first use.
  void manager.init().catch(() => {});
  return manager;
}
