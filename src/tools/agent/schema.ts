import type { ToolDefinition } from '../../types/tools.ts';

/**
 * JSON Schema for the agent tool's input.
 * Manages in-process subagents: spawn, status, cancel, list, templates.
 */
export const AGENT_TOOL_SCHEMA: ToolDefinition = {
  name: 'agent',
  description:
    'Manages in-process subagents. Modes: spawn (create a new agent task), ' +
    'batch-spawn (spawn multiple agents at once from a tasks array), ' +
    'status (check agent progress by ID), cancel (stop a running agent), ' +
    'list (show all agents and their status), ' +
    'templates (list available agent templates with default tool sets), ' +
    'get (detailed agent info including messages), ' +
    'budget (token usage for an agent), ' +
    'plan (execution plan: task + template + tools), ' +
    'wait (returns current status immediately if terminal, or polls up to timeoutMs capped at 5000ms; always non-blocking for the main conversation), ' +
    'message (send a message to an agent), ' +
    'wrfc-chains (list all WRFC chains in current session with status/scores), ' +
    'wrfc-history (detailed event history for a specific WRFC chain — reviews, scores, issues, gates), ' +
    'cohort-status (JSON summary of all agents in a named cohort), ' +
    'cohort-report (markdown table report for all agents in a named cohort).' +
    ' Discovery: use mode=list to see all agents and their status, mode=templates to see available agent templates.',
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['spawn', 'batch-spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'wrfc-chains', 'wrfc-history', 'cohort-status', 'cohort-report'],
        description: 'Operation mode.',
      },
      // mode: spawn
      task: {
        type: 'string',
        description: 'Task description for the agent to execute (mode: spawn).',
      },
      template: {
        type: 'string',
        enum: ['engineer', 'reviewer', 'tester', 'researcher', 'general'],
        description:
          'Agent template to use (mode: spawn). Default: general. ' +
          'Each template includes a pre-selected tool set.',
      },
      model: {
        type: 'string',
        description: 'Model override for the spawned agent (mode: spawn).',
      },
      provider: {
        type: 'string',
        description: 'Provider override for the spawned agent (mode: spawn).',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Explicit tool subset for the agent (mode: spawn). ' +
          'Defaults to template defaults. The "agent" tool is never included.',
      },
      context: {
        type: 'string',
        description: 'Additional context to provide to the spawned agent (mode: spawn).',
      },
      dangerously_disable_wrfc: {
        type: 'boolean',
        description: 'If true, skip the WRFC review chain for this agent (mode: spawn). Default: false.',
        default: false,
      },
      // mode: batch-spawn
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string', description: 'Task description for the agent.' },
            template: { type: 'string', enum: ['engineer', 'reviewer', 'tester', 'researcher', 'general'], description: 'Agent template.' },
            model: { type: 'string', description: 'Model override.' },
            provider: { type: 'string', description: 'Provider override.' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Tool subset.' },
            context: { type: 'string', description: 'Additional context.' },
            dangerously_disable_wrfc: { type: 'boolean', description: 'Skip WRFC review.' },
          },
        },
        description: 'Array of tasks to spawn as agents (mode: batch-spawn). Max 20.',
      },
      // mode: spawn, batch-spawn, list, cohort-status, cohort-report
      cohort: {
        type: 'string',
        description: 'Cohort name to group agents together (mode: spawn, batch-spawn). Filter by cohort (mode: list, cohort-status, cohort-report).',
      },
      // mode: status / cancel / get / budget / plan / wait / message
      agentId: {
        type: 'string',
        description: 'Agent ID to query, cancel, get, budget, plan, wait, or message (mode: status, cancel, get, budget, plan, wait, message).',
      },
      // mode: wait
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds for the wait action (mode: wait). Default: 0 (non-blocking, returns immediately). Max: 5000ms. If agent is still running, returns current status with a hint to poll again via mode=status.',
      },
      // mode: message
      message: {
        type: 'string',
        description: 'Message content to send to an agent (mode: message).',
      },
      // mode: wrfc-history
      wrfcId: {
        type: 'string',
        description: 'WRFC chain ID for wrfc-history mode.',
      },
    },
  },
};

/** Input shape for the agent tool. */
export interface AgentInput {
  mode: 'spawn' | 'batch-spawn' | 'status' | 'cancel' | 'list' | 'templates' | 'get' | 'budget' | 'plan' | 'wait' | 'message' | 'wrfc-chains' | 'wrfc-history' | 'cohort-status' | 'cohort-report';
  // spawn
  task?: string;
  template?: string;
  model?: string;
  provider?: string;
  tools?: string[];
  context?: string;
  dangerously_disable_wrfc?: boolean;
  // cohort grouping
  cohort?: string;
  // batch-spawn
  tasks?: Array<{
    task: string;
    template?: string;
    model?: string;
    provider?: string;
    tools?: string[];
    context?: string;
    dangerously_disable_wrfc?: boolean;
  }>;
  // status / cancel / get / budget / plan / wait / message
  agentId?: string;
  // wait
  timeoutMs?: number;
  // message
  message?: string;
  // wrfc-history
  wrfcId?: string;
}
