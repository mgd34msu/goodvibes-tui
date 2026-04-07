import type { ToolDefinition } from '../../types/tools.ts';

export const BRIEF_TOOL_SCHEMA: ToolDefinition = {
  name: 'brief',
  description: 'Manage durable implementation briefs and published execution packets.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['create', 'list', 'show', 'revise', 'publish'] },
      briefId: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      goals: { type: 'array', items: { type: 'string' } },
      constraints: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      audience: { type: 'string' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface BriefToolInput {
  readonly mode: 'create' | 'list' | 'show' | 'revise' | 'publish';
  readonly briefId?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly goals?: readonly string[];
  readonly constraints?: readonly string[];
  readonly risks?: readonly string[];
  readonly audience?: string;
}
