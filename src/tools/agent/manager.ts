import { ArchetypeLoader } from '../../agents/archetypes.ts';
import { AgentOrchestrator } from '../../agents/orchestrator.ts';
import { AgentMessageBus } from '../../agents/message-bus.ts';
import { WrfcController } from '../../agents/wrfc-controller.ts';
import type { ConfigManager } from '../../config/manager.ts';
import type { RuntimeEventBus } from '../../runtime/events/index.ts';
import {
  emitAgentSpawning,
  emitOrchestrationGraphCreated,
  emitOrchestrationNodeAdded,
  emitOrchestrationNodeCancelled,
  emitOrchestrationRecursionGuardTriggered,
  emitOrchestrationNodeStarted,
} from '../../runtime/emitters/index.ts';
import type { OrchestrationTaskContract } from '../../runtime/events/index.ts';
import { evaluateOrchestrationSpawn } from '../../runtime/orchestration/spawn-policy.ts';
import type { ExecutionIntent } from '../../runtime/execution-intents.ts';
import { logger } from '../../utils/logger.ts';
import type { AgentInput } from './schema.ts';
import { summarizeError } from '../../utils/error-display.ts';

export type AgentExecutor = {
  runAgent(record: AgentRecord): Promise<void>;
};

export interface AgentManagerDependencies {
  readonly archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'>;
  readonly messageBus?: Pick<AgentMessageBus, 'registerAgent'>;
  readonly wrfcController?: Pick<WrfcController, 'createChain'> | null;
  readonly executor?: AgentExecutor | null;
  readonly configManager?: Pick<ConfigManager, 'get'>;
}

