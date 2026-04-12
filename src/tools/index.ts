import { ToolRegistry } from './registry.ts';
import { FileStateCache } from '../state/file-cache.ts';
import { ProjectIndex } from '../state/project-index.ts';
import { ModeManager } from '../state/mode-manager.ts';
import { HookDispatcher } from '../hooks/dispatcher.ts';
import { FileUndoManager } from '../state/file-undo.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ToolLLM } from '../config/tool-llm.ts';
import { ReadTool } from './read/index.ts';
import { createWriteTool } from './write/index.ts';
import { createEditTool } from './edit/index.ts';
import { createFindTool } from './find/index.ts';
import { createExecTool } from './exec/index.ts';
import { createAnalyzeTool } from './analyze/index.ts';
import { InspectTool } from './inspect/index.ts';
import { createAgentTool } from './agent/index.ts';
import { createFetchTool } from './fetch/index.ts';
import { createStateTool } from './state/index.ts';
import { createWorkflowServices, createWorkflowTool } from './workflow/index.ts';
import { createRegistryTool } from './registry-tool/index.ts';
import { KVState } from '../state/kv-state.ts';
import { createTaskTool } from './task/index.ts';
import { teamTool } from './team/index.ts';
import { worklistTool } from './worklist/index.ts';
import { createMcpTool } from './mcp/index.ts';
import { packetTool } from './packet/index.ts';
import { queryTool } from './query/index.ts';
import { createRemoteTool } from './remote-trigger/index.ts';
import { createReplTool } from './repl/index.ts';
import { controlTool } from './control/index.ts';
import { createChannelTool } from './channel/index.ts';
import { createWebSearchTool } from './web-search/index.ts';
import { ProcessManager } from './shared/process-manager.ts';
import { AgentManager } from './agent/index.ts';
import { AgentMessageBus } from '../agents/message-bus.ts';
import type { WrfcController } from '../agents/wrfc-controller.ts';
import type { WebSearchService } from '../web-search/index.ts';
import type { ChannelPluginRegistry } from '../channels/index.ts';
import type { RemoteRunnerRegistry } from '../runtime/remote/index.ts';
import { CrossSessionTaskRegistry } from '../sessions/orchestration/index.ts';
import type { SandboxSessionRegistry } from '../runtime/sandbox/session-registry.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';
import { OverflowHandler } from './shared/overflow.ts';
import type { SessionChangeTracker } from '../sessions/change-tracker.ts';

/**
 * Register all built-in tools into the given registry.
 * Creates shared FileStateCache and ProjectIndex instances so read/write/edit
 * tools share cache state within a session.
 */
export function registerAllTools(
  registry: ToolRegistry,
  deps?: {
    fileCache?: FileStateCache;
    projectIndex?: ProjectIndex;
    fileUndoManager?: FileUndoManager;
    modeManager?: ModeManager;
    processManager?: ProcessManager;
    agentManager?: AgentManager;
    agentMessageBus?: AgentMessageBus;
    wrfcController?: WrfcController;
    webSearchService?: WebSearchService;
    channelRegistry?: ChannelPluginRegistry | null;
    remoteRunnerRegistry?: RemoteRunnerRegistry;
    workflowServices?: ReturnType<typeof createWorkflowServices>;
    mcpRegistry?: import('../mcp/registry.ts').McpRegistry;
    sessionOrchestration?: CrossSessionTaskRegistry;
    sandboxSessionRegistry?: SandboxSessionRegistry;
    configManager?: ConfigManager;
    providerRegistry?: ProviderRegistry;
    toolLLM?: ToolLLM;
    featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
    serviceRegistry?: Pick<ServiceRegistry, 'resolveAuth'> | null;
    overflowHandler?: OverflowHandler;
    changeTracker?: SessionChangeTracker;
  },
): { fileCache: FileStateCache; projectIndex: ProjectIndex } {
  const fileCache = deps?.fileCache ?? new FileStateCache();
  const projectIndex = deps?.projectIndex ?? new ProjectIndex();
  const fileUndoManager = deps?.fileUndoManager ?? new FileUndoManager();
  const modeManager = deps?.modeManager ?? new ModeManager();
  const processManager = deps?.processManager ?? new ProcessManager();
  const agentManager = deps?.agentManager ?? new AgentManager();
  const agentMessageBus = deps?.agentMessageBus ?? new AgentMessageBus();
  const wrfcController = deps?.wrfcController;
  const webSearchService = deps?.webSearchService;
  const channelRegistry = deps?.channelRegistry ?? null;
  const remoteRunnerRegistry = deps?.remoteRunnerRegistry;
  const workflowServices = deps?.workflowServices ?? createWorkflowServices();
  const mcpRegistry = deps?.mcpRegistry;
  const sessionOrchestration = deps?.sessionOrchestration ?? new CrossSessionTaskRegistry();
  if (!deps?.configManager || !deps?.providerRegistry || !deps?.toolLLM) {
    throw new Error('registerAllTools requires configManager, providerRegistry, and toolLLM');
  }
  if (!deps?.sandboxSessionRegistry) {
    throw new Error('registerAllTools requires sandboxSessionRegistry');
  }

  registry.register(new ReadTool(fileCache, projectIndex));
  registry.register(createWriteTool({
    fileCache,
    projectIndex,
    fileUndoManager,
    configManager: deps.configManager,
    toolLLM: deps.toolLLM,
    changeTracker: deps?.changeTracker,
  }));
  registry.register(createEditTool(fileCache, {
    fileUndoManager,
    configManager: deps.configManager,
    toolLLM: deps.toolLLM,
    changeTracker: deps?.changeTracker,
  }));
  registry.register(createFindTool(deps.featureFlags));
  registry.register(createExecTool(processManager, {
    featureFlags: deps.featureFlags,
    overflowHandler: deps.overflowHandler,
  }));
  registry.register(createAnalyzeTool(deps.toolLLM, deps.featureFlags));
  registry.register(new InspectTool(deps.featureFlags));
  registry.register(createAgentTool({
    manager: agentManager,
    messageBus: agentMessageBus,
    configManager: deps.configManager,
    ...(wrfcController ? { wrfcController } : {}),
  }));
  const kvState = new KVState();
  const hookDispatcher = new HookDispatcher();
  registry.register(createStateTool(kvState, projectIndex, hookDispatcher, modeManager));
  registry.register(createWorkflowTool(workflowServices));
  registry.register(createFetchTool({
    serviceRegistry: deps.serviceRegistry,
    featureFlags: deps.featureFlags,
  }));
  if (webSearchService) {
    registry.register(createWebSearchTool(webSearchService));
  }
  registry.register(createRegistryTool(registry));
  registry.register(createTaskTool(sessionOrchestration));
  registry.register(teamTool);
  registry.register(worklistTool);
  if (mcpRegistry) {
    registry.register(createMcpTool(mcpRegistry));
  }
  registry.register(packetTool);
  registry.register(queryTool);
  if (remoteRunnerRegistry) {
    registry.register(createRemoteTool(remoteRunnerRegistry));
  }
  registry.register(createReplTool(deps.configManager, deps.sandboxSessionRegistry));
  registry.register(controlTool);
  registry.register(createChannelTool(channelRegistry));
  return { fileCache, projectIndex };
}
