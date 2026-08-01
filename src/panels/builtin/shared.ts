import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { Orchestrator } from '@pellux/goodvibes-sdk/platform/core';
import type { MemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { ApprovalBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { SessionReadFacade } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import type { AutomationManager } from '@pellux/goodvibes-sdk/platform/automation';
import type { ControlPlaneRecentEvent } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';
import type { PluginManagerControls } from '../plugins-panel.ts';
import type { HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import type { ExecutionPlanManager } from '@pellux/goodvibes-sdk/platform/core';
import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';
import type { ProjectPlanningService } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { ApiTokenAuditor } from '@pellux/goodvibes-sdk/platform/security';
import type { ComponentHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/observability';
import type { WorktreeRegistry } from '@/runtime/index.ts';
import type { SandboxSessionRegistry } from '@/runtime/index.ts';
import type { OpsApi, PlanRuntimeService } from '@/runtime/index.ts';
import type { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers';
import type { RuntimeStore } from '../../runtime/store/index.ts';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { Panel, PanelCategory } from '../types.ts';
import { BasePanel } from '../base-panel.ts';
import { buildEmptyState, buildPanelWorkspace, DEFAULT_PANEL_PALETTE } from '../polish.ts';

export interface BuiltinPanelDeps {
  /** Config manager for settings-sync and other config-backed panels. */
  configManager?: ConfigManager;
  /** Getter returning the main orchestrator's cumulative token usage. */
  getOrchestratorUsage?: () => { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string };
  /** Optional cost budget alert threshold in USD (0 = disabled). */
  budgetThreshold?: number;
  /** Tool registry for Docs panel. */
  toolRegistry?: ToolRegistry;
  /** Provider registry for Docs panel model list. */
  providerRegistry: ProviderRegistry;
  /** Local auth manager for panels that inspect shared auth state. */
  localUserAuthManager?: UserAuthManager;
  /** Session manager for panels that inspect shared session state. */
  sessionManager?: SessionManager;
  /** Subscription manager for panels that inspect shared provider subscription state. */
  subscriptionManager?: SubscriptionManager;
  /** Shared service registry for services-backed panels. */
  serviceRegistry?: ServiceRegistry;
  /** Context window size in tokens. Unused since folded ContextVisualizerPanel into TokenBudgetPanel (which reads getCtxWindow instead); kept for source compatibility. */
  contextWindow?: number;
  /** Main Orchestrator instance for TokenBudgetPanel.wire(). */
  orchestrator?: Orchestrator;
  /** Callback returning the current model context window size (for TokenBudgetPanel). */
  getCtxWindow?: () => number;
  /** Resume a saved session directly through the session controller path. */
  resumeSession?: (sessionId: string) => void;
  /** Request a shell repaint directly rather than routing through a retired event path. */
  requestRender?: () => void;
  /** Submit a Planning panel answer through the normal TUI chat/planning coordinator path. */
  submitPlanningAnswer?: (answer: string) => void;
  /** Pause the TUI-owned planning loop and return focus to normal prompt input. */
  dismissPlanning?: () => void;
  /** ForensicsRegistry for the Forensics panel. */
  forensicsRegistry?: import('@/runtime/index.ts').ForensicsRegistry;
  /**
   * EvalRegistry for the `/eval` command surface.: 'eval' the panel was
   * deleted (DELETE-disposition), but this field is left in place — no
   * builtin panel factory reads it anymore, and it was never wired at
   * bootstrap in production either way (the eval CLI command reads its own
   * copy via CommandContext.extensions.evalRegistry).
   */
  evalRegistry?: import('../eval-registry.ts').EvalRegistry;
  /** Host-vs-client memory access for the Memory modal — the spine client, never the raw registry (routes over the wire when a daemon is adopted). */
  memoryRegistry?: MemoryAccess;
  /** Shared policy runtime state for governance/policy diagnostics. */
  policyRuntimeState?: import('@/runtime/index.ts').PolicyRuntimeState;
  /** Approval broker for control-plane/operator panels. */
  approvalBroker?: ApprovalBroker;
  /**
   * Cross-surface session READ facade for control-plane/operator panels.
   * Sync listSessions()/getSession() shape preserved; in adopted-daemon mode it
   * serves the daemon-hosted union (with an honest offline note when the wire is
   * down) instead of only this process's local broker. See session-union-cache.ts.
   */
  sessionBroker?: SessionReadFacade;
  /** Automation manager for schedule/operator panels. */
  automationManager?: AutomationManager;
  /** Recent control-plane events provider for control-plane/operator panels. */
  getControlPlaneRecentEvents?: (limit: number) => readonly ControlPlaneRecentEvent[];
  /** Token auditor for the security control-room panel. */
  tokenAuditor: ApiTokenAuditor;
  /** Shared component-health monitor for rate-limited panels and diagnostics. */
  componentHealthMonitor: ComponentHealthMonitor;
  /** Shared worktree registry for worktree surfaces. */
  worktreeRegistry: WorktreeRegistry;
  /** Shared sandbox session registry for sandbox surfaces and tools. */
  sandboxSessionRegistry: SandboxSessionRegistry;
  /**
   * Resolved daemon home directory (e.g. `~/.goodvibes/daemon`) — owned by the composition root
   * and passed explicitly so panel factories do not discover cwd/home implicitly.
   */
  daemonHomeDir?: string;
  /** Session memory store for context and token budget panels. */
  sessionMemoryStore?: SessionMemoryStore;
  /** Execution plan manager for plan dashboard panels. */
  planManager?: ExecutionPlanManager;
  /** Adaptive planner for ops strategy panels. */
  adaptivePlanner?: AdaptivePlanner;
  /** Passive SDK-backed project planning artifact service. */
  projectPlanningService?: ProjectPlanningService;
  /** Stable workspace project id for project:<projectId> planning spaces. */
  projectPlanningProjectId?: string;
  /** TUI-owned persistent work plan store. */
  workPlanStore?: import('@pellux/goodvibes-sdk/platform/workflow').WorkPlanStore;
  /** Explicit UI-facing runtime services for agent/process/WRFC/remote panels and modals. */
  uiServices?: UiRuntimeServices;
  /** Shared plugin manager for plugin and security panels (widened past the read-only observer surface — — so PluginsPanel can drive enable/disable/verify/lift-quarantine). */
  pluginManager?: PluginManagerControls;
  /** Shared hook dispatcher for the hooks control-room panel. */
  hookDispatcher?: Pick<HookDispatcher, 'listHooks' | 'getChains'>;
  /** Shared hook workbench for the hooks control-room panel. */
  hookWorkbench?: HookWorkbench;
  /** Shared hook activity tracker for the hooks control-room panel. */
  hookActivityTracker?: Pick<HookActivityTracker, 'listRecent'>;
  /** Shared MCP registry for security panels and MCP workspace commands. */
  mcpRegistry?: McpRegistry;
  /** Ops control-plane API (cancel/pause/resume/retry) for operator/ops panels to drive real actions. */
  opsApi?: OpsApi;
  /** Plan runtime service for plan/ops-strategy panels to drive adaptive-planner actions. */
  planRuntime?: PlanRuntimeService;
  /** Watcher registry for the watchers panel to drive watcher lifecycle actions. */
  watcherRegistry?: WatcherRegistry;
  /** Root runtime store for panels that need direct selector access to runtime state (see `src/runtime/store/selectors/index.ts`). */
  runtimeStore?: RuntimeStore;
  /** Knowledge API surface (graph nodes/sources/issues, search, schedules) for the Knowledge panel. */
  knowledgeApi?: KnowledgeApi;
  /** Optional session change tracker for the Git panel's session-changed file highlights. */
  sessionChangeTracker?: Pick<SessionChangeTracker, 'getChangedFiles'>;
  /**
   * Open (or focus) a panel by id, wrapping `PanelManager.open`. Use for direct
   * cross-panel navigation instead of printing a "/panel open …" signpost.
   */
  openPanel?: (panelId: string) => void;
  /**
   * Surface a Fleet act result/receipt/error to the operator (late-bound to the
   * command context's print, which the Fleet pick/conflict/discard acts use for
   * their receipts — the same conversation sink the command flow prints to).
   */
  fleetActsNotify?: (message: string) => void;
  /**
   * Hand a spawned session id to the shared one-key jump/attach affordance (the
   * CI fix-session machinery). Late-bound: main.ts patches it onto the command
   * context after bootstrap; the Fleet conflict-resolve act reuses it verbatim.
   */
  armFixSessionAttach?: (sessionId: string) => void;
}

export type ResolvedBuiltinPanelDeps = Omit<
  BuiltinPanelDeps,
  | 'configManager'
  | 'localUserAuthManager'
  | 'sessionManager'
  | 'subscriptionManager'
  | 'serviceRegistry'
  | 'sessionMemoryStore'
  | 'planManager'
  | 'adaptivePlanner'
  | 'projectPlanningService'
  | 'projectPlanningProjectId'
  | 'workPlanStore'
  | 'policyRuntimeState'
> & {
  readonly configManager: ConfigManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly sessionManager: SessionManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly planManager: ExecutionPlanManager;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  readonly workPlanStore: import('@pellux/goodvibes-sdk/platform/workflow').WorkPlanStore;
  readonly policyRuntimeState: PolicyRuntimeState;
};

function requireBuiltinPanelDep<TValue>(value: TValue | undefined, message: string): TValue {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

export function resolveBuiltinPanelDeps(deps: BuiltinPanelDeps): ResolvedBuiltinPanelDeps {
  const uiServices = requireUiServices(deps);
  return {
    ...deps,
    configManager: requireBuiltinPanelDep(
      uiServices.platform.configManager,
      'Config manager must be wired at bootstrap for builtin panels.',
    ),
    localUserAuthManager: requireBuiltinPanelDep(
      uiServices.platform.localUserAuthManager,
      'Local auth manager must be wired at bootstrap for builtin panels.',
    ),
    sessionManager: requireBuiltinPanelDep(
      uiServices.sessions.sessionManager,
      'Session manager must be wired at bootstrap for builtin panels.',
    ),
    subscriptionManager: requireBuiltinPanelDep(
      uiServices.platform.subscriptionManager,
      'Subscription manager must be wired at bootstrap for builtin panels.',
    ),
    serviceRegistry: requireBuiltinPanelDep(
      uiServices.platform.serviceRegistry,
      'Service registry must be wired at bootstrap for builtin panels.',
    ),
    sessionMemoryStore: requireBuiltinPanelDep(
      uiServices.sessions.sessionMemoryStore,
      'Session memory store must be wired at bootstrap for builtin panels.',
    ),
    planManager: requireBuiltinPanelDep(
      uiServices.planning.planManager,
      'Execution plan manager must be wired at bootstrap for builtin panels.',
    ),
    adaptivePlanner: requireBuiltinPanelDep(
      uiServices.planning.adaptivePlanner,
      'Adaptive planner must be wired at bootstrap for builtin panels.',
    ),
    projectPlanningService: requireBuiltinPanelDep(
      uiServices.planning.projectPlanningService,
      'Project planning service must be wired at bootstrap for builtin panels.',
    ),
    projectPlanningProjectId: requireBuiltinPanelDep(
      uiServices.planning.projectPlanningProjectId,
      'Project planning project id must be wired at bootstrap for builtin panels.',
    ),
    workPlanStore: requireBuiltinPanelDep(
      uiServices.planning.workPlanStore,
      'Work plan store must be wired at bootstrap for builtin panels.',
    ),
    policyRuntimeState: requireBuiltinPanelDep(
      uiServices.platform.policyRuntimeState,
      'Policy runtime state must be wired at bootstrap for builtin panels.',
    ),
  };
}

export function requireUiServices(deps: BuiltinPanelDeps): UiRuntimeServices {
  if (!deps.uiServices) {
    throw new Error('UI runtime services must be wired at bootstrap for agent, process, WRFC, and remote panels.');
  }
  return deps.uiServices;
}

export function requirePluginManager(deps: BuiltinPanelDeps): PluginManagerControls {
  if (!deps.pluginManager) {
    throw new Error('Plugin manager must be wired at bootstrap for plugin and security panels.');
  }
  return deps.pluginManager;
}

export function requireHookPanelDeps(deps: BuiltinPanelDeps): {
  readonly hookDispatcher: Pick<HookDispatcher, 'listHooks' | 'getChains'>;
  readonly hookWorkbench: HookWorkbench;
  readonly hookActivityTracker: Pick<HookActivityTracker, 'listRecent'>;
} {
  if (!deps.hookDispatcher || !deps.hookWorkbench || !deps.hookActivityTracker) {
    throw new Error('Hook dispatcher, hook activity tracker, and hook workbench must be wired at bootstrap for the hooks panel.');
  }
  return {
    hookDispatcher: deps.hookDispatcher,
    hookWorkbench: deps.hookWorkbench,
    hookActivityTracker: deps.hookActivityTracker,
  };
}

export function requireMcpRegistry(deps: BuiltinPanelDeps): McpRegistry {
  if (!deps.mcpRegistry) {
    throw new Error('MCP registry must be wired at bootstrap for security panels and MCP workspace commands.');
  }
  return deps.mcpRegistry;
}

export function requireKnowledgeApi(deps: BuiltinPanelDeps): KnowledgeApi {
  if (!deps.knowledgeApi) {
    throw new Error('Knowledge API must be wired at bootstrap for the Knowledge panel.');
  }
  return deps.knowledgeApi;
}

// ---------------------------------------------------------------------------
// always-register conditional panels with a "dependency not
// configured" empty state instead of skipping registration entirely.
// ---------------------------------------------------------------------------

/**
 * Minimal placeholder Panel used when a builtin panel's runtime dependency
 * (e.g. an orchestrator usage getter, a memory registry, an eval registry)
 * was not wired at bootstrap for this build/session. Renders a single
 * "dependency not configured" empty state via `buildEmptyState` so opening
 * the panel id (`/panel open <id>`, a saved layout, a cross-panel jump)
 * always resolves to a real panel instead of "Unknown panel" — the panel
 * type is always registered; only its data source is sometimes absent.
 */
class UnconfiguredDependencyPanel extends BasePanel {
  constructor(
    id: string,
    name: string,
    icon: string,
    category: PanelCategory,
    private readonly emptyTitle: string,
    private readonly emptyBody: string,
  ) {
    super(id, name, icon, category);
  }

  render(width: number, height: number): Line[] {
    if (width <= 0 || height <= 0) return [];
    return buildPanelWorkspace(width, height, {
      title: `${this.name} Workspace`,
      sections: [{
        lines: buildEmptyState(width, this.emptyTitle, this.emptyBody, [], DEFAULT_PANEL_PALETTE),
      }],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }
}

/**
 * Build a factory that instantiates `configured()` when `dependencyPresent`
 * is true, otherwise a placeholder Panel rendering `emptyTitle`/`emptyBody`
 * via `buildEmptyState`. Use for builtin panels whose registration used to
 * be gated behind an `if (deps.xyz)` check (cost/memory/incident/eval).
 */
export function withUnconfiguredFallback(
  dependencyPresent: boolean,
  id: string,
  name: string,
  icon: string,
  category: PanelCategory,
  emptyTitle: string,
  emptyBody: string,
  configured: () => Panel,
): () => Panel {
  if (dependencyPresent) return configured;
  return () => new UnconfiguredDependencyPanel(id, name, icon, category, emptyTitle, emptyBody);
}