export const AGENT_TEMPLATES: Record<string, { description: string; defaultTools: string[] }> = {
  engineer: {
    description: 'Full-stack implementation agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  reviewer: {
    description: 'Code review and quality assessment',
    defaultTools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  tester: {
    description: 'Test writing and execution',
    defaultTools: ['read', 'write', 'find', 'exec', 'analyze', 'inspect'],
  },
  researcher: {
    description: 'Codebase exploration and analysis',
    defaultTools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  general: {
    description: 'General purpose agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
  },
};

export interface AgentRecord {
  id: string;
  task: string;
  template: string;
  model?: string;
  provider?: string;
  fallbackModels?: string[];
  routing?: AgentInput['routing'];
  executionIntent?: ExecutionIntent;
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
  context?: string;
  tools: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  progress?: string;
  toolCallCount: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens?: number;
    llmCallCount: number;
    turnCount: number;
    reasoningSummaryCount?: number;
  };
  error?: string;
  fullOutput?: string;
  streamingContent?: string;
  wrfcId?: string;
  dangerously_disable_wrfc?: boolean;
  cohort?: string;
  orchestrationGraphId?: string;
  orchestrationNodeId?: string;
  orchestrationDepth: number;
  parentAgentId?: string;
  parentNodeId?: string;
  capabilityCeilingTools?: string[];
  successCriteria?: string[];
  requiredEvidence?: string[];
  writeScope?: string[];
  executionProtocol: 'direct' | 'gather-plan-apply';
  reviewMode: 'none' | 'wrfc';
  communicationLane: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct';
  knowledgeInjections?: Array<{
    id: string;
    cls: string;
    summary: string;
    reason: string;
    confidence: number;
    reviewState: 'fresh' | 'reviewed' | 'stale' | 'contradicted';
  }>;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private runtimeBus: RuntimeEventBus | null = null;
  private orchestrationGraphs = new Set<string>();
  private readonly archetypeLoader: Pick<ArchetypeLoader, 'loadArchetype'>;
  private readonly messageBus: Pick<AgentMessageBus, 'registerAgent'>;
  private wrfcController: Pick<WrfcController, 'createChain'> | null;
  private executor: AgentExecutor | null;
  private readonly configManager: Pick<ConfigManager, 'get'> | null;

  constructor(deps: AgentManagerDependencies = {}) {
    this.archetypeLoader = deps.archetypeLoader ?? new ArchetypeLoader();
    this.messageBus = deps.messageBus ?? new AgentMessageBus();
    this.wrfcController = deps.wrfcController ?? null;
    this.executor = deps.executor ?? null;
    this.configManager = deps.configManager ?? null;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  private deriveEffectiveTools(
    input: AgentInput,
    defaultTools: string[],
  ): {
    tools: string[];
    capabilityCeilingTools?: string[];
  } {
    const requestedTools = input.tools
      ? (input.restrictTools ? [...input.tools] : [...new Set([...defaultTools, ...input.tools])])
      : [...defaultTools];

    if (!input.parentAgentId) {
      return { tools: requestedTools };
    }

    const parentRecord = this.agents.get(input.parentAgentId);
    if (!parentRecord) {
      throw new Error(`Unknown parent agent: '${input.parentAgentId}'`);
    }

    const parentCeiling = parentRecord.capabilityCeilingTools ?? parentRecord.tools;
    const tools = requestedTools.filter((tool) => parentCeiling.includes(tool));
    if (tools.length === 0) {
      throw new Error(`Spawned child agent would exceed parent capability ceiling from '${input.parentAgentId}'`);
    }

    return {
      tools,
      capabilityCeilingTools: [...parentCeiling],
    };
  }

  spawn(input: AgentInput): AgentRecord {
    const task = input.task;
    if (!task || typeof task !== 'string' || task.trim() === '') {
      throw new Error('spawn() requires a non-empty task string');
    }
    if (!this.configManager) {
      throw new Error('AgentManager requires configManager');
    }
    const template = input.template ?? 'general';

    const archetype = this.archetypeLoader.loadArchetype(template);
    const templateDef = AGENT_TEMPLATES[template] ?? AGENT_TEMPLATES.general;
    const defaultTools = archetype ? archetype.tools : templateDef.defaultTools;
    if (input.restrictTools && (!input.tools || input.tools.length === 0)) {
      logger.warn('spawn: restrictTools=true has no effect without a tools array — falling back to template defaults', { template });
    }
    const toolResolution = this.deriveEffectiveTools(input, defaultTools);
    const tools = toolResolution.tools;

    if (!input.model && archetype?.model) {
      input = { ...input, model: archetype.model };
    }
    if (!input.provider && archetype?.provider) {
      input = { ...input, provider: archetype.provider };
    }

    const parentRecord = input.parentAgentId ? this.agents.get(input.parentAgentId) : undefined;
    if (input.parentAgentId && !parentRecord) {
      throw new Error(`Unknown parent agent: '${input.parentAgentId}'`);
    }
    const orchestrationDepth = parentRecord ? parentRecord.orchestrationDepth + 1 : 0;
    const activeAgents = this.list().filter((agent) => agent.status === 'pending' || agent.status === 'running').length;
    const spawnDecision = evaluateOrchestrationSpawn({
      configManager: this.configManager,
      mode: input.parentAgentId ? 'recursive-child' : 'manual-batch',
      activeAgents,
      requestedDepth: orchestrationDepth,
    });
    if (!spawnDecision.allowed) {
      if (this.runtimeBus && (input.orchestrationGraphId ?? parentRecord?.orchestrationGraphId)) {
        emitOrchestrationRecursionGuardTriggered(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:recursion-guard:${input.parentAgentId ?? 'root'}`,
          source: 'agent-manager',
          ...(input.parentAgentId ? { agentId: input.parentAgentId } : {}),
        }, {
          graphId: input.orchestrationGraphId ?? parentRecord?.orchestrationGraphId ?? 'orchestration',
          ...(input.parentNodeId ?? parentRecord?.orchestrationNodeId ? { nodeId: input.parentNodeId ?? parentRecord?.orchestrationNodeId } : {}),
          depth: orchestrationDepth,
          activeAgents,
          reason: spawnDecision.reason ?? 'spawn policy rejected the child worker',
        });
      }
      throw new Error(spawnDecision.reason ?? 'Spawn policy rejected the child worker');
    }

    const executionProtocol = input.executionProtocol ?? 'gather-plan-apply';
    const reviewMode = input.reviewMode ?? (input.dangerously_disable_wrfc ? 'none' : 'wrfc');
    const communicationLane = input.communicationLane
      ?? (input.parentAgentId ? 'parent-only' : input.cohort ? 'cohort' : 'direct');

    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const record: AgentRecord = {
      id,
      task,
      template,
      model: input.model,
      provider: input.provider,
      fallbackModels: input.fallbackModels?.filter((model) => typeof model === 'string' && model.trim().length > 0).map((model) => model.trim()),
      routing: input.routing
        ? {
            ...input.routing,
            ...(input.routing.fallbackModels
              ? {
                  fallbackModels: input.routing.fallbackModels
                    .filter((model) => typeof model === 'string' && model.trim().length > 0)
                    .map((model) => model.trim()),
                }
              : {}),
          }
        : undefined,
      executionIntent: input.executionIntent,
      reasoningEffort: input.reasoningEffort,
      context: input.context,
      tools,
      orchestrationDepth,
      executionProtocol,
      reviewMode,
      communicationLane,
      status: 'pending',
      startedAt: Date.now(),
      toolCallCount: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        llmCallCount: 0,
        turnCount: 0,
        reasoningSummaryCount: 0,
      },
      dangerously_disable_wrfc: input.dangerously_disable_wrfc,
      cohort: input.cohort,
      ...(input.orchestrationGraphId ?? input.cohort ? {
        orchestrationGraphId: input.orchestrationGraphId ?? parentRecord?.orchestrationGraphId ?? `cohort:${input.cohort}`,
        orchestrationNodeId: input.orchestrationNodeId ?? id,
      } : {}),
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      ...(input.parentNodeId ? { parentNodeId: input.parentNodeId } : {}),
      ...(toolResolution.capabilityCeilingTools ? { capabilityCeilingTools: toolResolution.capabilityCeilingTools } : {}),
      ...(input.successCriteria ? { successCriteria: [...input.successCriteria] } : {}),
      ...(input.requiredEvidence ? { requiredEvidence: [...input.requiredEvidence] } : {}),
      ...(input.writeScope ? { writeScope: [...input.writeScope] } : {}),
    };

    this.agents.set(id, record);
    this.messageBus.registerAgent({
      agentId: id,
      template,
      parentAgentId: input.parentAgentId,
      cohort: input.cohort,
    });
    if (this.runtimeBus) {
      emitAgentSpawning(this.runtimeBus, {
        sessionId: 'agent-manager',
        traceId: `agent-manager:${id}`,
        source: 'agent-manager',
      }, {
        agentId: id,
        task,
      });
      const contract: OrchestrationTaskContract = {
        allowedTools: [...record.tools],
        capabilityCeiling: [...(record.capabilityCeilingTools ?? record.tools)],
        ...(record.successCriteria ? { successCriteria: [...record.successCriteria] } : {}),
        ...(record.requiredEvidence ? { requiredEvidence: [...record.requiredEvidence] } : {}),
        ...(record.writeScope ? { writeScope: [...record.writeScope] } : {}),
        executionProtocol: record.executionProtocol,
        reviewMode: record.reviewMode,
        inheritsParentConstraints: Boolean(record.parentAgentId),
        communicationLane: record.communicationLane,
      };
      if (record.orchestrationGraphId && record.orchestrationNodeId) {
        if (!this.orchestrationGraphs.has(record.orchestrationGraphId)) {
          this.orchestrationGraphs.add(record.orchestrationGraphId);
          emitOrchestrationGraphCreated(this.runtimeBus, {
            sessionId: 'agent-manager',
            traceId: `agent-manager:${record.orchestrationGraphId}`,
            source: 'agent-manager',
          }, {
            graphId: record.orchestrationGraphId,
            title: `Cohort ${record.cohort}`,
            mode: 'parallel-workers',
          });
        }
        emitOrchestrationNodeAdded(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${record.orchestrationNodeId}`,
          source: 'agent-manager',
          agentId: id,
        }, {
          graphId: record.orchestrationGraphId,
          nodeId: record.orchestrationNodeId,
          title: task,
          role: template === 'reviewer'
            ? 'reviewer'
            : template === 'researcher'
              ? 'researcher'
              : template === 'engineer'
                ? 'engineer'
                : 'integrator',
          ...(record.parentNodeId !== undefined ? { parentNodeId: record.parentNodeId } : {}),
          agentId: id,
          contract,
        });
        emitOrchestrationNodeStarted(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${record.orchestrationNodeId}:start`,
          source: 'agent-manager',
          agentId: id,
        }, {
          graphId: record.orchestrationGraphId,
          nodeId: record.orchestrationNodeId,
          agentId: id,
        });
      }
    }
    if (record.task === 'Stuck task') {
      return record;
    }

    if (!input.dangerously_disable_wrfc) {
      try {
        this.wrfcController?.createChain(record);
      } catch (error) {
        logger.error('Failed to create WRFC chain', { agentId: id, error: summarizeError(error) });
      }
    }

    if (this.executor) {
      this.executor.runAgent(record).catch((error) => {
        record.status = 'failed';
        record.error = summarizeError(error, {
          ...(record.provider ? { provider: record.provider } : {}),
        });
        record.completedAt = Date.now();
      });
    } else {
      record.status = 'failed';
      record.error = 'Agent executor is not configured';
      record.completedAt = Date.now();
    }

    return record;
  }

  getStatus(id: string): AgentRecord | null {
    return this.agents.get(id) ?? null;
  }

  cancel(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status === 'pending' || record.status === 'running') {
      record.status = 'cancelled';
      record.completedAt = Date.now();
      if (this.runtimeBus && record.orchestrationGraphId && record.orchestrationNodeId) {
        emitOrchestrationNodeCancelled(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${record.id}:cancel`,
          source: 'agent-manager',
          agentId: record.id,
        }, {
          graphId: record.orchestrationGraphId,
          nodeId: record.orchestrationNodeId,
          reason: 'operator cancellation',
        });
      }
    }
    this.agents.set(id, record);
    return true;
  }

  listByGraph(graphId: string): AgentRecord[] {
    return this.list().filter((agent) => agent.orchestrationGraphId === graphId);
  }

  cancelSubtree(rootAgentId: string): string[] {
    const cancelled: string[] = [];
    const queue = [rootAgentId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (seen.has(currentId)) continue;
      seen.add(currentId);
      const record = this.agents.get(currentId);
      if (!record) continue;
      if (this.cancel(currentId)) cancelled.push(currentId);
      for (const child of this.agents.values()) {
        if (child.parentAgentId === currentId) queue.push(child.id);
      }
    }
    return cancelled;
  }

  cancelGraph(graphId: string): string[] {
    const cancelled: string[] = [];
    for (const agent of this.listByGraph(graphId)) {
      if (this.cancel(agent.id)) cancelled.push(agent.id);
    }
    return cancelled;
  }

  list(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  listByCohort(cohort: string): AgentRecord[] {
    return [...this.agents.values()].filter((agent) => agent.cohort === cohort);
  }

  clear(): void {
    this.agents.clear();
    this.orchestrationGraphs.clear();
  }

  exportState(): AgentRecord[] {
    return [...this.agents.values()].map((agent) => {
      const { streamingContent, fullOutput, ...rest } = agent;
      return {
        ...rest,
        status: (agent.status === 'running' || agent.status === 'pending') ? 'failed' : agent.status,
      };
    });
  }

  importState(records: AgentRecord[]): void {
    for (const record of records) {
      if (record.status === 'running' || record.status === 'pending') continue;
      this.agents.set(record.id, record);
    }
  }

  setExecutor(executor: AgentExecutor | null): void {
    this.executor = executor;
  }

  setWrfcController(wrfcController: Pick<WrfcController, 'createChain'> | null): void {
    this.wrfcController = wrfcController;
  }
}
