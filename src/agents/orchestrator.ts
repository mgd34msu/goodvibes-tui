import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import type { ConfigManager } from '../config/manager.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { registerAllTools } from '../tools/index.ts';
import { registerChannelAgentTools } from '../tools/channel/agent-tools.ts';
import { AgentMessageBus } from './message-bus.ts';
import type { ChannelPluginRegistry } from '../channels/index.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import { FileStateCache } from '@pellux/goodvibes-sdk/platform/state/file-cache';
import { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state/project-index';
import type { AgentRecord } from '../tools/agent/index.ts';
import type { ToolLLM } from '../config/tool-llm.ts';
import type { LLMProvider } from '../providers/interface.ts';
import type { FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/manager';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitAgentCancelled,
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentProgress,
  emitAgentRunning,
  emitAgentStreamDelta,
  emitOrchestrationNodeCancelled,
  emitOrchestrationNodeCompleted,
  emitOrchestrationNodeFailed,
  emitOrchestrationNodeProgress,
} from '../runtime/emitters/index.ts';
import { splitModelRegistryKey } from '../providers/registry-helpers.ts';
import { runAgentTask, type AgentOrchestratorRunContext } from './orchestrator-runner.ts';
export { summarizeToolArgs } from '@pellux/goodvibes-sdk/platform/agents/orchestrator-utils';

type AgentProviderRoutingPolicy = NonNullable<AgentRecord['routing']>;
type ResolvedAgentProviderRouting = {
  readonly requestedModelId: string;
  readonly providerSelection: NonNullable<AgentProviderRoutingPolicy['providerSelection']>;
  readonly unresolvedModelPolicy: NonNullable<AgentProviderRoutingPolicy['unresolvedModelPolicy']>;
  readonly providerFailurePolicy: NonNullable<AgentProviderRoutingPolicy['providerFailurePolicy']>;
  readonly providerId?: string;
  readonly providerOverride?: string;
  readonly fallbackModels: readonly string[];
};

type AgentOrchestratorToolDeps = {
  readonly fileCache: FileStateCache;
  readonly projectIndex: ProjectIndex;
  readonly workingDirectory: string;
  readonly fileUndoManager: import('@pellux/goodvibes-sdk/platform/state/file-undo').FileUndoManager;
  readonly modeManager: import('@pellux/goodvibes-sdk/platform/state/mode-manager').ModeManager;
  readonly processManager: import('@pellux/goodvibes-sdk/platform/tools/shared/process-manager').ProcessManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly webSearchService?: import('../web-search/index.ts').WebSearchService;
  readonly channelRegistry?: import('../channels/index.ts').ChannelPluginRegistry | null;
  readonly remoteRunnerRegistry?: import('../runtime/remote/index.ts').RemoteRunnerRegistry;
  readonly knowledgeService?: import('../knowledge/index.ts').KnowledgeService;
  readonly memoryRegistry?: import('../state/index.ts').MemoryRegistry;
  readonly sessionOrchestration: import('@pellux/goodvibes-sdk/platform/sessions/orchestration/index').CrossSessionTaskRegistry;
  readonly archetypeLoader?: import('@pellux/goodvibes-sdk/platform/agents/archetypes').ArchetypeLoader;
  readonly configManager?: ConfigManager;
  readonly providerRegistry?: ProviderRegistry;
  readonly providerOptimizer?: import('../providers/optimizer.ts').ProviderOptimizer;
  readonly toolLLM?: ToolLLM;
  readonly serviceRegistry?: import('../config/service-registry.ts').ServiceRegistry;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
  readonly overflowHandler?: import('@pellux/goodvibes-sdk/platform/tools/shared/overflow').OverflowHandler;
  readonly sandboxSessionRegistry: import('@pellux/goodvibes-sdk/platform/runtime/sandbox/session-registry').SandboxSessionRegistry;
  readonly workflowServices: ReturnType<typeof import('@pellux/goodvibes-sdk/platform/tools/workflow/index').createWorkflowServices>;
};

/**
 * AgentOrchestrator — runs AgentRecord tasks in-process.
 *
 * Each agent gets its own scoped ToolRegistry containing only the tools
 * listed in record.tools. The execution loop itself now lives in
 * `orchestrator-runner.ts`; this class owns shared registry/state wiring.
 */
export class AgentOrchestrator {
  private fullRegistry: ToolRegistry | null = null;
  private fullRegistryChannelVersion = -2;
  private toolDeps: AgentOrchestratorToolDeps | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private readonly channelRegistry: ChannelPluginRegistry | null;
  private readonly messageBus: import('./message-bus.ts').AgentMessageBus;

  constructor(config: {
    channelRegistry?: ChannelPluginRegistry | null;
    messageBus: import('./message-bus.ts').AgentMessageBus;
  } = {
    messageBus: new AgentMessageBus(),
  }) {
    this.channelRegistry = config.channelRegistry ?? null;
    this.messageBus = config.messageBus;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  /** Set the FeatureFlagManager for context-window awareness gating. */
  setFeatureFlagManager(manager: FeatureFlagManager): void {
    this.featureFlagManager = manager;
  }

  private emitterContext(agentId: string): import('../runtime/emitters/index.ts').EmitterContext {
    return {
      sessionId: 'agent-orchestrator',
      traceId: `agent-orchestrator:${agentId}`,
      source: 'agent-orchestrator',
    };
  }

  private emitAgentProgress(recordId: string, progress: string): void {
    if (!this.runtimeBus) return;
    emitAgentProgress(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      progress,
    });
  }

  private emitOrchestrationProgress(record: AgentRecord, progress: string): void {
    if (!this.runtimeBus || !record.orchestrationGraphId || !record.orchestrationNodeId) return;
    emitOrchestrationNodeProgress(this.runtimeBus, this.emitterContext(record.id), {
      graphId: record.orchestrationGraphId,
      nodeId: record.orchestrationNodeId,
      message: progress,
    });
  }

  private emitAgentStarted(recordId: string): void {
    if (!this.runtimeBus) return;
    emitAgentRunning(this.runtimeBus, this.emitterContext(recordId), { agentId: recordId });
  }

  private emitAgentCancelledEvent(recordId: string, reason: string): void {
    if (!this.runtimeBus) return;
    emitAgentCancelled(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      reason,
    });
  }

  private emitOrchestrationCancelled(record: AgentRecord, reason: string): void {
    if (!this.runtimeBus || !record.orchestrationGraphId || !record.orchestrationNodeId) return;
    emitOrchestrationNodeCancelled(this.runtimeBus, this.emitterContext(record.id), {
      graphId: record.orchestrationGraphId,
      nodeId: record.orchestrationNodeId,
      reason,
    });
  }

  private emitAgentFailedEvent(recordId: string, error: string, durationMs: number): void {
    if (!this.runtimeBus) return;
    emitAgentFailed(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      error,
      durationMs,
    });
  }

  private emitOrchestrationFailed(record: AgentRecord, error: string): void {
    if (!this.runtimeBus || !record.orchestrationGraphId || !record.orchestrationNodeId) return;
    emitOrchestrationNodeFailed(this.runtimeBus, this.emitterContext(record.id), {
      graphId: record.orchestrationGraphId,
      nodeId: record.orchestrationNodeId,
      error,
    });
  }

  private emitAgentCompletedEvent(
    recordId: string,
    durationMs: number,
    output: string,
    toolCallsMade: number,
  ): void {
    if (!this.runtimeBus) return;
    emitAgentCompleted(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      durationMs,
      output,
      toolCallsMade,
    });
  }

  private emitOrchestrationCompleted(record: AgentRecord, output: string): void {
    if (!this.runtimeBus || !record.orchestrationGraphId || !record.orchestrationNodeId) return;
    emitOrchestrationNodeCompleted(this.runtimeBus, this.emitterContext(record.id), {
      graphId: record.orchestrationGraphId,
      nodeId: record.orchestrationNodeId,
      summary: output.length > 120 ? `${output.slice(0, 117)}...` : output,
    });
  }

  private emitStreamDelta(recordId: string, content: string, accumulated: string): void {
    if (!this.runtimeBus || !content) return;
    emitAgentStreamDelta(this.runtimeBus, this.emitterContext(recordId), {
      agentId: recordId,
      content,
      accumulated,
    });
  }

  /**
   * Inject shared file-cache and project-index so agent tools share state with main session.
   * Call once during application startup, before any agents are spawned.
   */
  setDependencies(toolDeps: AgentOrchestratorToolDeps): void {
    this.toolDeps = toolDeps;
    this.fullRegistry = null;
    this.fullRegistryChannelVersion = -2;
  }

  /** Lazily build and cache the full ToolRegistry. */
  private getFullRegistry(): ToolRegistry {
    const channelVersion = this.channelRegistry?.getVersion() ?? -1;
    if (!this.fullRegistry || this.fullRegistryChannelVersion !== channelVersion) {
      if (!this.toolDeps?.configManager || !this.toolDeps?.providerRegistry || !this.toolDeps?.toolLLM) {
        throw new Error('AgentOrchestrator requires configManager, providerRegistry, and toolLLM dependencies before tool registration');
      }
      this.fullRegistry = new ToolRegistry();
      registerAllTools(this.fullRegistry, this.toolDeps);
      registerChannelAgentTools(this.fullRegistry, this.toolDeps?.channelRegistry ?? this.channelRegistry);
      this.fullRegistryChannelVersion = channelVersion;
    }
    return this.fullRegistry;
  }

  /**
   * Build a ToolRegistry containing only the tools whose names appear in
   * the allowedNames list. Filters the provided full registry into a fresh
   * scoped registry.
   */
  private buildScopedRegistry(allowedNames: string[], fullRegistry: ToolRegistry): ToolRegistry {
    const allowed = new Set(allowedNames.filter((n) => n !== 'agent'));

    const scopedRegistry = new ToolRegistry();
    for (const tool of fullRegistry.list()) {
      if (allowed.has(tool.definition.name)) {
        scopedRegistry.register(tool);
      }
    }

    return scopedRegistry;
  }

  private resolveProviderForRecord(
    providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'get' | 'listModels'>,
    record: AgentRecord,
    currentModel: { id: string; provider: string },
  ): { provider: LLMProvider; modelId: string; requestedModelId: string } {
    const routing = this.resolveProviderRouting(record, currentModel);
    const scopedModelId = this.normalizeRequestedModelId(routing.requestedModelId, routing.providerOverride);

    try {
      return {
        provider: providerRegistry.getForModel(scopedModelId, routing.providerOverride),
        modelId: this.resolveChatModelId(providerRegistry, scopedModelId, routing.providerOverride),
        requestedModelId: scopedModelId,
      };
    } catch (err) {
      if (routing.requestedModelId !== currentModel.id && routing.unresolvedModelPolicy === 'fallback-to-current') {
        logger.debug(`[AgentOrchestrator] Requested model '${routing.requestedModelId}' not found, falling back to '${currentModel.id}'`);
        try {
          return {
            provider: providerRegistry.getForModel(currentModel.id, currentModel.provider),
            modelId: this.resolveChatModelId(providerRegistry, currentModel.id, currentModel.provider),
            requestedModelId: currentModel.id,
          };
        } catch (fallbackErr) {
          throw new Error(
            `Cannot resolve provider for model '${routing.requestedModelId}' (${
              summarizeError(err)
            }) or fallback '${currentModel.id}' (${
              summarizeError(fallbackErr)
            })`,
          );
        }
      }

      throw new Error(
        `Cannot resolve provider for model '${scopedModelId}': ${
          summarizeError(err)
        }`,
      );
    }
  }

  private resolveProviderRouting(
    record: AgentRecord,
    currentModel: { id: string; provider: string },
  ): ResolvedAgentProviderRouting {
    const requestedModelId = record.model ?? currentModel.id;
    const fallbackModels = (
      record.routing?.fallbackModels
      ?? record.fallbackModels
      ?? []
    )
      .filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
      .map((model) => model.trim());
    const providerSelection = record.routing?.providerSelection ?? (
      record.provider === 'synthetic'
        ? 'synthetic'
        : record.provider
          ? 'concrete'
          : 'inherit-current'
    );
    const providerId = record.provider;
    const effectiveProviderId = providerSelection === 'synthetic'
      ? undefined
      : providerSelection === 'concrete'
        ? (providerId ?? currentModel.provider)
        : currentModel.provider;
    const providerOverride = effectiveProviderId !== 'synthetic'
      ? effectiveProviderId
      : undefined;
    const unresolvedModelPolicy = record.routing?.unresolvedModelPolicy ?? (
      providerOverride && providerOverride !== currentModel.provider
        ? 'fail'
        : 'fallback-to-current'
    );
    return {
      requestedModelId,
      providerSelection,
      unresolvedModelPolicy,
      providerFailurePolicy: record.routing?.providerFailurePolicy ?? (
        fallbackModels.length > 0
          ? 'ordered-fallbacks'
          : 'fail'
      ),
      providerId,
      providerOverride,
      fallbackModels,
    };
  }

  private normalizeRequestedModelId(
    requestedModelId: string,
    providerOverride?: string,
  ): string {
    if (!providerOverride || !requestedModelId.includes(':')) {
      return requestedModelId;
    }

    return splitModelRegistryKey(requestedModelId).resolvedModelId;
  }

  private resolveChatModelId(
    providerRegistry: Pick<ProviderRegistry, 'listModels'>,
    requestedModelId: string,
    providerOverride?: string,
  ): string {
    const registry = providerRegistry.listModels();
    const def = requestedModelId.includes(':')
      ? providerOverride
        ? registry.find((model) => model.registryKey === requestedModelId && model.provider === providerOverride)
          ?? registry.find((model) => model.id === splitModelRegistryKey(requestedModelId).resolvedModelId && model.provider === providerOverride)
        : registry.find((model) => model.registryKey === requestedModelId)
          ?? registry.find((model) => model.id === requestedModelId)
          ?? registry.find((model) => model.id === splitModelRegistryKey(requestedModelId).resolvedModelId)
      : providerOverride
        ? registry.find((model) => model.id === requestedModelId && model.provider === providerOverride)
        : registry.find((model) => model.id === requestedModelId);
    if (def) return def.id;
    return requestedModelId;
  }

  private resolveFallbackModelRoutes(
    providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getForModel'>,
    record: AgentRecord,
    currentModel: { id: string; provider: string },
    primaryRequestedModelId: string,
  ): Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }> {
    const routing = this.resolveProviderRouting(record, currentModel);
    if (routing.providerFailurePolicy !== 'ordered-fallbacks' || routing.fallbackModels.length === 0) {
      return [];
    }
    const seen = new Set([primaryRequestedModelId]);
    const routes: Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }> = [];
    for (const rawFallback of routing.fallbackModels) {
      const requestedModelId = this.normalizeRequestedModelId(rawFallback, routing.providerOverride);
      if (!requestedModelId || seen.has(requestedModelId)) continue;
      seen.add(requestedModelId);
      try {
        routes.push({
          provider: providerRegistry.getForModel(requestedModelId, routing.providerOverride),
          modelId: this.resolveChatModelId(providerRegistry, requestedModelId, routing.providerOverride),
          requestedModelId,
        });
      } catch (error) {
        logger.warn('[AgentOrchestrator] Ignoring unresolved fallback model', {
          agentId: record.id,
          modelId: requestedModelId,
          error: summarizeError(error),
        });
      }
    }
    return routes;
  }

  private createRunContext(): AgentOrchestratorRunContext {
    return {
      workingDirectory: this.toolDeps!.workingDirectory,
      runtimeBus: this.runtimeBus,
      featureFlagManager: this.featureFlagManager,
      emitterContext: (agentId) => this.emitterContext(agentId),
      emitAgentProgress: (recordId, progress) => this.emitAgentProgress(recordId, progress),
      emitOrchestrationProgress: (record, progress) => this.emitOrchestrationProgress(record, progress),
      emitAgentStarted: (recordId) => this.emitAgentStarted(recordId),
      emitAgentCancelledEvent: (recordId, reason) => this.emitAgentCancelledEvent(recordId, reason),
      emitOrchestrationCancelled: (record, reason) => this.emitOrchestrationCancelled(record, reason),
      emitAgentFailedEvent: (recordId, error, durationMs) => this.emitAgentFailedEvent(recordId, error, durationMs),
      emitOrchestrationFailed: (record, error) => this.emitOrchestrationFailed(record, error),
      emitAgentCompletedEvent: (recordId, durationMs, output, toolCallsMade) =>
        this.emitAgentCompletedEvent(recordId, durationMs, output, toolCallsMade),
      emitOrchestrationCompleted: (record, output) => this.emitOrchestrationCompleted(record, output),
      emitStreamDelta: (recordId, content, accumulated) => this.emitStreamDelta(recordId, content, accumulated),
      processManager: this.toolDeps?.processManager,
      messageBus: this.messageBus,
      knowledgeService: this.toolDeps?.knowledgeService,
      memoryRegistry: this.toolDeps?.memoryRegistry,
      archetypeLoader: this.toolDeps?.archetypeLoader,
      providerOptimizer: this.toolDeps?.providerOptimizer,
      providerRegistry: this.toolDeps!.providerRegistry!,
      getFullRegistry: () => this.getFullRegistry(),
      buildScopedRegistry: (allowedNames, fullRegistry) => this.buildScopedRegistry(allowedNames, fullRegistry),
      resolveProviderForRecord: (providerRegistry, record, currentModel) =>
        this.resolveProviderForRecord(providerRegistry, record, currentModel),
      resolveFallbackModelRoutes: (providerRegistry, record, currentModel, primaryRequestedModelId) =>
        this.resolveFallbackModelRoutes(providerRegistry, record, currentModel, primaryRequestedModelId),
    };
  }

  /** Run an agent task described by the given record. */
  async runAgent(record: AgentRecord): Promise<void> {
    await runAgentTask(this.createRunContext(), record);
  }
}
