import type { Tool } from '@pellux/goodvibes-sdk/platform/types/tools';
import { CONTROL_TOOL_SCHEMA, type ControlToolInput } from '@pellux/goodvibes-sdk/platform/tools/control/schema';
import { listBuiltinSubscriptionProviders } from '../../config/subscription-providers.ts';
import { listSandboxPresets } from '../../runtime/sandbox/manager.ts';

const PACKAGED_COMMANDS = [
  'setup',
  'security',
  'marketplace',
  'bridge',
  'remote',
  'teleport',
  'subscription',
  'sandbox',
  'knowledge',
  'teamwork',
  'install',
  'update',
  'login',
  'logout',
] as const;

const CONTROL_PANELS = [
  'cockpit',
  'security',
  'remote',
  'knowledge',
  'marketplace',
  'sandbox',
  'subscription',
  'orchestration',
  'incident',
  'hooks',
  'mcp',
] as const;

export const controlTool: Tool = {
  definition: {
    name: 'control',
    description: 'Inspect packaged product-control surfaces such as commands, panels, subscriptions, and sandbox presets.',
    parameters: CONTROL_TOOL_SCHEMA.parameters,
    sideEffects: ['state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as unknown as ControlToolInput;

    if (input.mode === 'commands') {
      return { success: true, output: JSON.stringify({ count: PACKAGED_COMMANDS.length, commands: PACKAGED_COMMANDS }) };
    }
    if (input.mode === 'panels') {
      return { success: true, output: JSON.stringify({ count: CONTROL_PANELS.length, panels: CONTROL_PANELS }) };
    }
    if (input.mode === 'subscriptions') {
      return {
        success: true,
        output: JSON.stringify({
          count: listBuiltinSubscriptionProviders().length,
          providers: listBuiltinSubscriptionProviders().map((entry) => ({
            provider: entry.provider,
            label: entry.displayName,
            overrideAmbientApiKeys: entry.oauth.overrideAmbientApiKeys,
          })),
        }),
      };
    }
    if (input.mode === 'sandbox-presets') {
      return {
        success: true,
        output: JSON.stringify({
          count: listSandboxPresets().length,
          presets: listSandboxPresets().map((preset) => ({
            id: preset.id,
            label: preset.label,
            replIsolation: preset.config.replIsolation,
            mcpIsolation: preset.config.mcpIsolation,
            windowsMode: preset.config.windowsMode,
            vmBackend: preset.config.vmBackend,
          })),
        }),
      };
    }

    return { success: false, error: `Unknown mode: ${input.mode}` };
  },
};
