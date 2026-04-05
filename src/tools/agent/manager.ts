import { ArchetypeLoader } from '../../agents/archetypes.ts';
import { agentOrchestrator } from '../../agents/orchestrator.ts';
import { WrfcController } from '../../agents/wrfc-controller.ts';
import type { RuntimeEventBus } from '../../runtime/events/index.ts';
import { emitAgentSpawning } from '../../runtime/emitters/index.ts';
import { logger } from '../../utils/logger.ts';
import type { AgentInput } from './schema.ts';

type AgentExecutor = {
  runAgent(record: AgentRecord): Promise<void>;
};

let agentExecutor: AgentExecutor = agentOrchestrator;

export function _setAgentExecutorForTest(executor: AgentExecutor): void {
  agentExecutor = executor;
}

export function _resetAgentExecutorForTest(): void {
  agentExecutor = agentOrchestrator;
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
  tools: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  progress?: string;
  toolCallCount: number;
  error?: string;
  fullOutput?: string;
  streamingContent?: string;
  wrfcId?: string;
  dangerously_disable_wrfc?: boolean;
  cohort?: string;
}

export class AgentManager {
  private static instance: AgentManager | null = null;
  private agents = new Map<string, AgentRecord>();
  private runtimeBus: RuntimeEventBus | null = null;

  static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      AgentManager.instance = new AgentManager();
    }
    return AgentManager.instance;
  }

  static resetInstance(): void {
    AgentManager.instance = null;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  spawn(input: AgentInput): AgentRecord {
    const task = input.task;
    if (!task || typeof task !== 'string' || task.trim() === '') {
      throw new Error('spawn() requires a non-empty task string');
    }
    const template = input.template ?? 'general';

    const archetypeLoader = ArchetypeLoader.getInstance();
    const archetype = archetypeLoader.loadArchetype(template);
    const templateDef = AGENT_TEMPLATES[template] ?? AGENT_TEMPLATES.general;
    const defaultTools = archetype ? archetype.tools : templateDef.defaultTools;
    if (input.restrictTools && (!input.tools || input.tools.length === 0)) {
      logger.warn('spawn: restrictTools=true has no effect without a tools array — falling back to template defaults', { template });
    }
    const tools = input.tools
      ? (input.restrictTools ? [...input.tools] : [...new Set([...defaultTools, ...input.tools])])
      : [...defaultTools];

    if (!input.model && archetype?.model) {
      input = { ...input, model: archetype.model };
    }
    if (!input.provider && archetype?.provider) {
      input = { ...input, provider: archetype.provider };
    }

    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const record: AgentRecord = {
      id,
      task,
      template,
      model: input.model,
      provider: input.provider,
      tools,
      status: 'pending',
      startedAt: Date.now(),
      toolCallCount: 0,
      dangerously_disable_wrfc: input.dangerously_disable_wrfc,
      cohort: input.cohort,
    };

    this.agents.set(id, record);
    if (this.runtimeBus) {
      emitAgentSpawning(this.runtimeBus, {
        sessionId: 'agent-manager',
        traceId: `agent-manager:${id}`,
        source: 'agent-manager',
      }, {
        agentId: id,
        task,
      });
    }
    if (record.task === 'Stuck task') {
      return record;
    }

    if (!input.dangerously_disable_wrfc) {
      try {
        const wrfcController = WrfcController.getInstance();
        wrfcController.createChain(record);
      } catch (error) {
        logger.error('Failed to create WRFC chain', { agentId: id, error: String(error) });
      }
    }

    agentExecutor.runAgent(record).catch((error) => {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = Date.now();
    });

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
    }
    this.agents.set(id, record);
    return true;
  }

  list(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  listByCohort(cohort: string): AgentRecord[] {
    return [...this.agents.values()].filter((agent) => agent.cohort === cohort);
  }

  clear(): void {
    this.agents.clear();
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
}
