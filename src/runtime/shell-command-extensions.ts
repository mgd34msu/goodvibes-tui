import type { ForensicsRegistry } from './forensics/index.ts';
import type { PolicyRegistry } from './permissions/policy-registry.ts';
import type { PolicyRuntimeState } from './permissions/policy-runtime.ts';
import type { MemoryRegistry } from '../state/memory-store.ts';
import type { IntegrationHelperService } from './integration/helpers.ts';
import type { KnowledgeService } from '../knowledge/index.ts';
import type { PluginManager } from '../plugins/manager.ts';
import type { HookWorkbench } from '../hooks/workbench.ts';

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
