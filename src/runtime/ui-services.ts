import type { RuntimeServices } from './services.ts';
import type { RemoteRunnerRegistry } from './remote/runner-registry.ts';
import type { RemoteSupervisor } from './remote/supervisor.ts';

export interface UiRuntimeServices {
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
  readonly sessionManager: RuntimeServices['sessionManager'];
  readonly sessionOrchestration: RuntimeServices['sessionOrchestration'];
  readonly serviceRegistry: RuntimeServices['serviceRegistry'];
  readonly subscriptionManager: RuntimeServices['subscriptionManager'];
  readonly tokenAuditor: RuntimeServices['tokenAuditor'];
  readonly webhookNotifier: RuntimeServices['webhookNotifier'];
  readonly wrfcController: RuntimeServices['wrfcController'];
  readonly distributedRuntime: RuntimeServices['distributedRuntime'];
  readonly favoritesStore: RuntimeServices['favoritesStore'];
  readonly benchmarkStore: RuntimeServices['benchmarkStore'];
  readonly providerRegistry: RuntimeServices['providerRegistry'];
  readonly remoteRunnerRegistry: RuntimeServices['remoteRunnerRegistry'] & RemoteRunnerRegistry;
  readonly remoteSupervisor: RuntimeServices['remoteSupervisor'] & RemoteSupervisor;
}

export function createUiRuntimeServices(runtimeServices: RuntimeServices): UiRuntimeServices {
  return {
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
    sessionManager: runtimeServices.sessionManager,
    sessionOrchestration: runtimeServices.sessionOrchestration,
    serviceRegistry: runtimeServices.serviceRegistry,
    subscriptionManager: runtimeServices.subscriptionManager,
    tokenAuditor: runtimeServices.tokenAuditor,
    webhookNotifier: runtimeServices.webhookNotifier,
    wrfcController: runtimeServices.wrfcController,
    distributedRuntime: runtimeServices.distributedRuntime,
    favoritesStore: runtimeServices.favoritesStore,
    benchmarkStore: runtimeServices.benchmarkStore,
    providerRegistry: runtimeServices.providerRegistry,
    remoteRunnerRegistry: runtimeServices.remoteRunnerRegistry,
    remoteSupervisor: runtimeServices.remoteSupervisor,
  };
}
