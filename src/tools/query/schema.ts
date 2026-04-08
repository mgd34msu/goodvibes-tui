import type { ToolDefinition } from '../../types/tools.ts';

export const QUERY_TOOL_SCHEMA: ToolDefinition = {
  name: 'query',
  description: 'Track operator queries, answers, escalation, and closure.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['ask', 'list', 'show', 'answer', 'close'] },
      queryId: { type: 'string' },
      prompt: { type: 'string' },
      askedBy: { type: 'string' },
      target: { type: 'string' },
      answer: { type: 'string' },
      resolution: { type: 'string' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface QueryToolInput {
  readonly mode: 'ask' | 'list' | 'show' | 'answer' | 'close';
  readonly queryId?: string;
  readonly prompt?: string;
  readonly askedBy?: string;
  readonly target?: string;
  readonly answer?: string;
  readonly resolution?: string;
}
