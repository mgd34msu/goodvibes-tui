import type { ApprovalBroker } from '@pellux/goodvibes-sdk/platform/control-plane/approval-broker';
import type { SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane/session-broker';
import type { SecretsManager } from '../config/secrets.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { RuntimeServices } from './services.ts';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import type { UiRuntimeEvents } from '@pellux/goodvibes-sdk/platform/runtime/ui-events';
import { createUiRuntimeEvents } from '@pellux/goodvibes-sdk/platform/runtime/ui-events';
import { createCoreReadModels } from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-core';
import {
  createOperationsReadModels,
  type UiOperationsReadModelOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/ui-read-models-operations';
import type { PeerClientDependencies } from '@pellux/goodvibes-sdk/platform/runtime/peer-client';

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
