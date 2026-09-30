/**
 * view-deps.ts, what the built-in modals and views are built from.
 *
 * Composed once at startup (runtime/bootstrap-shell.ts) and handed to
 * createShellViews (builtin-views.ts), which builds the always-on read models
 * (usage, fleet acts and spawn) and registers every config-modal surface.
 */

import type { ConfigManager, ServiceRegistry, SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { Orchestrator, SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import type { MemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { HookActivityTracker, HookDispatcher, HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { ProjectPlanningService, KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions';
import type { WorkPlanStore } from '@pellux/goodvibes-sdk/platform/workflow';
import type { PolicyRuntimeState, SandboxSessionRegistry } from '@/runtime/index.ts';
import type { UiRuntimeServices } from '../runtime/ui-services.ts';
import type { PluginsModalManager } from './modals/plugins-modal.ts';

export interface BuiltinViewDeps {
  readonly providerRegistry: ProviderRegistry;
  readonly uiServices: UiRuntimeServices;
  readonly toolRegistry?: ToolRegistry;
  /** The main orchestrator (session usage and context size). */
  readonly orchestrator?: Orchestrator;
  /** The current model's context window in tokens. */
  readonly getCtxWindow?: () => number;
  readonly requestRender?: () => void;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  /** Memory access for the Memory modal (the spine client, which routes to an adopted daemon). */
  readonly memoryRegistry?: MemoryAccess;
  readonly pluginManager?: PluginsModalManager;
  readonly hookDispatcher?: Pick<HookDispatcher, 'listHooks' | 'getChains'>;
  readonly hookWorkbench?: HookWorkbench;
  readonly hookActivityTracker?: Pick<HookActivityTracker, 'listRecent'>;
  readonly knowledgeApi?: KnowledgeApi;
  /** The files this session edited (the Changes modal's default view). */
  readonly sessionChangeTracker?: Pick<SessionChangeTracker, 'getChangedFiles'>;
  /** Report a fleet act's result (late-bound to the command context's print). */
  readonly fleetActsNotify?: (message: string) => void;
  /** Hand a spawned session id to the one-key jump affordance (late-bound). */
  readonly armFixSessionAttach?: (sessionId: string) => void;
}

/** The deps with everything the modals require resolved from the UI services. */
export type ResolvedBuiltinViewDeps = BuiltinViewDeps & {
  readonly configManager: ConfigManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  readonly workPlanStore: WorkPlanStore;
  readonly policyRuntimeState: PolicyRuntimeState;
};

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} must be wired at bootstrap for the built-in modals.`);
  return value;
}

export function resolveBuiltinViewDeps(deps: BuiltinViewDeps): ResolvedBuiltinViewDeps {
  const ui = deps.uiServices;
  return {
    ...deps,
    configManager: required(ui.platform.configManager, 'Config manager'),
    localUserAuthManager: required(ui.platform.localUserAuthManager, 'Local auth manager'),
    subscriptionManager: required(ui.platform.subscriptionManager, 'Subscription manager'),
    serviceRegistry: required(ui.platform.serviceRegistry, 'Service registry'),
    sessionMemoryStore: required(ui.sessions.sessionMemoryStore, 'Session memory store'),
    projectPlanningService: required(ui.planning.projectPlanningService, 'Project planning service'),
    projectPlanningProjectId: required(ui.planning.projectPlanningProjectId, 'Project planning project id'),
    workPlanStore: required(ui.planning.workPlanStore, 'Work plan store'),
    policyRuntimeState: required(ui.platform.policyRuntimeState, 'Policy runtime state'),
  };
}
