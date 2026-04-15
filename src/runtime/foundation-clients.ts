import { listHookPointContracts } from '../hooks/index.ts';
import type { HookApi } from '../hooks/hook-api.ts';
import type { KnowledgeApi } from '../knowledge/knowledge-api.ts';
import type { McpApi } from '../mcp/mcp-api.ts';
import type { ProviderApi } from '../providers/provider-api.ts';
import type { RuntimeServices } from './services.ts';
import {
  createDirectTransportServices,
  type DirectTransportServices,
  type OperatorClientServicesOptions,
} from './foundation-services.ts';
import type { OpsApi } from './ops-api.ts';
import type { OpsControlPlane } from './ops/control-plane.ts';
import { createRuntimeHookApi } from './runtime-hook-api.ts';
import { createRuntimeKnowledgeApi } from './runtime-knowledge-api.ts';
import { createRuntimeMcpApi } from './runtime-mcp-api.ts';
import { createRuntimeOpsApi } from './runtime-ops-api.ts';
import { createRuntimeProviderApi } from './runtime-provider-api.ts';
import type { TaskManager } from '@pellux/goodvibes-sdk/platform/runtime/tasks/types';
import { createDirectTransportFromServices, type DirectTransport } from './transports/direct.ts';
import type { UiTasksSnapshot } from './ui-read-models.ts';

export interface RuntimeFoundationClientsOptions extends OperatorClientServicesOptions {
  readonly runtimeServices: RuntimeServices;
  readonly tasksReadModel: {
    getSnapshot(): UiTasksSnapshot;
  };
  readonly taskManager: TaskManager;
  readonly opsControlPlane?: OpsControlPlane;
}

export interface RuntimeFoundationClients {
  readonly transportServices: DirectTransportServices;
  readonly directTransport: DirectTransport;
  readonly providerApi: ProviderApi;
  readonly knowledgeApi: KnowledgeApi;
  readonly hookApi: HookApi;
  readonly mcpApi: McpApi;
  readonly opsApi: OpsApi;
}

export function createRuntimeFoundationClients(
  options: RuntimeFoundationClientsOptions,
): RuntimeFoundationClients {
  const {
    runtimeServices,
    tasksReadModel,
    taskManager,
    opsControlPlane,
    getControlPlaneRecentEvents,
  } = options;

  const transportServices = createDirectTransportServices(runtimeServices, {
    ...(getControlPlaneRecentEvents ? { getControlPlaneRecentEvents } : {}),
  });
  const directTransport = createDirectTransportFromServices(transportServices);

  return {
    transportServices,
    directTransport,
    providerApi: createRuntimeProviderApi(runtimeServices),
    knowledgeApi: createRuntimeKnowledgeApi(runtimeServices),
    hookApi: createRuntimeHookApi({
      dispatcher: {
        listHooks: () => runtimeServices.hookDispatcher.listHooks(),
        listChains: () => runtimeServices.hookWorkbench.listManagedChains(),
      },
      workbench: runtimeServices.hookWorkbench,
      listContracts: () => listHookPointContracts(),
    }),
    mcpApi: createRuntimeMcpApi(runtimeServices.mcpRegistry),
    opsApi: createRuntimeOpsApi({
      tasksReadModel,
      taskManager,
      opsControlPlane,
    }),
  };
}
