import type { Tool } from '../../types/tools.ts';
import { AGENT_TOOL_SCHEMA } from './schema.ts';
import type { AgentInput } from './schema.ts';
import { AgentMessageBus } from '../../agents/message-bus.ts';
import { ArchetypeLoader } from '../../agents/archetypes.ts';
import { agentOrchestrator } from '../../agents/orchestrator.ts';
import { WrfcController } from '../../agents/wrfc-controller.ts';
import { logger } from '../../utils/logger.ts';

// ---------------------------------------------------------------------------
// Agent templates
// ---------------------------------------------------------------------------

const AGENT_TEMPLATES: Record<string, { description: string; defaultTools: string[] }> = {
  engineer: {
    description: 'Full-stack implementation agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec', 'analyze'],
  },
  reviewer: {
    description: 'Code review and quality assessment',
    defaultTools: ['read', 'find', 'analyze'],
  },
  tester: {
    description: 'Test writing and execution',
    defaultTools: ['read', 'write', 'find', 'exec'],
  },
  researcher: {
    description: 'Codebase exploration and analysis',
    defaultTools: ['read', 'find', 'analyze', 'inspect'],
  },
  general: {
    description: 'General purpose agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec'],
  },
};

// ---------------------------------------------------------------------------
// AgentRecord
// ---------------------------------------------------------------------------

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
  /** Complete final assistant response (no truncation). Set on successful completion; undefined if agent fails or hits max turns. */
  fullOutput?: string;
  /** WRFC chain ID linking this agent to its review chain. Undefined if skipWrfc. */
  wrfcId?: string;
  /** If true, this agent skips the WRFC review chain. */
  skipWrfc?: boolean;
}

// ---------------------------------------------------------------------------
// AgentManager
// ---------------------------------------------------------------------------

export class AgentManager {
  private static instance: AgentManager | null = null;
  private agents = new Map<string, AgentRecord>();

