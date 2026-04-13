import type { ConfigManager } from '../../config/manager.ts';
import type { ServiceRegistry } from '../../config/service-registry.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { ProviderRegistry } from '../../providers/registry.ts';
import type { Orchestrator } from '../../core/orchestrator.ts';
import type { MemoryRegistry } from '../../state/memory-store.ts';
import type { ApprovalBroker, SharedSessionBroker } from '../../control-plane/index.ts';
import type { AutomationManager } from '../../automation/index.ts';
import type { ControlPlaneRecentEvent } from '../../control-plane/gateway.ts';
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';
import type { PluginManagerObserver } from '../../plugins/manager.ts';
import type { HookWorkbench } from '../../hooks/workbench.ts';
import type { HookDispatcher } from '../../hooks/dispatcher.ts';
import type { HookActivityTracker } from '../../hooks/activity.ts';
import type { McpRegistry } from '../../mcp/registry.ts';
import type { PolicyRuntimeState } from '../../runtime/permissions/policy-runtime.ts';
import type { SessionManager } from '../../sessions/manager.ts';
import type { SubscriptionManager } from '../../config/subscriptions.ts';
import type { UserAuthManager } from '../../security/user-auth.ts';
import type { SessionMemoryStore } from '../../core/session-memory.ts';
import type { ExecutionPlanManager } from '../../core/execution-plan.ts';
import type { AdaptivePlanner } from '../../core/adaptive-planner.ts';
import type { ApiTokenAuditor } from '../../security/token-audit.ts';
import type { PanelHealthMonitor } from '../../runtime/perf/panel-health-monitor.ts';
import type { WorktreeRegistry } from '../../runtime/worktree/registry.ts';
import type { SandboxSessionRegistry } from '../../runtime/sandbox/session-registry.ts';

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
  /** Context window size in tokens (for ContextVisualizerPanel). */
  contextWindow?: number;
  /** Main Orchestrator instance for TokenBudgetPanel.wire(). */
  orchestrator?: Orchestrator;
  /** Callback returning the current model context window size (for TokenBudgetPanel). */
  getCtxWindow?: () => number;
  /** Resume a saved session directly through the session controller path. */
  resumeSession?: (sessionId: string) => void;
  /** Request a shell repaint directly rather than routing through a retired event path. */
  requestRender?: () => void;
  /** ForensicsRegistry for the Forensics panel. */
  forensicsRegistry?: import('../../runtime/forensics/registry.ts').ForensicsRegistry;
  /** EvalRegistry for the Eval panel. */
  evalRegistry?: import('../eval-panel.ts').EvalRegistry;
  /** MemoryRegistry for the Memory panel. */
  memoryRegistry?: MemoryRegistry;
  /** Shared policy runtime state for governance/policy diagnostics. */
  policyRuntimeState?: import('../../runtime/permissions/policy-runtime.ts').PolicyRuntimeState;
  /** Approval broker for control-plane/operator panels. */
  approvalBroker?: ApprovalBroker;
  /** Shared session broker for control-plane/operator panels. */
  sessionBroker?: SharedSessionBroker;
  /** Automation manager for schedule/operator panels. */
  automationManager?: AutomationManager;
  /** Recent control-plane events provider for control-plane/operator panels. */
  getControlPlaneRecentEvents?: (limit: number) => readonly ControlPlaneRecentEvent[];
  /** Token auditor for the security control-room panel. */
  tokenAuditor: ApiTokenAuditor;
  /** Shared panel-health monitor for rate-limited panels and diagnostics. */
  panelHealthMonitor: PanelHealthMonitor;
  /** Shared worktree registry for worktree surfaces. */
  worktreeRegistry: WorktreeRegistry;
  /** Shared sandbox session registry for sandbox surfaces and tools. */
  sandboxSessionRegistry: SandboxSessionRegistry;
  /** Session memory store for context and token budget panels. */
  sessionMemoryStore?: SessionMemoryStore;
  /** Execution plan manager for plan dashboard panels. */
  planManager?: ExecutionPlanManager;
  /** Adaptive planner for ops strategy panels. */
  adaptivePlanner?: AdaptivePlanner;
  /** Shared system-messages panel instance attached from boot so low-priority chatter stays out of conversation. */
  systemMessagesPanel?: import('../system-messages-panel.ts').SystemMessagesPanel;
  /** Explicit UI-facing runtime services for agent/process/WRFC/remote panels and modals. */
  uiServices?: UiRuntimeServices;
  /** Shared plugin manager observer for plugin and security panels. */
  pluginManager?: PluginManagerObserver;
  /** Shared hook dispatcher for the hooks control-room panel. */
  hookDispatcher?: Pick<HookDispatcher, 'listHooks' | 'getChains'>;
  /** Shared hook workbench for the hooks control-room panel. */
  hookWorkbench?: HookWorkbench;
  /** Shared hook activity tracker for the hooks control-room panel. */
  hookActivityTracker?: Pick<HookActivityTracker, 'listRecent'>;
  /** Shared MCP registry for MCP/security control-room panels. */
  mcpRegistry?: McpRegistry;
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
  | 'policyRuntimeState'
  | 'systemMessagesPanel'
> & {
  readonly configManager: ConfigManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly sessionManager: SessionManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly planManager: ExecutionPlanManager;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly systemMessagesPanel: import('../system-messages-panel.ts').SystemMessagesPanel;
};

export interface ControlPlanePanelFactoryDeps {
  readonly approvalBroker: ApprovalBroker;
  readonly sessionBroker: SharedSessionBroker;
  readonly getControlPlaneRecentEvents: (limit: number) => readonly ControlPlaneRecentEvent[];
}

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
    policyRuntimeState: requireBuiltinPanelDep(
      uiServices.platform.policyRuntimeState,
      'Policy runtime state must be wired at bootstrap for builtin panels.',
    ),
    systemMessagesPanel: requireBuiltinPanelDep(
      deps.systemMessagesPanel,
      'System messages panel must be wired at bootstrap for builtin panels.',
    ),
  };
}

export function requireControlPlanePanelDeps(deps: BuiltinPanelDeps): ControlPlanePanelFactoryDeps {
  if (!deps.approvalBroker || !deps.sessionBroker || !deps.getControlPlaneRecentEvents) {
    throw new Error('ControlPlanePanel requires approval/session brokers and recent-event access to be wired at bootstrap.');
  }
  return {
    approvalBroker: deps.approvalBroker,
    sessionBroker: deps.sessionBroker,
    getControlPlaneRecentEvents: deps.getControlPlaneRecentEvents,
  };
}

export function requireAutomationManager(deps: BuiltinPanelDeps): AutomationManager {
  if (!deps.automationManager) {
    throw new Error('SchedulePanel requires an automation manager to be wired at bootstrap.');
  }
  return deps.automationManager;
}

export function requireUiServices(deps: BuiltinPanelDeps): UiRuntimeServices {
  if (!deps.uiServices) {
    throw new Error('UI runtime services must be wired at bootstrap for agent, process, WRFC, and remote panels.');
  }
  return deps.uiServices;
}

export function requirePluginManager(deps: BuiltinPanelDeps): PluginManagerObserver {
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
    throw new Error('MCP registry must be wired at bootstrap for MCP and security panels.');
  }
  return deps.mcpRegistry;
}
