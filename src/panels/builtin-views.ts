/**
 * builtin-views.ts, the always-on pieces behind the built-in modals.
 *
 * Built once at startup (runtime/bootstrap-shell.ts):
 *   - the UsageTracker, collecting per-turn history and costs from the first
 *     turn whether or not the Usage modal is ever opened;
 *   - the fleet's action callbacks, acts (pick / conflict / discard) and the
 *     ACP spawn controller the Agents modal drives;
 *   - every config-modal surface, registered on the ModalSurfaceRegistry with
 *     the old names that open it.
 *
 * Two things only exist once the input handler does (the kit modal host): the
 * Changes preview the fleet acts show candidate diffs in, and the local-auth
 * password prompt. They are late-bound through `bridge`, which the shell fills
 * in (shell/ui-openers.ts) before any of them can be used.
 */

import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { UsageTracker } from '../runtime/usage-tracker.ts';
import type { FleetActionCallbacks } from '../input/agents-modal.ts';
import { ModalSurfaceRegistry } from './modal-surface-registry.ts';
import { registerBuiltinModals } from './builtin-modals.ts';
import { resolveBuiltinViewDeps, type BuiltinViewDeps } from './view-deps.ts';
import type { FleetReadModel } from './fleet-read-model.ts';
import { FleetActs, type FleetDiffSurface } from './fleet-acts.ts';
import { createFleetGateway } from './fleet-gateway.ts';
import { FleetSpawn, createAcpSpawnGateway } from './fleet-spawn.ts';

export type MaskedEntryOpener = (kind: 'add-user' | 'rotate-password', username?: string) => void;

export interface ShellViewBridge {
  /** Show candidate diffs and ask over them (the Changes preview). */
  diffSurface: FleetDiffSurface | null;
  /** Open the local-auth password prompt. */
  openMaskedEntry: MaskedEntryOpener | null;
}

export interface ShellViews {
  readonly modalSurfaces: ModalSurfaceRegistry;
  readonly usage: UsageTracker;
  readonly fleet: {
    readonly readModel: FleetReadModel;
    readonly actions: FleetActionCallbacks;
    readonly acts: FleetActs;
    readonly spawn: FleetSpawn;
  };
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  /** Files this session edited. */
  readonly getSessionFiles: () => string[];
  readonly localUserAuthManager: UserAuthManager;
  readonly bridge: ShellViewBridge;
  dispose(): void;
}

export function createShellViews(deps: BuiltinViewDeps): ShellViews {
  const resolved = resolveBuiltinViewDeps(deps);
  const ui = deps.uiServices;
  const requestRender = deps.requestRender ?? (() => {});
  const bridge: ShellViewBridge = { diffSurface: null, openMaskedEntry: null };
  const fleetReadModel = ui.runtime.fleetReadModel;
  const notify = deps.fleetActsNotify ?? (() => {});

  const usage = new UsageTracker({
    turnEvents: ui.events.turns,
    agentEvents: ui.events.agents,
    getUsage: () => (deps.orchestrator?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string },
    getContextTokens: () => deps.orchestrator?.lastInputTokens ?? 0,
    getContextWindow: () => deps.getCtxWindow?.() ?? 0,
    getModelId: () => deps.providerRegistry.getCurrentModel().id,
    getAgentStatus: (id) => ui.agents.agentManager.getStatus(id),
    getFleetCost: () => fleetReadModel.getSnapshot().totalCost,
    configManager: resolved.configManager,
    sessionMemoryStore: resolved.sessionMemoryStore,
    sessionReadModel: ui.readModels.session,
    requestRender,
  });

  const diffSurface: FleetDiffSurface = {
    show: (title, diff) => bridge.diffSurface?.show(title, diff),
    armConfirm: (opts) => {
      if (bridge.diffSurface) bridge.diffSurface.armConfirm(opts);
      else opts.onCancel?.();
    },
    close: () => bridge.diffSurface?.close(),
  };

  const acts = new FleetActs({
    resolveGateway: () => createFleetGateway({
      configManager: resolved.configManager,
      homeDirectory: ui.environment.shellPaths.homeDirectory,
      armFixSessionAttach: deps.armFixSessionAttach ?? (() => {}),
    }),
    diffSurface,
    notify,
    markDirty: requestRender,
    findNode: (nodeId: string) => fleetReadModel.getSnapshot().rows.find((r) => r.node.id === nodeId)?.node ?? null,
  });

  const spawn = new FleetSpawn({
    resolveGateway: () => createAcpSpawnGateway({
      configManager: resolved.configManager,
      homeDirectory: ui.environment.shellPaths.homeDirectory,
    }),
    currentDirectory: () => ui.environment.shellPaths.workingDirectory,
    notify,
    markDirty: requestRender,
  });

  const actions: FleetActionCallbacks = {
    interrupt: (id) => fleetReadModel.interrupt(id),
    resume: (id) => fleetReadModel.resume(id),
    kill: (id, opts) => fleetReadModel.kill(id, opts),
    getConversationSnapshot: (agentId) => ui.agents.agentManager.getConversationSnapshot(agentId),
    resolveSessionLogPath: (agentId) => ui.environment.shellPaths.resolveProjectPath(GOODVIBES_TUI_SURFACE_ROOT, 'sessions', `${agentId}.jsonl`),
    steer: (id, text) => fleetReadModel.steer(id, text),
  };

  const modalSurfaces = new ModalSurfaceRegistry();
  registerBuiltinModals(modalSurfaces, resolved, (kind, username) => bridge.openMaskedEntry?.(kind, username));

  return {
    modalSurfaces,
    usage,
    fleet: { readModel: fleetReadModel, actions, acts, spawn },
    configManager: resolved.configManager,
    workingDirectory: ui.environment.workingDirectory,
    getSessionFiles: () => deps.sessionChangeTracker?.getChangedFiles() ?? [],
    localUserAuthManager: resolved.localUserAuthManager,
    bridge,
    dispose: () => usage.dispose(),
  };
}
