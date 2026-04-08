export const TASK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['create', 'list', 'show', 'status', 'depend', 'cancel', 'handoff', 'handoffs'],
    },
    view: { type: 'string', enum: ['summary', 'full'] },
    sessionId: { type: 'string' },
    taskId: { type: 'string' },
    title: { type: 'string' },
    label: { type: 'string' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'],
    },
    dependsOnSessionId: { type: 'string' },
    dependsOnTaskId: { type: 'string' },
    reason: { type: 'string' },
    toSessionId: { type: 'string' },
    scope: {
      type: 'string',
      enum: ['task', 'subtree', 'session'],
    },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

export type TaskToolInput = {
  mode: 'create' | 'list' | 'show' | 'status' | 'depend' | 'cancel' | 'handoff' | 'handoffs';
  view?: 'summary' | 'full';
  sessionId?: string;
  taskId?: string;
  title?: string;
  label?: string;
  status?: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  dependsOnSessionId?: string;
  dependsOnTaskId?: string;
  reason?: string;
  toSessionId?: string;
  scope?: 'task' | 'subtree' | 'session';
};
