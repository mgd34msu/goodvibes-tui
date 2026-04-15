import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
import type { ForensicsRegistry } from './forensics/index.ts';
import type { IntegrationHelperService } from './integration/helpers.ts';
import type { HookWorkbench } from '../hooks/workbench.ts';
import type { KnowledgeService } from '../knowledge/index.ts';
import type { PluginManager } from '../plugins/manager.ts';
import type { PolicyRuntimeState } from './permissions/policy-runtime.ts';
import type { PanelHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/panel-health-monitor';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import type { WorktreeRegistry } from './worktree/registry.ts';
import type { SandboxSessionRegistry } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/session-registry';
import { createShellExtensionServices, type CommandExtensionShellServices } from './shell-command-extensions.ts';
import { createShellOpsServices, createShellPlanRuntime, createShellRemoteCommandService, type CommandOpsShellServices, type PlanRuntimeService, type RemoteCommandService } from './shell-command-ops.ts';
import { createShellPlatformServices, type CommandPlatformShellServices } from './shell-command-platform.ts';
import { createShellWorkspaceServices, type CommandWorkspaceShellServices } from './shell-command-workspace.ts';

export type { CommandWorkspaceShellServices } from './shell-command-workspace.ts';
export type { CommandPlatformShellServices } from './shell-command-platform.ts';
export type {
  ShellAgentManagerService,
  ShellAcpManagerService,
  ShellAutomationManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
} from './shell-command-ops.ts';
export type { CommandOpsShellServices, PlanRuntimeService, RemoteCommandService } from './shell-command-ops.ts';
export type { CommandExtensionShellServices } from './shell-command-extensions.ts';

export interface BootstrapCommandShellServices {
  readonly workspace: CommandWorkspaceShellServices;
  readonly platform: CommandPlatformShellServices;
  readonly ops: CommandOpsShellServices;
  readonly extensions: CommandExtensionShellServices;
}

export interface CreateBootstrapCommandShellServicesOptions {
  readonly agentManager?: import('./shell-command-ops.ts').ShellAgentManagerService;
  readonly acpManager?: import('./shell-command-ops.ts').ShellAcpManagerService;
  readonly automationManager?: import('./shell-command-ops.ts').ShellAutomationManagerRuntimeService;
  readonly modeManager?: import('./shell-command-ops.ts').ShellModeManagerService;
  readonly planManager?: import('./shell-command-ops.ts').ShellPlanManagerService;
  readonly adaptivePlanner?: AdaptivePlanner;
  readonly sessionOrchestration?: import('./shell-command-ops.ts').ShellSessionOrchestrationService;
  readonly shellPaths: ShellPathService;
  readonly panelHealthMonitor: PanelHealthMonitor;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly readModels: import('./ui-read-models.ts').UiReadModels;
  readonly serviceRegistry?: import('../config/service-registry.ts').ServiceRegistry;
  readonly subscriptionManager?: import('@pellux/goodvibes-sdk/platform/config/subscriptions').SubscriptionManager;
  readonly secretsManager?: import('../config/secrets.ts').SecretsManager;
  readonly localUserAuthManager?: import('@pellux/goodvibes-sdk/platform/security/user-auth').UserAuthManager;
  readonly tokenAuditor?: import('@pellux/goodvibes-sdk/platform/security/token-audit').ApiTokenAuditor;
  readonly replayEngine?: import('@pellux/goodvibes-sdk/platform/core/deterministic-replay').DeterministicReplayEngine;
  readonly webhookNotifier?: import('../integrations/webhooks.ts').WebhookNotifier;
  readonly remoteRuntime?: RemoteCommandService;
  readonly planRuntime?: PlanRuntimeService;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly memoryRegistry?: import('../state/memory-store.ts').MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
}

export function createBootstrapCommandShellServices(
  options: CreateBootstrapCommandShellServicesOptions,
): BootstrapCommandShellServices {
  const {
    agentManager,
    acpManager,
    automationManager,
    modeManager,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    shellPaths,
    panelHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
    readModels,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
    remoteRuntime,
    planRuntime,
    forensicsRegistry,
    policyRuntimeState,
    memoryRegistry,
    integrationHelpers,
    knowledgeService,
    pluginManager,
    hookWorkbench,
  } = options;

  return {
    workspace: createShellWorkspaceServices({
      shellPaths,
      panelHealthMonitor,
      worktreeRegistry,
      sandboxSessionRegistry,
    }),
    platform: createShellPlatformServices({
      readModels,
      serviceRegistry,
      subscriptionManager,
      secretsManager,
      localUserAuthManager,
      tokenAuditor,
      replayEngine,
      webhookNotifier,
    }),
    ops: createShellOpsServices({
      agentManager,
      acpManager,
      automationManager,
      modeManager,
      planManager,
      adaptivePlanner,
      sessionOrchestration,
      remoteRuntime,
      planRuntime,
    }),
    extensions: createShellExtensionServices({
      forensicsRegistry,
      policyRuntimeState,
      memoryRegistry,
      integrationHelpers,
      knowledgeService,
      pluginManager,
      hookWorkbench,
    }),
  };
}

export { createShellRemoteCommandService, createShellPlanRuntime } from './shell-command-ops.ts';
