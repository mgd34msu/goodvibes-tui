import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
import type { ForensicsRegistry } from '@pellux/goodvibes-sdk/platform/runtime/forensics/index';
import type { IntegrationHelperService } from '@pellux/goodvibes-sdk/platform/runtime/integration/helpers';
import type { HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks/workbench';
import type { KnowledgeService } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import type { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins/manager';
import type { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';
import type { PanelHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/panel-health-monitor';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import type { WorktreeRegistry } from '@pellux/goodvibes-sdk/platform/runtime/worktree/registry';
import type { SandboxSessionRegistry } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/session-registry';
import { createShellExtensionServices, type CommandExtensionShellServices } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-extensions';
import { createShellOpsServices, createShellPlanRuntime, createShellRemoteCommandService, type CommandOpsShellServices, type PlanRuntimeService, type RemoteCommandService } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-ops';
import { createShellPlatformServices, type CommandPlatformShellServices } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-platform';
import { createShellWorkspaceServices, type CommandWorkspaceShellServices } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-workspace';

export type { CommandWorkspaceShellServices } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-workspace';
export type { CommandPlatformShellServices } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-platform';
export type {
  ShellAgentManagerService,
  ShellAcpManagerService,
  ShellAutomationManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
} from '@pellux/goodvibes-sdk/platform/runtime/shell-command-ops';
export type { CommandOpsShellServices, PlanRuntimeService, RemoteCommandService } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-ops';
export type { CommandExtensionShellServices } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-extensions';

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

export { createShellRemoteCommandService, createShellPlanRuntime } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-ops';
