import type { ToolDefinition } from '../../types/tools.ts';

export const CONTROL_TOOL_SCHEMA: ToolDefinition = {
  name: 'control',
  description: 'Inspect packaged product-control surfaces such as commands, panels, subscriptions, and sandbox presets.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['commands', 'panels', 'subscriptions', 'sandbox-presets'],
      },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface ControlToolInput {
  readonly mode: 'commands' | 'panels' | 'subscriptions' | 'sandbox-presets';
}
