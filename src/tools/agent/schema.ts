import type { ToolDefinition } from '../../types/tools.ts';

/**
 * JSON Schema for the agent tool's input.
 * Manages in-process subagents: spawn, status, cancel, list, templates.
 */
export const AGENT_TOOL_SCHEMA: ToolDefinition = {
  name: 'agent',
  description:
    'Manages in-process subagents. Modes: spawn (create a new agent task), ' +
    'status (check agent progress by ID), cancel (stop a running agent), ' +
    'list (show all agents and their status), ' +
    'templates (list available agent templates with default tool sets), ' +
    'get (detailed agent info including messages), ' +
    'budget (token usage for an agent), ' +
    'plan (execution plan: task + template + tools), ' +
    'wait (returns current status — non-blocking), ' +
    'message (send a message to an agent), ' +
    'wrfc-chains (list all WRFC chains in current session with status/scores), ' +
    'wrfc-history (detailed event history for a specific WRFC chain — reviews, scores, issues, gates).' +
    ' Discovery: use mode=list to see all agents and their status, mode=templates to see available agent templates.',
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'wrfc-chains', 'wrfc-history'],
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
      // mode: status / cancel / get / budget / plan / wait / message
      agentId: {
        type: 'string',
        description: 'Agent ID to query, cancel, get, budget, plan, wait, or message (mode: status, cancel, get, budget, plan, wait, message).',
      },
      // mode: wait
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds for the wait action (mode: wait). Default: 30000.',
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
  mode: 'spawn' | 'status' | 'cancel' | 'list' | 'templates' | 'get' | 'budget' | 'plan' | 'wait' | 'message' | 'wrfc-chains' | 'wrfc-history';
  // spawn
  task?: string;
  template?: string;
  model?: string;
  provider?: string;
  tools?: string[];
  context?: string;
  dangerously_disable_wrfc?: boolean;
  // status / cancel / get / budget / plan / wait / message
  agentId?: string;
  // wait
  timeoutMs?: number;
  // message
  message?: string;
  // wrfc-history
  wrfcId?: string;
}
