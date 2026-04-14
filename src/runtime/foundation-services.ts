import type { ApprovalBroker } from '../control-plane/approval-broker.ts';
import type { SharedSessionBroker } from '../control-plane/session-broker.ts';
import type { SecretsManager } from '../config/secrets.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { SubscriptionManager } from '../config/subscriptions.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { RuntimeServices } from './services.ts';
import type { ShellPathService } from './shell-paths.ts';
import type { UiRuntimeEvents } from './ui-events.ts';
import { createUiRuntimeEvents } from './ui-events.ts';
import { createCoreReadModels } from './ui-read-models-core.ts';
import {
  createOperationsReadModels,
  type UiOperationsReadModelOptions,
} from './ui-read-models-operations.ts';
import type { PeerClientDependencies } from './peer-client.ts';

export interface OperatorClientReadModels {
  readonly controlPlane: ReturnType<typeof createOperationsReadModels>['controlPlane'];
  readonly providers: ReturnType<typeof createCoreReadModels>['providers'];
  readonly session: ReturnType<typeof createCoreReadModels>['session'];
  readonly tasks: ReturnType<typeof createCoreReadModels>['tasks'];
}

export interface OperatorClientServices {
  readonly events: UiRuntimeEvents;
  readonly shellPaths: ShellPathService;
  readonly readModels: OperatorClientReadModels;
  readonly sessionBroker: SharedSessionBroker;
  readonly approvalBroker: ApprovalBroker;
  readonly providerRegistry: ProviderRegistry;
  readonly serviceRegistry: ServiceRegistry;
  readonly subscriptionManager: SubscriptionManager;
  readonly secretsManager: SecretsManager;
}

export interface OperatorClientServicesOptions extends UiOperationsReadModelOptions {}

export interface DirectTransportServices {
  readonly operator: OperatorClientServices;
  readonly peer: PeerClientDependencies;
}

function createOperatorClientReadModels(
  runtimeServices: RuntimeServices,
  options: OperatorClientServicesOptions = {},
): OperatorClientReadModels {
  const core = createCoreReadModels(runtimeServices);
  const operations = createOperationsReadModels(runtimeServices, options);
  return {
    controlPlane: operations.controlPlane,
    providers: core.providers,
    session: core.session,
    tasks: core.tasks,
  };
}

export function createOperatorClientServices(
  runtimeServices: RuntimeServices,
  options: OperatorClientServicesOptions = {},
): OperatorClientServices {
  return {
    events: createUiRuntimeEvents(runtimeServices.runtimeBus),
    shellPaths: runtimeServices.shellPaths,
    readModels: createOperatorClientReadModels(runtimeServices, options),
    sessionBroker: runtimeServices.sessionBroker,
    approvalBroker: runtimeServices.approvalBroker,
    providerRegistry: runtimeServices.providerRegistry,
    serviceRegistry: runtimeServices.serviceRegistry,
    subscriptionManager: runtimeServices.subscriptionManager,
    secretsManager: runtimeServices.secretsManager,
  };
}

export function createPeerClientDependencies(
  runtimeServices: Pick<RuntimeServices, 'distributedRuntime' | 'remoteRunnerRegistry' | 'remoteSupervisor' | 'runtimeStore'>,
): PeerClientDependencies {
  return {
    runtimeStore: runtimeServices.runtimeStore,
    distributedRuntime: runtimeServices.distributedRuntime,
    remoteRunnerRegistry: runtimeServices.remoteRunnerRegistry,
    remoteSupervisor: runtimeServices.remoteSupervisor,
  };
}

export interface DirectTransportServicesOptions extends OperatorClientServicesOptions {}

export function createDirectTransportServices(
  runtimeServices: RuntimeServices,
  options: DirectTransportServicesOptions = {},
): DirectTransportServices {
  return {
    operator: createOperatorClientServices(runtimeServices, options),
    peer: createPeerClientDependencies(runtimeServices),
  };
}
