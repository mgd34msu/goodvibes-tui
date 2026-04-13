import type { ToolDefinition } from '../../types/tools.ts';
import type { ExecutionIntent } from '../../runtime/execution-intents.ts';

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
  sideEffects: ['agent', 'workflow', 'state'],
  concurrency: 'serial',
  supportsProgress: true,
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
      fallbackModels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered fallback model IDs or registry keys to try if the primary model fails (mode: spawn).',
      },
      executionIntent: {
        type: 'object',
        properties: {
          riskClass: {
            type: 'string',
            enum: ['safe', 'elevated', 'dangerous'],
            description: 'Execution risk classification hint for downstream policy/evaluation surfaces.',
          },
          requiresApproval: {
            type: 'boolean',
            description: 'Whether the spawned agent should be treated as requiring approval-sensitive execution.',
          },
          networkPolicy: {
            type: 'string',
            enum: ['inherit', 'allow', 'deny', 'scoped'],
            description: 'Requested network posture for downstream execution surfaces.',
          },
          filesystemPolicy: {
            type: 'string',
            enum: ['inherit', 'workspace-write', 'read-only', 'isolated'],
            description: 'Requested filesystem posture for downstream execution surfaces.',
          },
        },
        additionalProperties: false,
        description: 'Explicit execution-intent hints for policy-aware runtimes (mode: spawn).',
      },
      reasoningEffort: {
        type: 'string',
        enum: ['instant', 'low', 'medium', 'high'],
        description: 'Reasoning effort override for providers/models that support it (mode: spawn).',
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
      successCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete success criteria the spawned agent must satisfy (mode: spawn).',
      },
      requiredEvidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence the spawned agent must return before completion (mode: spawn).',
      },
      writeScope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Expected file or path scope for writes owned by the spawned agent (mode: spawn).',
      },
      executionProtocol: {
        type: 'string',
        enum: ['direct', 'gather-plan-apply'],
        description: 'Execution discipline the spawned agent should follow (mode: spawn). Default: gather-plan-apply.',
      },
      reviewMode: {
        type: 'string',
        enum: ['none', 'wrfc'],
        description: 'Review loop requirement for the spawned agent (mode: spawn). Default: wrfc unless explicitly disabled.',
      },
      communicationLane: {
        type: 'string',
        enum: ['parent-only', 'parent-and-children', 'cohort', 'direct'],
        description: 'Permitted communication lane for the spawned agent (mode: spawn). Default: parent-only for children, direct for root workers.',
      },
      parentAgentId: {
        type: 'string',
        description: 'Parent agent whose capability ceiling and communication lane this worker inherits (mode: spawn).',
      },
      orchestrationGraphId: {
        type: 'string',
        description: 'Explicit orchestration graph id to attach the spawned worker to (mode: spawn).',
      },
      orchestrationNodeId: {
        type: 'string',
        description: 'Explicit orchestration node id for the spawned worker (mode: spawn).',
      },
      parentNodeId: {
        type: 'string',
        description: 'Parent orchestration node id for the spawned worker (mode: spawn).',
      },
      restrictTools: {
        type: 'boolean',
        description:
          'If true, use ONLY the specified tools (override mode). ' +
          'If false or omitted, specified tools are merged with template defaults (additive mode). ' +
          'Only applies when tools is also provided (mode: spawn).',
        default: false,
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
            fallbackModels: { type: 'array', items: { type: 'string' }, description: 'Ordered fallback model IDs or registry keys.' },
            executionIntent: {
              type: 'object',
              properties: {
                riskClass: { type: 'string', enum: ['safe', 'elevated', 'dangerous'], description: 'Execution risk classification hint.' },
                requiresApproval: { type: 'boolean', description: 'Whether approval-sensitive execution is required.' },
                networkPolicy: { type: 'string', enum: ['inherit', 'allow', 'deny', 'scoped'], description: 'Requested network posture.' },
                filesystemPolicy: { type: 'string', enum: ['inherit', 'workspace-write', 'read-only', 'isolated'], description: 'Requested filesystem posture.' },
              },
              additionalProperties: false,
              description: 'Explicit execution-intent hints for downstream runtimes.',
            },
            reasoningEffort: { type: 'string', enum: ['instant', 'low', 'medium', 'high'], description: 'Reasoning effort override.' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Tool subset.' },
            restrictTools: { type: 'boolean', description: 'If true, use ONLY the specified tools (override mode). Default: false.' },
            context: { type: 'string', description: 'Additional context.' },
            successCriteria: { type: 'array', items: { type: 'string' }, description: 'Concrete success criteria.' },
            requiredEvidence: { type: 'array', items: { type: 'string' }, description: 'Evidence the spawned agent must return.' },
            writeScope: { type: 'array', items: { type: 'string' }, description: 'Expected write ownership scope.' },
            executionProtocol: { type: 'string', enum: ['direct', 'gather-plan-apply'], description: 'Execution discipline.' },
            reviewMode: { type: 'string', enum: ['none', 'wrfc'], description: 'Review loop requirement.' },
            communicationLane: { type: 'string', enum: ['parent-only', 'parent-and-children', 'cohort', 'direct'], description: 'Permitted communication lane.' },
            parentAgentId: { type: 'string', description: 'Parent agent to inherit capability ceiling from.' },
            orchestrationGraphId: { type: 'string', description: 'Graph id to attach the worker to.' },
            orchestrationNodeId: { type: 'string', description: 'Explicit node id for the worker.' },
            parentNodeId: { type: 'string', description: 'Parent node id for the worker.' },
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
      detail: {
        type: 'string',
        enum: ['summary', 'contract', 'messages', 'full'],
        description: 'Detail level for inspection/reporting modes. Summary keeps the core execution state; contract adds capability/ownership data; messages adds recent bus traffic; full returns everything.',
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
      kind: {
        type: 'string',
        enum: ['directive', 'status', 'question', 'finding', 'review', 'handoff', 'escalation', 'completion'],
        description: 'Structured communication kind for the message (mode: message). Default: directive.',
      },
      // mode: wrfc-history
      wrfcId: {
        type: 'string',
        description: 'WRFC chain ID for wrfc-history mode.',
      },
    },
  },
};

