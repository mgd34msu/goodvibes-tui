/**
 * shell-views.ts, a minimal ShellViews for tests that wire the shell openers
 * (wireShellUiOpeners / wireViewOpeners) without a full runtime: an empty
 * config-modal registry, a real UsageTracker over silent event feeds, a static
 * (empty unless given nodes) fleet read model, and fleet acts/spawn whose
 * gateways report "not connected".
 */

import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { ModalSurfaceRegistry } from '../../views/modal-surface-registry.ts';
import { UsageTracker } from '../../runtime/usage-tracker.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../views/fleet-read-model.ts';
import { FleetActs } from '../../views/fleet-acts.ts';
import { FleetSpawn } from '../../views/fleet-spawn.ts';
import type { ShellViews } from '../../views/builtin-views.ts';
import type { FleetActionCallbacks } from '../../input/agents-modal.ts';
import { createViewPanelAdapter, type ViewPanelAdapter } from '../../views/view-panel-adapter.ts';
import type { TurnEvent, AgentEvent, UiEventFeed } from '@/runtime/index.ts';

/** An event feed that never fires. */
function silentFeed<T extends TurnEvent | AgentEvent>(): UiEventFeed<T> {
  return { on: () => () => {}, onAny: () => () => {} } as unknown as UiEventFeed<T>;
}

export interface TestShellViewsOptions {
  readonly configManager: ConfigManager;
  readonly nodes?: readonly ProcessNode[];
  readonly workingDirectory?: string;
  readonly actions?: Partial<FleetActionCallbacks>;
  readonly usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string };
  readonly localUserAuthManager?: Partial<UserAuthManager>;
}

export function makeTestShellViews(options: TestShellViewsOptions): { views: ShellViews; viewPanelAdapter: ViewPanelAdapter } {
  const readModel = createStaticFleetReadModel(buildFleetSnapshot(options.nodes ?? [], 1_700_000_000_000));
  const unavailable = { available: false as const, reason: 'no daemon in this test' };
  const acts = new FleetActs({
    resolveGateway: () => unavailable,
    diffSurface: { show: () => {}, armConfirm: () => {}, close: () => {} },
    notify: () => {},
    markDirty: () => {},
    findNode: () => null,
  });
  const spawn = new FleetSpawn({
    resolveGateway: () => unavailable,
    currentDirectory: () => options.workingDirectory ?? '/tmp',
    notify: () => {},
    markDirty: () => {},
  });
  const actions: FleetActionCallbacks = {
    interrupt: () => false,
    resume: () => false,
    kill: () => [],
    getConversationSnapshot: () => [],
    resolveSessionLogPath: (id) => `/nonexistent/${id}.jsonl`,
    steer: () => ({ queued: false, reason: 'no live registry' }),
    ...options.actions,
  };
  const usage = new UsageTracker({
    turnEvents: silentFeed<TurnEvent>(),
    agentEvents: silentFeed<AgentEvent>(),
    getUsage: () => options.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    getContextTokens: () => 0,
    getContextWindow: () => 0,
    getModelId: () => 'test-model',
    configManager: options.configManager,
  });
  const views: ShellViews = {
    modalSurfaces: new ModalSurfaceRegistry(),
    usage,
    fleet: { readModel, actions, acts, spawn },
    configManager: options.configManager,
    workingDirectory: options.workingDirectory ?? '/tmp',
    getSessionFiles: () => [],
    localUserAuthManager: (options.localUserAuthManager ?? {}) as UserAuthManager,
    bridge: { diffSurface: null, openMaskedEntry: null },
    dispose: () => usage.dispose(),
  };
  return { views, viewPanelAdapter: createViewPanelAdapter() };
}
