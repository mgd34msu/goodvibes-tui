import type { ForensicsRegistry } from '@pellux/goodvibes-sdk/platform/runtime/forensics/index';
import type { PolicyRegistry } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-registry';
import type { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';
import type { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/memory-store';
import type { IntegrationHelperService } from '@pellux/goodvibes-sdk/platform/runtime/integration/helpers';
import type { KnowledgeService } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import type { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins/manager';
import type { HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks/workbench';

export interface CommandExtensionShellServices {
  readonly forensicsRegistry?: ForensicsRegistry;
  readonly policyRegistry?: PolicyRegistry;
  readonly policyRuntimeState?: PolicyRuntimeState;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
}

export interface CreateShellExtensionServicesOptions {
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
}

export function createShellExtensionServices(
  options: CreateShellExtensionServicesOptions,
): CommandExtensionShellServices {
  const {
    forensicsRegistry,
    policyRuntimeState,
    memoryRegistry,
    integrationHelpers,
    knowledgeService,
    pluginManager,
    hookWorkbench,
  } = options;

  return {
    forensicsRegistry,
    policyRegistry: policyRuntimeState.getRegistry(),
    policyRuntimeState,
    memoryRegistry,
    integrationHelpers,
    knowledgeService,
    pluginManager,
    hookWorkbench,
  };
}
