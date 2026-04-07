import type { ToolDefinition } from '../../types/tools.ts';

export const QUESTION_TOOL_SCHEMA: ToolDefinition = {
  name: 'question',
  description: 'Track operator questions, answers, escalation, and closure.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['ask', 'list', 'show', 'answer', 'close'] },
      questionId: { type: 'string' },
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

export interface QuestionToolInput {
  readonly mode: 'ask' | 'list' | 'show' | 'answer' | 'close';
  readonly questionId?: string;
  readonly prompt?: string;
  readonly askedBy?: string;
  readonly target?: string;
  readonly answer?: string;
  readonly resolution?: string;
}
