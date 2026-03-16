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
    'templates (list available agent templates with default tool sets).',
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['spawn', 'status', 'cancel', 'list', 'templates'],
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
      // mode: status / cancel
      agentId: {
        type: 'string',
        description: 'Agent ID to query or cancel (mode: status, cancel).',
      },
    },
  },
};

/** Input shape for the agent tool. */
export interface AgentInput {
  mode: 'spawn' | 'status' | 'cancel' | 'list' | 'templates';
  // spawn
  task?: string;
  template?: string;
  model?: string;
  provider?: string;
  tools?: string[];
  context?: string;
  // status / cancel
  agentId?: string;
}
