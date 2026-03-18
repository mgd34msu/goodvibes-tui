import type { ToolDefinition } from '../../types/tools.ts';

/**
 * JSON Schema for the workflow tool's input.
 * Manages WRFC state machines, automation triggers, and scheduled tasks.
 */
export const workflowSchema: ToolDefinition = {
  name: 'workflow',
  description:
    'Internal automation plumbing — NOT for executing tasks or spawning agents. ' +
    'To run work, use the agent tool instead. ' +
    'This tool only manages: triggers (event-driven automations that fire shell commands on hook events), ' +
    'schedule (recurring background commands on intervals), ' +
    'and workflow state tracking (internal bookkeeping — does not execute anything). ' +
    'Modes: triggers (manage event-driven automations), schedule (manage recurring tasks), ' +
    'start/status/transition/cancel/list (state tracking only — no execution).',
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['start', 'status', 'transition', 'cancel', 'list', 'triggers', 'schedule'],
        description: 'Operation mode.',
      },
      // mode: start
      definition: {
        type: 'string',
        enum: ['wrfc', 'fix_loop', 'test_then_fix', 'review_only'],
        description: 'Workflow definition to instantiate (mode: start).',
      },
      task: {
        type: 'string',
        description: 'Task description for the workflow (mode: start).',
      },
      // mode: status / cancel
      workflowId: {
        type: 'string',
        description: 'Workflow instance ID (mode: status, transition, cancel).',
      },
      // mode: transition
      targetState: {
        type: 'string',
        description: 'State to transition to (mode: transition).',
      },
      // mode: triggers
      triggerAction: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'enable', 'disable'],
        description: 'Trigger management action (mode: triggers).',
      },
      triggerId: {
        type: 'string',
        description: 'Trigger ID for remove/enable/disable actions (mode: triggers).',
      },
      triggerDefinition: {
        type: 'object',
        description: 'Trigger definition for add action (mode: triggers).',
        required: ['event', 'action'],
        properties: {
          event: {
            type: 'string',
            description: 'Hook event pattern to match (e.g. Pre:tool:*, Post:file:write).',
          },
          condition: {
            type: 'string',
            description: 'Optional condition expression evaluated against event payload.',
          },
          action: {
            type: 'string',
            description: 'Action to execute when trigger fires.',
          },
        },
      },
      // mode: schedule
      scheduleAction: {
        type: 'string',
        enum: ['list', 'add', 'remove'],
        description: 'Schedule management action (mode: schedule).',
      },
      scheduleName: {
        type: 'string',
        description: 'Unique name for the schedule entry.',
      },
      scheduleInterval: {
        type: 'string',
        description: "Repeat interval, e.g. '5m', '1h', '30s' (mode: schedule, action: add).",
      },
      scheduleCommand: {
        type: 'string',
        description: 'Command to run on each interval tick (mode: schedule, action: add).',
      },
    },
  },
};