export interface AgentProviderRoutingPolicy {
  providerSelection?: 'inherit-current' | 'concrete' | 'synthetic';
  unresolvedModelPolicy?: 'fallback-to-current' | 'fail';
  providerFailurePolicy?: 'ordered-fallbacks' | 'fail';
  fallbackModels?: readonly string[];
}

/** Input shape for the agent tool. */
export interface AgentInput {
  mode: 'spawn' | 'batch-spawn' | 'status' | 'cancel' | 'list' | 'templates' | 'get' | 'budget' | 'plan' | 'wait' | 'message' | 'wrfc-chains' | 'wrfc-history' | 'cohort-status' | 'cohort-report';
  // spawn
  task?: string;
  template?: string;
  model?: string;
  provider?: string;
  fallbackModels?: string[];
  routing?: AgentProviderRoutingPolicy;
  executionIntent?: ExecutionIntent;
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
  tools?: string[];
  restrictTools?: boolean;
  context?: string;
  successCriteria?: string[];
  requiredEvidence?: string[];
  writeScope?: string[];
  executionProtocol?: 'direct' | 'gather-plan-apply';
  reviewMode?: 'none' | 'wrfc';
  communicationLane?: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct';
  parentAgentId?: string;
  orchestrationGraphId?: string;
  orchestrationNodeId?: string;
  parentNodeId?: string;
  dangerously_disable_wrfc?: boolean;
  // cohort grouping
  cohort?: string;
  // batch-spawn
  tasks?: Array<{
    task: string;
    template?: string;
    model?: string;
    provider?: string;
    fallbackModels?: string[];
    routing?: AgentProviderRoutingPolicy;
    executionIntent?: ExecutionIntent;
    reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
    tools?: string[];
    restrictTools?: boolean;
    context?: string;
    successCriteria?: string[];
    requiredEvidence?: string[];
    writeScope?: string[];
    executionProtocol?: 'direct' | 'gather-plan-apply';
    reviewMode?: 'none' | 'wrfc';
    communicationLane?: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct';
    parentAgentId?: string;
    orchestrationGraphId?: string;
    orchestrationNodeId?: string;
    parentNodeId?: string;
    dangerously_disable_wrfc?: boolean;
  }>;
  // status / cancel / get / budget / plan / wait / message
  agentId?: string;
  detail?: 'summary' | 'contract' | 'messages' | 'full';
  // wait
  timeoutMs?: number;
  // message
  message?: string;
  kind?: 'directive' | 'status' | 'question' | 'finding' | 'review' | 'handoff' | 'escalation' | 'completion';
  // wrfc-history
  wrfcId?: string;
}
