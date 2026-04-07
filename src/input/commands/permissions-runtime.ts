import type { CommandRegistry } from '../command-registry.ts';
import type { SelectionAction, SelectionItem } from '../selection-modal.ts';

const VALID_MODES = ['allow-all', 'prompt', 'custom'] as const;
const VALID_ACTIONS = ['allow', 'prompt', 'deny'] as const;
const VALID_TOOLS = ['read', 'write', 'edit', 'exec', 'find', 'fetch', 'analyze', 'inspect', 'agent', 'state', 'workflow', 'registry', 'delegate', 'mcp'] as const;
type PermTool = typeof VALID_TOOLS[number];

export function registerPermissionsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'permissions',
    aliases: ['perms'],
    description: 'Show or set permission mode and per-tool settings',
    usage: '[allow-all|prompt|custom] | [tool <name> allow|prompt|deny]',
    argsHint: '[allow-all|prompt|custom]',
    handler(args, ctx) {
      const cm = ctx.configManager;
      if (args.length === 0) {
        if (ctx.openSelection) {
          const cycleActions = new Map<string, SelectionAction>([['enter', 'toggle' as const]]);
          const items: SelectionItem[] = VALID_TOOLS.map((tool) => ({
            id: tool,
            label: tool,
            detail: cm.get(`permissions.tools.${tool}` as Parameters<typeof cm.get>[0]) as string,
            category: 'tools',
            actions: '[Enter] cycle allow/prompt/deny',
          }));
          items.unshift({
            id: '__mode__',
            label: 'permission mode',
            detail: cm.get('permissions.mode') as string,
            category: 'global',
            actions: '[Enter] cycle allow-all/prompt/custom',
          });
          ctx.openSelection('Permissions', items, { allowSearch: true, customActions: cycleActions }, (result) => {
            if (!result) return;
            if (result.item.id === '__mode__') {
              const currentMode = cm.get('permissions.mode') as string;
              const nextMode = VALID_MODES[(VALID_MODES.indexOf(currentMode as typeof VALID_MODES[number]) + 1) % VALID_MODES.length];
              cm.setDynamic('permissions.mode', nextMode);
              result.item.detail = nextMode;
            } else {
              const toolKey = `permissions.tools.${result.item.id}` as Parameters<typeof cm.get>[0];
              const currentAction = cm.get(toolKey) as string;
              const nextAction = VALID_ACTIONS[(VALID_ACTIONS.indexOf(currentAction as typeof VALID_ACTIONS[number]) + 1) % VALID_ACTIONS.length];
              cm.setDynamic(toolKey, nextAction);
              result.item.detail = nextAction;
            }
            ctx.renderRequest();
          });
          return;
        }
        const lines = [`Permission mode: ${cm.get('permissions.mode')}`, '  Tool settings:'];
        for (const tool of VALID_TOOLS) lines.push(`    ${tool.padEnd(16)} ${cm.get(`permissions.tools.${tool}` as Parameters<typeof cm.get>[0])}`);
        lines.push('', '  Modes: prompt (default), allow-all, custom', '  Usage: /permissions <mode> | /permissions tool <name> allow|prompt|deny');
        ctx.print(lines.join('\n'));
        return;
      }
      if (args[0] === 'tool') {
        const toolName = args[1];
        const action = args[2];
        if (!toolName || !action) {
          ctx.print('Usage: /permissions tool <name> allow|prompt|deny');
          return;
        }
        if (!VALID_TOOLS.includes(toolName as PermTool)) {
          ctx.print(`Unknown tool: ${toolName}\nValid tools: ${VALID_TOOLS.join(', ')}`);
          return;
        }
        if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
          ctx.print(`Invalid action: ${action}\nValid actions: allow, prompt, deny`);
          return;
        }
        try {
          cm.setDynamic(`permissions.tools.${toolName}` as Parameters<typeof cm.set>[0], action);
          ctx.print(`Permission for ${toolName} set to: ${action}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }
      if (!VALID_MODES.includes(args[0] as typeof VALID_MODES[number])) {
        ctx.print(`Invalid mode: ${args[0]}\nValid modes: ${VALID_MODES.join(', ')}`);
        return;
      }
      try {
        cm.setDynamic('permissions.mode', args[0]);
        ctx.print(`Permission mode set to: ${args[0]}`);
      } catch (e) {
        ctx.print(`Error: ${(e as Error).message}`);
      }
    },
  });
}
