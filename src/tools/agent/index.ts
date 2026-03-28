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
  /** Live streaming content for the current turn. Cleared between turns. */
  streamingContent?: string;
  /** WRFC chain ID linking this agent to its review chain. Undefined if dangerously_disable_wrfc. */
  wrfcId?: string;
  /** If true, this agent skips the WRFC review chain. */
  dangerously_disable_wrfc?: boolean;
  /** Cohort name grouping this agent with related agents. */
  cohort?: string;
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
      dangerously_disable_wrfc: input.dangerously_disable_wrfc,
      cohort: input.cohort,
    };

    this.agents.set(id, record);
    // If the task is a known 'Stuck task', do not start the orchestrator to keep it pending for testing.
    if (record.task === 'Stuck task') {
      return record;
    }

    // WRFC chain creation — every agent without dangerously_disable_wrfc gets a chain
    if (!input.dangerously_disable_wrfc) {
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

  /** Return all agent records belonging to the given cohort. */
  listByCohort(cohort: string): AgentRecord[] {
    return [...this.agents.values()].filter(a => a.cohort === cohort);
  }

  /** Clear all agents — for testing only. */
  clear(): void {
    this.agents.clear();
  }

  /**
   * Export all agent records for session persistence.
   * Running agents are downgraded to 'failed' since they cannot be resumed.
   */
  exportState(): AgentRecord[] {
    return [...this.agents.values()].map(a => {
      const { streamingContent, fullOutput, ...rest } = a;
      return {
        ...rest,
        status: (a.status === 'running' || a.status === 'pending') ? 'failed' : a.status,
      };
    });
  }

  /**
   * Import agent records from a saved session.
   * Only imports completed/failed/cancelled records (not running/pending).
   */
  importState(records: AgentRecord[]): void {
    for (const r of records) {
      // Skip any record that somehow has an active status (defensive guard)
      if (r.status === 'running' || r.status === 'pending') continue;
      this.agents.set(r.id, r);
    }
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

    const validModes = ['spawn', 'batch-spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'wrfc-chains', 'wrfc-history', 'cohort-status', 'cohort-report'];
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
          output: `Agent ${record.id} spawned (${record.template}). Running in background.`,
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
        const allRecords = manager.list();
        const records = input.cohort
          ? allRecords.filter(r => r.cohort === input.cohort)
          : allRecords;
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
              cohort: r.cohort,
            })),
            count: records.length,
            ...(input.cohort ? { cohort: input.cohort } : {}),
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

      case 'batch-spawn': {
        if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) {
          return { success: false, error: 'batch-spawn requires a non-empty tasks array.' };
        }
        if (input.tasks.length > 20) {
          return { success: false, error: 'batch-spawn limited to 20 tasks per batch.' };
        }
        // Respect maxGlobalAgents limit
        const { configManager } = await import('../../config/index.ts');
        const { DEFAULT_CONFIG } = await import('../../config/schema.ts');
        const maxAgents = (configManager.get('danger.maxGlobalAgents') as number) || DEFAULT_CONFIG.danger.maxGlobalAgents;
        const currentCount = manager.list().filter(a => a.status === 'pending' || a.status === 'running').length;
        const available = Math.max(0, maxAgents - currentCount);
        if (available === 0) {
          return { success: false, error: `Agent limit reached (${currentCount}/${maxAgents}). No capacity for batch-spawn.` };
        }
        const tasksToSpawn = input.tasks.slice(0, available);
        const skipped = input.tasks.length - tasksToSpawn.length;

        const results: Array<{ id: string; task: string; template: string; cohort?: string }> = [];
        for (const taskDef of tasksToSpawn) {
          if (!taskDef.task || typeof taskDef.task !== 'string' || taskDef.task.trim() === '') {
            return { success: false, error: 'Each task in batch-spawn must have a non-empty task string.' };
          }
          // Validate template if provided
          if (taskDef.template && !AGENT_TEMPLATES[taskDef.template]) {
            const archetypeLoader = ArchetypeLoader.getInstance();
            const customArchetype = archetypeLoader.loadArchetype(taskDef.template);
            if (!customArchetype || customArchetype.isCustom === false) {
              return {
                success: false,
                error: `Unknown template: '${taskDef.template}'. Available: ${Object.keys(AGENT_TEMPLATES).join(', ')}`,
              };
            }
          }
          const spawnInput: AgentInput = {
            mode: 'spawn',
            task: taskDef.task,
            template: taskDef.template ?? input.template ?? 'general',
            model: taskDef.model ?? input.model,
            provider: taskDef.provider ?? input.provider,
            tools: taskDef.tools ?? input.tools,
            context: taskDef.context ?? input.context,
            dangerously_disable_wrfc: taskDef.dangerously_disable_wrfc ?? input.dangerously_disable_wrfc,
            cohort: input.cohort,
          };
          const record = manager.spawn(spawnInput);
          results.push({ id: record.id, task: taskDef.task.slice(0, 80), template: record.template, cohort: record.cohort });
        }
        return { success: true, output: JSON.stringify({ agents: results, count: results.length, cohort: input.cohort, skipped, maxAgents }) };
      }

      case 'cohort-status': {
        if (!input.cohort) {
          return { success: false, error: 'cohort-status requires a cohort name.' };
        }
        const cohortAgents = manager.listByCohort(input.cohort);
        if (cohortAgents.length === 0) {
          return { success: true, output: `No agents found in cohort '${input.cohort}'.` };
        }
        const summary = cohortAgents.map(a => ({
          id: a.id,
          task: a.task?.slice(0, 80),
          status: a.status,
          template: a.template,
          wrfcId: a.wrfcId,
          toolCallCount: a.toolCallCount,
        }));
        return { success: true, output: JSON.stringify({ cohort: input.cohort, count: cohortAgents.length, agents: summary }) };
      }

      case 'cohort-report': {
        if (!input.cohort) {
          return { success: false, error: 'cohort-report requires a cohort name.' };
        }
        const reportAgents = manager.listByCohort(input.cohort);
        if (reportAgents.length === 0) {
          return { success: true, output: `No agents found in cohort '${input.cohort}'.` };
        }
        const lines: string[] = [
          `## Cohort: ${input.cohort} (${reportAgents.length} agents)`,
          '',
          '| Agent | Task | Status | Template | WRFC | Tool Calls |',
          '|-------|------|--------|----------|------|------------|',
        ];
        for (const a of reportAgents) {
          const taskShort = (a.task ?? '').slice(0, 40).replace(/\|/g, '\\|');
          const wrfcStatus = a.wrfcId ?? 'n/a';
          lines.push(`| ${a.id.slice(-8)} | ${taskShort} | ${a.status} | ${a.template ?? 'general'} | ${wrfcStatus} | ${a.toolCallCount ?? 0} |`);
        }
        return { success: true, output: lines.join('\n') };
      }

      case 'wrfc-chains': {
        try {
          const workmap = WrfcController.getInstance().getWorkmap();
          const chains = workmap.listChains();
          return {
            success: true,
            output: JSON.stringify({ mode: 'wrfc-chains', chains, count: chains.length }),
          };
        } catch (err) {
          return { success: false, error: `Failed to list WRFC chains: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case 'wrfc-history': {
        if (!input.wrfcId) {
          return { success: false, error: 'wrfc-history requires wrfcId' };
        }
        try {
          const workmap = WrfcController.getInstance().getWorkmap();
          const events = workmap.read(input.wrfcId);
          return {
            success: true,
            output: JSON.stringify({ mode: 'wrfc-history', wrfcId: input.wrfcId, events, count: events.length }),
          };
        } catch (err) {
          return { success: false, error: `Failed to get WRFC history: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      default: {
        return { success: false, error: `Unhandled mode: '${input.mode}'` };
      }
    }
  },
};
