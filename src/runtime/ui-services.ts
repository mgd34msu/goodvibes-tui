import type { RuntimeServices } from './services.ts';
import type { RemoteRunnerRegistry } from '@/runtime/index.ts';
import type { RemoteSupervisor } from '@/runtime/index.ts';
import { createUiRuntimeEvents, type UiRuntimeEvents } from './ui-events.ts';
import { createUiReadModels, type UiReadModels, type UiReadModelOptions } from './ui-read-models.ts';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { ControlPlaneRecentEvent } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { ApprovalBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { ShellPathService } from '@/runtime/index.ts';
import type { HostServiceStatus } from '@/runtime/index.ts';
import type { SecretsManager } from '../config/secrets.ts';

export interface UiEnvironmentServices {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly shellPaths: ShellPathService;
}

export interface UiShellServices {
  readonly keybindingsManager: RuntimeServices['keybindingsManager'];
  readonly panelManager: RuntimeServices['panelManager'];
  readonly processManager: RuntimeServices['processManager'];
  readonly profileManager: RuntimeServices['profileManager'];
  readonly bookmarkManager: RuntimeServices['bookmarkManager'];
}

export interface UiAgentServices {
  readonly agentManager: RuntimeServices['agentManager'];
  readonly agentMessageBus: RuntimeServices['agentMessageBus'];
  readonly wrfcController: RuntimeServices['wrfcController'];
}

export interface UiProviderServices {
  readonly providerRegistry: RuntimeServices['providerRegistry'];
  readonly favoritesStore: RuntimeServices['favoritesStore'];
  readonly benchmarkStore: RuntimeServices['benchmarkStore'];
}

export interface UiSessionServices {
  readonly sessionManager: RuntimeServices['sessionManager'];
  readonly sessionBroker: SharedSessionBroker;
  readonly sessionOrchestration: RuntimeServices['sessionOrchestration'];
  readonly sessionMemoryStore: RuntimeServices['sessionMemoryStore'];
}

export interface UiPlatformServices {
  readonly configManager: RuntimeServices['configManager'];
  readonly localUserAuthManager: RuntimeServices['localUserAuthManager'];
  readonly mcpRegistry: RuntimeServices['mcpRegistry'];
  readonly serviceRegistry: RuntimeServices['serviceRegistry'];
  readonly surfaceRegistry: RuntimeServices['surfaceRegistry'];
  readonly subscriptionManager: RuntimeServices['subscriptionManager'];
  readonly secretsManager: SecretsManager;
  readonly tokenAuditor: RuntimeServices['tokenAuditor'];
  readonly replayEngine: RuntimeServices['replayEngine'];
  readonly webhookNotifier: RuntimeServices['webhookNotifier'];
  readonly focusTracker: RuntimeServices['focusTracker'];
  readonly policyRuntimeState: RuntimeServices['policyRuntimeState'];
  readonly externalServices?: {
    inspect(): {
      readonly daemonRunning: boolean;
      readonly daemonPortInUse?: boolean;
      readonly httpListenerRunning: boolean;
      readonly httpListenerPortInUse?: boolean;
      readonly daemonStatus?: HostServiceStatus;
      readonly httpListenerStatus?: HostServiceStatus;
    };
    restart(): Promise<{
      readonly daemonRunning: boolean;
      readonly daemonPortInUse?: boolean;
      readonly httpListenerRunning: boolean;
      readonly httpListenerPortInUse?: boolean;
      readonly daemonStatus?: HostServiceStatus;
      readonly httpListenerStatus?: HostServiceStatus;
    }>;
  };
}

export interface UiPlanningServices {
  readonly planManager: RuntimeServices['planManager'];
  readonly adaptivePlanner: RuntimeServices['adaptivePlanner'];
  readonly projectPlanningService: RuntimeServices['projectPlanningService'];
  readonly projectPlanningProjectId: RuntimeServices['projectPlanningProjectId'];
  readonly workPlanStore: RuntimeServices['workPlanStore'];
}

export interface UiCoordinationServices {
  readonly approvalBroker: ApprovalBroker;
}

export interface UiRuntimeSharedServices {
  readonly environment: UiEnvironmentServices;
  readonly shell: UiShellServices;
  readonly agents: UiAgentServices;
  readonly providers: UiProviderServices;
  readonly sessions: UiSessionServices;
  readonly platform: UiPlatformServices;
  readonly planning: UiPlanningServices;
  readonly coordination: UiCoordinationServices;
  readonly runtime: {
    readonly distributedRuntime: RuntimeServices['distributedRuntime'];
    readonly remoteRunnerRegistry: RuntimeServices['remoteRunnerRegistry'] & RemoteRunnerRegistry;
    readonly remoteSupervisor: RuntimeServices['remoteSupervisor'] & RemoteSupervisor;
  };
}

export interface UiRuntimeServices {
  readonly environment: UiEnvironmentServices;
  readonly shell: UiShellServices;
  readonly agents: UiAgentServices;
  readonly providers: UiProviderServices;
  readonly sessions: UiSessionServices;
  readonly platform: UiPlatformServices;
  readonly planning: UiPlanningServices;
  readonly coordination: UiCoordinationServices;
  readonly runtime: UiRuntimeSharedServices['runtime'];
  readonly events: UiRuntimeEvents;
  readonly readModels: UiReadModels;
}

export interface UiRuntimeServicesOptions extends UiReadModelOptions {
  readonly forensicsRegistry?: ForensicsRegistry;
  readonly getControlPlaneRecentEvents?: (limit: number) => readonly ControlPlaneRecentEvent[];
}

export function createUiRuntimeServices(
  runtimeServices: RuntimeServices,
  options: UiRuntimeServicesOptions = {},
): UiRuntimeServices {
  return {
    environment: {
      workingDirectory: runtimeServices.workingDirectory,
      homeDirectory: runtimeServices.homeDirectory,
      shellPaths: runtimeServices.shellPaths,
    },
    shell: {
      keybindingsManager: runtimeServices.keybindingsManager,
      panelManager: runtimeServices.panelManager,
      processManager: runtimeServices.processManager,
      profileManager: runtimeServices.profileManager,
      bookmarkManager: runtimeServices.bookmarkManager,
    },
    agents: {
      agentManager: runtimeServices.agentManager,
      agentMessageBus: runtimeServices.agentMessageBus,
      wrfcController: runtimeServices.wrfcController,
    },
    providers: {
      providerRegistry: runtimeServices.providerRegistry,
      favoritesStore: runtimeServices.favoritesStore,
      benchmarkStore: runtimeServices.benchmarkStore,
    },
    sessions: {
      sessionManager: runtimeServices.sessionManager,
      sessionBroker: runtimeServices.sessionBroker,
      sessionOrchestration: runtimeServices.sessionOrchestration,
      sessionMemoryStore: runtimeServices.sessionMemoryStore,
    },
    platform: {
      configManager: runtimeServices.configManager,
      localUserAuthManager: runtimeServices.localUserAuthManager,
      mcpRegistry: runtimeServices.mcpRegistry,
      serviceRegistry: runtimeServices.serviceRegistry,
      surfaceRegistry: runtimeServices.surfaceRegistry,
      subscriptionManager: runtimeServices.subscriptionManager,
      secretsManager: runtimeServices.secretsManager,
      tokenAuditor: runtimeServices.tokenAuditor,
      replayEngine: runtimeServices.replayEngine,
      webhookNotifier: runtimeServices.webhookNotifier,
      focusTracker: runtimeServices.focusTracker,
      policyRuntimeState: runtimeServices.policyRuntimeState,
    },
    planning: {
      planManager: runtimeServices.planManager,
      adaptivePlanner: runtimeServices.adaptivePlanner,
      projectPlanningService: runtimeServices.projectPlanningService,
      projectPlanningProjectId: runtimeServices.projectPlanningProjectId,
      workPlanStore: runtimeServices.workPlanStore,
    },
    coordination: {
      approvalBroker: runtimeServices.approvalBroker,
    },
    runtime: {
      distributedRuntime: runtimeServices.distributedRuntime,
      remoteRunnerRegistry: runtimeServices.remoteRunnerRegistry,
      remoteSupervisor: runtimeServices.remoteSupervisor,
    },
    events: createUiRuntimeEvents(runtimeServices.runtimeBus),
    readModels: createUiReadModels(runtimeServices, options),
  };
}