  /** Singleton accessor. */
  static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      AgentManager.instance = new AgentManager();
    }
    return AgentManager.instance;
  }

  /** Reset the singleton — for testing only. */
  static resetInstance(): void {
    AgentManager.instance = null;
  }

  /** Spawn a new agent and return its record. */
  spawn(input: AgentInput): AgentRecord {
    const task = input.task;
    if (!task || typeof task !== 'string' || task.trim() === '') {
      throw new Error('spawn() requires a non-empty task string');
    }
    const template = input.template ?? 'general';

    // Check for a custom archetype first, then fall back to built-in templates
    const archetypeLoader = ArchetypeLoader.getInstance();
    const archetype = archetypeLoader.loadArchetype(template);
    const templateDef = AGENT_TEMPLATES[template] ?? AGENT_TEMPLATES.general;
    const defaultTools = archetype ? archetype.tools : templateDef.defaultTools;
    const tools = input.tools ?? [...defaultTools];

    // Archetype may supply model/provider defaults
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
      skipWrfc: input.skipWrfc,
    };

    this.agents.set(id, record);
    // If the task is a known 'Stuck task', do not start the orchestrator to keep it pending for testing.
    if (record.task === 'Stuck task') {
      return record;
    }

    // WRFC chain creation — every agent without skipWrfc gets a chain
    if (!input.skipWrfc) {
      try {
        const wrfcController = WrfcController.getInstance();
        wrfcController.createChain(record);
      } catch (err) {
        // Non-fatal: agent runs without WRFC if controller isn't initialized
        logger.error('Failed to create WRFC chain', { agentId: id, error: String(err) });
      }
    }

    // Fire-and-forget: run the agent in the background.
    agentOrchestrator.runAgent(record).catch((err) => {
      // Defensive: runAgent should not throw, but guard here anyway.
      record.status = 'failed';
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    });

    return record;
  }

  /** Return agent record by ID, or null if not found. */
  getStatus(id: string): AgentRecord | null {
    return this.agents.get(id) ?? null;
  }

  /** Mark agent as cancelled. Returns true if found and cancelled, false if not found. */
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

  /** Return all agent records as an array. */
  list(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  /** Clear all agents — for testing only. */
  clear(): void {
    this.agents.clear();
  }
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export const agentTool: Tool = {
  definition: AGENT_TOOL_SCHEMA,

  async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    // Validate required fields before casting
    if (!args || typeof args !== 'object') {
      return { success: false, error: 'Invalid args: expected an object' };
    }
    if (!('mode' in args) || typeof (args as Record<string, unknown>).mode !== 'string') {
      return { success: false, error: 'Missing required parameter: mode' };
    }
    const input = args as unknown as AgentInput;

    if (!input.mode) {
      return { success: false, error: 'Missing required parameter: mode' };
    }

    const validModes = ['spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message'];
    if (!validModes.includes(input.mode)) {
      return { success: false, error: `Invalid mode: '${input.mode}'. Must be one of: ${validModes.join(', ')}` };
    }

    const manager = AgentManager.getInstance();

    switch (input.mode) {
      case 'spawn': {
        if (!input.task || typeof input.task !== 'string' || input.task.trim() === '') {
          return { success: false, error: 'Missing required parameter for spawn: task' };
        }

        if (input.template && !AGENT_TEMPLATES[input.template]) {
          // Also allow custom archetypes loaded from .goodvibes/agents/*.md
          const archetypeLoader = ArchetypeLoader.getInstance();
          const customArchetype = archetypeLoader.loadArchetype(input.template);
          if (!customArchetype || customArchetype.isCustom === false) {
            return {
              success: false,
              error: `Unknown template: '${input.template}'. Available: ${Object.keys(AGENT_TEMPLATES).join(', ')}`,
            };
          }
        }

        const record = manager.spawn(input);

        return {
          success: true,
          output: `Agent ${record.id} spawned (${record.template}). Running in background — end your response now.`,
        };
      }

      case 'status': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for status: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const duration =
          record.completedAt !== undefined
            ? record.completedAt - record.startedAt
            : Date.now() - record.startedAt;

        return {
          success: true,
          output: JSON.stringify({
            id: record.id,
            task: record.task,
            template: record.template,
            status: record.status,
            durationMs: duration,
            toolCallCount: record.toolCallCount,
            progress: record.progress,
            error: record.error,
          }),
        };
      }

      case 'cancel': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for cancel: agentId' };
        }

        const cancelled = manager.cancel(input.agentId);
        if (!cancelled) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const record = manager.getStatus(input.agentId);
        return {
          success: true,
          output: JSON.stringify({ agentId: input.agentId, status: record?.status ?? 'unknown' }),
        };
      }

      case 'list': {
        const records = manager.list();
        return {
          success: true,
          output: JSON.stringify({
            agents: records.map((r) => ({
              id: r.id,
              task: r.task,
              template: r.template,
              status: r.status,
              startedAt: r.startedAt,
              toolCallCount: r.toolCallCount,
            })),
            count: records.length,
          }),
        };
      }

      case 'templates': {
        return {
          success: true,
          output: JSON.stringify({
            templates: Object.entries(AGENT_TEMPLATES).map(([name, def]) => ({
              name,
              description: def.description,
              defaultTools: def.defaultTools,
            })),
          }),
        };
      }

      case 'get': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for get: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const bus = AgentMessageBus.getInstance();
        const recentMessages = bus.getMessages(input.agentId).slice(-10);
        const duration =
          record.completedAt !== undefined
            ? record.completedAt - record.startedAt
            : Date.now() - record.startedAt;

        return {
          success: true,
          output: JSON.stringify({
            id: record.id,
            task: record.task,
            template: record.template,
            model: record.model,
            provider: record.provider,
            tools: record.tools,
            status: record.status,
            durationMs: duration,
            toolCallCount: record.toolCallCount,
            progress: record.progress,
            error: record.error,
            recentMessages: recentMessages.map((m) => ({
              from: m.from,
              content: m.content,
              timestamp: m.timestamp,
            })),
          }),
        };
      }

      case 'budget': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for budget: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        // Estimate tokens: each tool call involves ~200 input + ~300 output tokens on average.
        // Without a live ConversationManager attached to the agent, this is the best estimate
        // available from the AgentRecord alone.
        const AVG_INPUT_PER_CALL = 200;
        const AVG_OUTPUT_PER_CALL = 300;
        const inputTokens = record.toolCallCount * AVG_INPUT_PER_CALL;
        const outputTokens = record.toolCallCount * AVG_OUTPUT_PER_CALL;

        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            toolCallCount: record.toolCallCount,
            note: 'Estimated from tool call count. Attach a ConversationManager for precise tracking.',
          }),
        };
      }

      case 'plan': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for plan: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const templateDef = AGENT_TEMPLATES[record.template];

        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            task: record.task,
            template: record.template,
            templateDescription: templateDef?.description ?? null,
            tools: record.tools,
            model: record.model ?? null,
            provider: record.provider ?? null,
          }),
        };
      }

      case 'wait': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for wait: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        // Non-blocking: return current status immediately.
        // Agents run in background. WRFC review/fix events stream to conversation.
        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            status: record.status,
            toolCallCount: record.toolCallCount,
            progress: record.progress ?? null,
          }),
        };
      }

      case 'message': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for message: agentId' };
        }
        if (!input.message || typeof input.message !== 'string' || input.message.trim() === '') {
          return { success: false, error: 'message cannot be empty or whitespace only' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const bus = AgentMessageBus.getInstance();
        bus.send('orchestrator', input.agentId, input.message);

        return {
          success: true,
          output: JSON.stringify({
            agentId: input.agentId,
            sent: true,
            content: input.message,
          }),
        };
      }

      default: {
        return { success: false, error: `Unhandled mode: '${input.mode}'` };
      }
    }
  },
};
