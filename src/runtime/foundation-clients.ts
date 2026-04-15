import { listHookPointContracts } from '@pellux/goodvibes-sdk/platform/hooks/index';
import type { HookApi } from '@pellux/goodvibes-sdk/platform/hooks/hook-api';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge/knowledge-api';
import type { McpApi } from '@pellux/goodvibes-sdk/platform/mcp/mcp-api';
import type { ProviderApi } from '@pellux/goodvibes-sdk/platform/providers/provider-api';
import type { RuntimeServices } from './services.ts';
import {
  createDirectTransportServices,
  type DirectTransportServices,
  type OperatorClientServicesOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/foundation-services';
import type { OpsApi } from '@pellux/goodvibes-sdk/platform/runtime/ops-api';
import type { OpsControlPlane } from '@pellux/goodvibes-sdk/platform/runtime/ops/control-plane';
import { createRuntimeHookApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-hook-api';
import { createRuntimeKnowledgeApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-knowledge-api';
import { createRuntimeMcpApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-mcp-api';
import { createRuntimeOpsApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-ops-api';
import { createRuntimeProviderApi } from '@pellux/goodvibes-sdk/platform/runtime/runtime-provider-api';
import type { TaskManager } from '@pellux/goodvibes-sdk/platform/runtime/tasks/types';
import { createDirectTransportFromServices, type DirectTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct';
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
