import type { ToolDefinition } from '../../types/tools.ts';

export const REPL_TOOL_SCHEMA: ToolDefinition = {
  name: 'repl',
  description: 'Evaluate bounded JavaScript, TypeScript, Python, SQL, and GraphQL snippets through controlled sandbox profiles.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['eval', 'history'] },
      runtime: { type: 'string', enum: ['javascript', 'typescript', 'python', 'sql', 'graphql'] },
      expression: { type: 'string' },
      bindings: { type: 'object', additionalProperties: true },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface ReplToolInput {
  readonly mode: 'eval' | 'history';
  readonly runtime?: 'javascript' | 'typescript' | 'python' | 'sql' | 'graphql';
  readonly expression?: string;
  readonly bindings?: Record<string, unknown>;
}
