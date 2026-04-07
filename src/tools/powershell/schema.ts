import type { ToolDefinition } from '../../types/tools.ts';

export const POWERSHELL_TOOL_SCHEMA: ToolDefinition = {
  name: 'powershell',
  description: 'Inspect PowerShell availability and run a bounded PowerShell command when pwsh is installed.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['availability', 'exec'],
      },
      command: { type: 'string' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface PowershellToolInput {
  readonly mode: 'availability' | 'exec';
  readonly command?: string;
}
