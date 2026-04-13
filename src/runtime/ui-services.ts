import type { RuntimeServices } from './services.ts';
import type { RemoteRunnerRegistry } from './remote/runner-registry.ts';
import type { RemoteSupervisor } from './remote/supervisor.ts';
import { createUiRuntimeEvents, type UiRuntimeEvents } from './ui-events.ts';
import { createUiReadModels, type UiReadModels, type UiReadModelOptions } from './ui-read-models.ts';
import type { ForensicsRegistry } from './forensics/index.ts';
import type { ControlPlaneRecentEvent } from '../control-plane/index.ts';
import type { ApprovalBroker } from '../control-plane/approval-broker.ts';
import type { SharedSessionBroker } from '../control-plane/session-broker.ts';
import type { ShellPathService } from './shell-paths.ts';
import type { SecretsManager } from '../config/secrets.ts';

export interface UiRuntimeServices {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly shellPaths: ShellPathService;
  readonly configManager: RuntimeServices['configManager'];
  readonly agentManager: RuntimeServices['agentManager'];
  readonly agentMessageBus: RuntimeServices['agentMessageBus'];
  readonly bookmarkManager: RuntimeServices['bookmarkManager'];
  readonly keybindingsManager: RuntimeServices['keybindingsManager'];
  readonly localUserAuthManager: RuntimeServices['localUserAuthManager'];
  readonly mcpRegistry: RuntimeServices['mcpRegistry'];
  readonly panelManager: RuntimeServices['panelManager'];
  readonly processManager: RuntimeServices['processManager'];
  readonly profileManager: RuntimeServices['profileManager'];
  readonly policyRuntimeState: RuntimeServices['policyRuntimeState'];
  readonly replayEngine: RuntimeServices['replayEngine'];
  readonly approvalBroker: ApprovalBroker;
  readonly sessionBroker: SharedSessionBroker;
  readonly sessionManager: RuntimeServices['sessionManager'];
  readonly sessionOrchestration: RuntimeServices['sessionOrchestration'];
  readonly serviceRegistry: RuntimeServices['serviceRegistry'];
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: RuntimeServices['subscriptionManager'];
  readonly tokenAuditor: RuntimeServices['tokenAuditor'];
  readonly webhookNotifier: RuntimeServices['webhookNotifier'];
  readonly wrfcController: RuntimeServices['wrfcController'];
  readonly distributedRuntime: RuntimeServices['distributedRuntime'];
  readonly favoritesStore: RuntimeServices['favoritesStore'];
  readonly benchmarkStore: RuntimeServices['benchmarkStore'];
  readonly sessionMemoryStore: RuntimeServices['sessionMemoryStore'];
  readonly planManager: RuntimeServices['planManager'];
  readonly adaptivePlanner: RuntimeServices['adaptivePlanner'];
  readonly providerRegistry: RuntimeServices['providerRegistry'];
  readonly remoteRunnerRegistry: RuntimeServices['remoteRunnerRegistry'] & RemoteRunnerRegistry;
  readonly remoteSupervisor: RuntimeServices['remoteSupervisor'] & RemoteSupervisor;
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
    workingDirectory: runtimeServices.workingDirectory,
    homeDirectory: runtimeServices.homeDirectory,
    shellPaths: runtimeServices.shellPaths,
    configManager: runtimeServices.configManager,
    agentManager: runtimeServices.agentManager,
    agentMessageBus: runtimeServices.agentMessageBus,
    bookmarkManager: runtimeServices.bookmarkManager,
    keybindingsManager: runtimeServices.keybindingsManager,
    localUserAuthManager: runtimeServices.localUserAuthManager,
    mcpRegistry: runtimeServices.mcpRegistry,
    panelManager: runtimeServices.panelManager,
    processManager: runtimeServices.processManager,
    profileManager: runtimeServices.profileManager,
    policyRuntimeState: runtimeServices.policyRuntimeState,
    replayEngine: runtimeServices.replayEngine,
    approvalBroker: runtimeServices.approvalBroker,
    sessionBroker: runtimeServices.sessionBroker,
    sessionManager: runtimeServices.sessionManager,
    sessionOrchestration: runtimeServices.sessionOrchestration,
    serviceRegistry: runtimeServices.serviceRegistry,
    secretsManager: runtimeServices.secretsManager,
    subscriptionManager: runtimeServices.subscriptionManager,
    tokenAuditor: runtimeServices.tokenAuditor,
    webhookNotifier: runtimeServices.webhookNotifier,
    wrfcController: runtimeServices.wrfcController,
    distributedRuntime: runtimeServices.distributedRuntime,
    favoritesStore: runtimeServices.favoritesStore,
    benchmarkStore: runtimeServices.benchmarkStore,
    sessionMemoryStore: runtimeServices.sessionMemoryStore,
    planManager: runtimeServices.planManager,
    adaptivePlanner: runtimeServices.adaptivePlanner,
    providerRegistry: runtimeServices.providerRegistry,
    remoteRunnerRegistry: runtimeServices.remoteRunnerRegistry,
    remoteSupervisor: runtimeServices.remoteSupervisor,
    events: createUiRuntimeEvents(runtimeServices.runtimeBus),
    readModels: createUiReadModels(runtimeServices, options),
  };
}
