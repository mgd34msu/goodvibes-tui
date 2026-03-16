import type { Tool } from '../../types/tools.ts';
import { AGENT_TOOL_SCHEMA } from './schema.ts';
import type { AgentInput } from './schema.ts';

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
    const template = input.template ?? 'general';
    const templateDef = AGENT_TEMPLATES[template] ?? AGENT_TEMPLATES.general;
    const tools = input.tools ?? [...templateDef.defaultTools];

    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const record: AgentRecord = {
      id,
      task: input.task!,
      template,
      model: input.model,
      provider: input.provider,
      tools,
      status: 'pending',
      startedAt: Date.now(),
      toolCallCount: 0,
    };

    this.agents.set(id, record);
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
    const input = args as AgentInput;

    if (!input.mode) {
      return { success: false, error: 'Missing required parameter: mode' };
    }

    const validModes = ['spawn', 'status', 'cancel', 'list', 'templates'];
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
          return {
            success: false,
            error: `Unknown template: '${input.template}'. Available: ${Object.keys(AGENT_TEMPLATES).join(', ')}`,
          };
        }

        const record = manager.spawn(input);

        // NOTE: Actual background execution will be wired when the TUI's orchestrator is extended.
        // For now, the agent is created in 'pending' status.
        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            status: 'spawned',
            task: record.task,
            template: record.template,
            tools: record.tools,
            note: 'Agent registered. Background execution will be wired in a future phase.',
          }),
        };
      }

      case 'status': {
        if (!input.agentId) {
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
        if (!input.agentId) {
          return { success: false, error: 'Missing required parameter for cancel: agentId' };
        }

        const cancelled = manager.cancel(input.agentId);
        if (!cancelled) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        return {
          success: true,
          output: JSON.stringify({ agentId: input.agentId, status: 'cancelled' }),
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

      default: {
        return { success: false, error: `Unhandled mode: '${input.mode}'` };
      }
    }
  },
};
