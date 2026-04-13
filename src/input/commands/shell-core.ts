import type { CommandRegistry } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { EFFORT_DESCRIPTIONS } from '../../providers/effort-levels.ts';
import { REASONING_BUDGET_MAP } from '../../providers/interface.ts';
import { executeWriteQuit } from './quit-shared.ts';
import { compactConversation, requireKeybindingsManager, requireProviderApi } from './runtime-services.ts';

export function registerShellCoreCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'model',
    aliases: ['m'],
    description: 'Select or display the current LLM model',
    usage: '[model-id]',
    argsHint: '[name]',
    async handler(args, ctx) {
      const providerApi = requireProviderApi(ctx);
      if (args.length === 0) {
        if (ctx.openModelPicker) {
          ctx.openModelPicker();
        } else {
          const models = await providerApi.listModels({ selectableOnly: true });
          const lines = ['Available models:', ...models.map((model) =>
            `  ${model.current ? '▶' : ' '} ${model.registryKey.padEnd(36)} ${model.displayName} (${model.providerId})`,
          )];
          ctx.print(lines.join('\n'));
        }
      } else {
        const modelId = args[0];
        try {
          const selected = await providerApi.selectModel(modelId);
          ctx.session.runtime.model = selected.registryKey;
          ctx.session.runtime.provider = selected.providerId;
          ctx.platform.configManager.set('provider.model', selected.registryKey);
          ctx.platform.configManager.set('provider.provider', selected.providerId);
          ctx.print(`Switched to model: ${selected.displayName} (${selected.providerId})`);
          void providerApi.recordModelUsage(selected.registryKey).catch(() => undefined);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      }
    },
  });

  registry.register({
    name: 'commands',
    aliases: ['cmds'],
    description: 'Browse all commands in a scrollable list',
    handler(_args, ctx) {
      if (ctx.openHelpOverlay) {
        ctx.openHelpOverlay();
        return;
      }
      ctx.print('Use /help for interactive command list');
    },
  });

  registry.register({
    name: 'shortcuts',
    aliases: ['keys', 'keybinds'],
    description: 'Show keyboard shortcuts reference',
    handler(_args, ctx) {
      if (ctx.openShortcutsOverlay) {
        ctx.openShortcutsOverlay();
        return;
      }
      ctx.print('Use ? key or /help for shortcuts');
    },
  });

  registry.register({
    name: 'keybindings',
    aliases: ['kb'],
    description: 'List current keyboard bindings and their config file path',
    handler(_args, ctx) {
      const km = requireKeybindingsManager(ctx);
      const all = km.getAll();
      const lines: string[] = [
        `Keybindings config: ${km.getConfigPath()}`,
        '',
        `  ${'Action'.padEnd(28)}  ${'Binding'.padEnd(20)}  Description`,
        `  ${'─'.repeat(28)}  ${'─'.repeat(20)}  ${'─'.repeat(34)}`,
      ];
      for (const { action, combos, description } of all) {
        const label = combos.map((combo) => km.formatCombo(combo)).join(', ');
        lines.push(`  ${action.padEnd(28)}  ${label.padEnd(20)}  ${description}`);
      }
      lines.push('');
      lines.push('To customize: create the config file with { "action": { "key": "x", "ctrl": true } }');
      ctx.print(lines.join('\n'));
    },
  });

  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and keyboard shortcuts',
    argsHint: '[command]',
    handler(_args, ctx) {
      if (ctx.openSelection) {
        const items: SelectionItem[] = [
          { id: '/model', label: '/model [id]', detail: 'Select LLM model', category: 'Model & Provider' },
          { id: '/provider', label: '/provider [name]', detail: 'Switch provider', category: 'Model & Provider' },
          { id: '/effort', label: '/effort [level]', detail: 'Reasoning effort (instant/low/medium/high)', category: 'Model & Provider' },
          { id: '/config', label: '/config [key] [value]', detail: 'Show or set config values', category: 'Config & Display' },
          { id: '/config diff', label: '/config diff', detail: 'Show changed settings', category: 'Config & Display' },
          { id: '/config reset', label: '/config reset [key]', detail: 'Reset to defaults', category: 'Config & Display' },
          { id: '/config profile', label: '/config profile ...', detail: 'Save/load/list/delete profiles', category: 'Config & Display' },
          { id: '/debug', label: '/debug', detail: 'Toggle debug mode', category: 'Config & Display' },
          { id: '/lines', label: '/lines', detail: 'Set line numbers: all, code, or off', category: 'Config & Display' },
          { id: '/expand', label: '/expand [type]', detail: 'Expand blocks (all|thinking|tool|code)', category: 'Config & Display' },
          { id: '/collapse', label: '/collapse [type]', detail: 'Collapse blocks', category: 'Config & Display' },
          { id: '/bookmarks', label: '/bookmarks', detail: 'List bookmarked blocks', category: 'Config & Display' },
          { id: '/clear', label: '/clear', detail: 'Clear display (keep context)', category: 'Conversation' },
          { id: '/reset', label: '/reset', detail: 'Clear display + context', category: 'Conversation' },
          { id: '/compact', label: '/compact', detail: 'Summarize to free context', category: 'Conversation' },
          { id: '/export', label: '/export [file]', detail: 'Export as markdown', category: 'Conversation' },
          { id: '/title', label: '/title [text]', detail: 'Show or set title', category: 'Conversation' },
          { id: '/save', label: '/save [name]', detail: 'Save session', category: 'Conversation' },
          { id: '/load', label: '/load <name>', detail: 'Load session', category: 'Conversation' },
          { id: '/sessions', label: '/sessions', detail: 'List saved sessions', category: 'Conversation' },
          { id: '/session', label: '/session', detail: 'Current session info', category: 'Conversation' },
          { id: '/session list', label: '/session list', detail: 'List all sessions', category: 'Conversation' },
          { id: '/session rename', label: '/session rename <name>', detail: 'Rename current session', category: 'Conversation' },
          { id: '/session resume', label: '/session resume <id>', detail: 'Load and resume a session', category: 'Conversation' },
          { id: '/session fork', label: '/session fork [name]', detail: 'Fork current session to new ID', category: 'Conversation' },
          { id: '/session save', label: '/session save [name]', detail: 'Force-save current session', category: 'Conversation' },
          { id: '/session info', label: '/session info [id]', detail: 'Show session details', category: 'Conversation' },
          { id: '/session export', label: '/session export <id> [format]', detail: 'Export session as markdown/text', category: 'Conversation' },
          { id: '/session search', label: '/session search <query>', detail: 'Search across all sessions', category: 'Conversation' },
          { id: '/session delete', label: '/session delete <id>', detail: 'Delete a session', category: 'Conversation' },
          { id: '/undo', label: '/undo', detail: 'Remove last turn', category: 'Conversation' },
          { id: '/redo', label: '/redo', detail: 'Restore undone turn', category: 'Conversation' },
          { id: '/retry', label: '/retry [text]', detail: 'Re-send last message', category: 'Conversation' },
          { id: '/fork', label: '/fork [name]', detail: 'Snapshot conversation as a named branch', category: 'Conversation' },
          { id: '/branch', label: '/branch [name]', detail: 'List branches or switch to one', category: 'Conversation' },
          { id: '/merge', label: '/merge <name>', detail: 'Append messages from a branch', category: 'Conversation' },
          { id: '/template', label: '/template', detail: 'Browse templates', category: 'Templates' },
          { id: '/template save', label: '/template save <name>', detail: 'Save prompt as template', category: 'Templates' },
          { id: '/template use', label: '/template use <name>', detail: 'Execute template', category: 'Templates' },
          { id: '/tools', label: '/tools', detail: 'List available tools', category: 'Tools & System' },
          { id: '/permissions', label: '/permissions', detail: 'Permission settings', category: 'Tools & System' },
          { id: '/shortcuts', label: '/shortcuts', detail: 'View keyboard shortcuts reference', category: 'Tools & System' },
          { id: '/commands', label: '/commands', detail: 'Browse all commands in a scrollable list', category: 'Tools & System' },
          { id: '/secrets', label: '/secrets set|link|get|test|list|delete', detail: 'Manage encrypted and provider-backed secrets', category: 'Tools & System' },
          { id: '/danger', label: '/danger [key] [value]', detail: 'DANGEROUS SETTINGS', category: 'Tools & System', fg: '#ef4444' },
          { id: '/help', label: '/help', detail: 'This help', category: 'Tools & System' },
          { id: '/quit', label: '/quit', detail: 'Exit', category: 'Tools & System' },
          { id: '/wq', label: '/wq', detail: 'Commit all git changes and then exit', category: 'Tools & System' },
        ];
        ctx.openSelection('Help  —  Commands', items, { allowSearch: true }, (result) => {
          if (!result) return;
          const command = result.item.id;
          if (command.startsWith('/')) {
            const parts = command.slice(1).trim().split(/\s+/);
            const name = parts[0];
            const cmdArgs = parts.slice(1);
            void (ctx.executeCommand?.(name, cmdArgs) ?? registry.execute(name, cmdArgs, ctx));
          }
        });
        return;
      }
      ctx.print('Use /help to open the help modal. Commands: /model, /provider, /config, /template, /tools, /permissions, /sessions, /bookmarks, /save, /load, /undo, /redo, /retry, /clear, /reset, /compact, /export, /title, /effort, /lines, /expand, /collapse, /debug, /quit, /wq');
    },
  });

  registry.register({
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear the conversation display (keeps LLM context)',
    handler(_args, ctx) {
      ctx.session.conversationManager.clearDisplay();
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'reset',
    aliases: [],
    description: 'Full reset: clear display and conversation context',
    handler(_args, ctx) {
      ctx.session.conversationManager.resetAll();
      if (ctx.reloadSystemPrompt) {
        ctx.session.runtime.systemPrompt = ctx.reloadSystemPrompt();
      }
      ctx.session.conversationManager.rebuildHistory();
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'compact',
    aliases: [],
    description: 'Summarize conversation to free context window',
    async handler(_args, ctx) {
      ctx.print('Compacting conversation...');
      await compactConversation(ctx);
      ctx.print('Conversation compacted.');
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'quit',
    aliases: ['q', ':q'],
    description: 'Exit the application',
    handler(_args, ctx) {
      ctx.exit();
    },
  });

  registry.register({
    name: 'wq',
    aliases: [':wq'],
    description: 'Commit all git changes and then exit',
    async handler(_args, ctx) {
      await executeWriteQuit(ctx);
    },
  });

  registry.register({
    name: 'debug',
    aliases: [],
    description: 'Toggle debug mode',
    handler(_args, ctx) {
      ctx.session.runtime.debugMode = !ctx.session.runtime.debugMode;
      ctx.print(`Debug mode: ${ctx.session.runtime.debugMode ? 'ON' : 'OFF'}`);
    },
  });

  registry.register({
    name: 'effort',
    aliases: ['e'],
    description: 'Show or set reasoning effort level',
    usage: '[level]',
    argsHint: '<instant|low|medium|high>',
    async handler(args, ctx) {
      const currentModel = await requireProviderApi(ctx).getCurrentModel();
      const validLevels = currentModel.reasoningEffort ?? [];

      if (validLevels.length === 0) {
        ctx.print(`Current model (${currentModel.displayName}) does not support configurable reasoning effort.`);
        return;
      }

      if (args.length === 0) {
        const current = (ctx.session.runtime.reasoningEffort || ctx.platform.configManager.get('provider.reasoningEffort') || 'medium') as string;
        if (ctx.openSelection) {
          const descriptions: Record<string, string> = {
            ...EFFORT_DESCRIPTIONS,
            medium: 'Balanced speed and quality (default)',
          };
          const items: SelectionItem[] = validLevels.map((level) => ({
            id: level,
            label: level,
            detail: level === current ? `◉ ${descriptions[level] ?? level}` : (descriptions[level] ?? level),
          }));
          ctx.openSelection('Reasoning Effort', items, { preSelectId: current, allowSearch: false }, (result) => {
            if (!result) return;
            const level = result.item.id as 'instant' | 'low' | 'medium' | 'high';
            ctx.session.runtime.reasoningEffort = level;
            ctx.platform.configManager.set('provider.reasoningEffort', level);
            ctx.print(`Reasoning effort set to: ${level}`);
            ctx.renderRequest();
          });
          return;
        }
        const budget = REASONING_BUDGET_MAP[current];
        const lines = [
          `Reasoning effort: ${current}`,
          `  Mercury-2:  reasoning_effort = '${current}'`,
          `  Claude:     thinking.budget_tokens = ${budget}`,
          `  Gemini:     thinking_config.thinking_budget = ${budget}`,
          `  GPT-5:      (no-op)`,
          '',
          `Levels: ${validLevels.join(', ')}`,
        ];
        ctx.print(lines.join('\n'));
        return;
      }

      const level = args[0] as 'instant' | 'low' | 'medium' | 'high';
      if (!validLevels.includes(level)) {
        ctx.print(`Invalid effort level: ${level}\nValid levels: ${validLevels.join(', ')}`);
        return;
      }

      ctx.session.runtime.reasoningEffort = level;
      ctx.platform.configManager.set('provider.reasoningEffort', level);
      ctx.print(`Reasoning effort set to: ${level}`);
    },
  });

  registry.register({
    name: 'lines',
    aliases: [],
    description: 'Set line-number display: all, code, or off',
    handler(args, ctx) {
      const current = ctx.platform.configManager.get('display.lineNumbers');
      const aliases: Record<string, 'all' | 'code' | 'off'> = {
        on: 'all',
        all: 'all',
        code: 'code',
        blocks: 'code',
        off: 'off',
      };
      const cycle: Array<'all' | 'code' | 'off'> = ['all', 'code', 'off'];
      const requested = args[0]?.toLowerCase();
      const next = requested ? aliases[requested] : cycle[(cycle.indexOf(current) + 1) % cycle.length]!;
      if (requested && !next) {
        ctx.print('Usage: /lines [all|code|off]');
        return;
      }
      ctx.platform.configManager.set('display.lineNumbers', next);
      const label = next === 'all' ? 'ON (all lines)' : next === 'code' ? 'CODE BLOCKS ONLY' : 'OFF';
      ctx.print(`Line numbers: ${label}`);
      ctx.renderRequest();
    },
  });
}
