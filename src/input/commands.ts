import type { CommandRegistry, CommandContext } from './command-registry.ts';
import type { ConfigKey } from '../config/index.ts';
import { CONFIG_SCHEMA } from '../config/index.ts';
import { REASONING_BUDGET_MAP } from '../providers/interface.ts';
import { join } from 'path';

/** Exportable conversation shape returned by ConversationManager.toJSON(). */
interface ExportableConversation {
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: Array<{ name: string; arguments: unknown }>;
    callId?: string;
    toolName?: string;
  }>;
}

/**
 * registerBuiltinCommands - Register all built-in slash commands into the registry.
 * Call once during application startup.
 */
export function registerBuiltinCommands(registry: CommandRegistry): void {

  // ── /model ──────────────────────────────────────────────
  registry.register({
    name: 'model',
    aliases: ['m'],
    description: 'Select or display the current LLM model',
    usage: '[model-id]',
    handler(args, ctx) {
      if (args.length === 0) {
        const models = ctx.providerRegistry.getSelectableModels();
        const current = ctx.runtime.model;
        const lines = ['Available models:', ...models.map(m =>
          `  ${m.id === current ? '▶' : ' '} ${m.id.padEnd(36)} ${m.displayName} (${m.provider})`
        )];
        ctx.print(lines.join('\n'));
      } else {
        const modelId = args[0];
        try {
          ctx.providerRegistry.setCurrentModel(modelId);
          const def = ctx.providerRegistry.getCurrentModel();
          ctx.runtime.model = def.id;
          ctx.runtime.provider = def.provider;
          ctx.configManager.set('provider.model', def.id);
          ctx.configManager.set('provider.provider', def.provider);
          ctx.print(`Switched to model: ${def.displayName} (${def.provider})`);
          ctx.eventBus.emit('command:model-changed', { provider: def.provider, model: def.id });
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      }
    },
  });

  // ── /help ──────────────────────────────────────────────
  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and keyboard shortcuts',
    handler(_args, ctx) {
      const lines = [
        'Slash commands:',
        '',
        '  Model & Provider:',
        '    /model [id]       Select LLM model',
        '    /provider [name]  Switch provider',
        '    /effort [level]   Show or set reasoning effort (instant/low/medium/high)',
        '',
        '  Config & Display:',
        '    /config [key] [value]   Show or set config values',
        '    /config reset [key]     Reset config key or all to defaults',
        '    /debug            Toggle debug mode',
        '    /lines            Toggle line numbers on/off',
        '',
        '  Conversation:',
        '    /clear            Clear display (keep context)',
        '    /reset            Clear display + context',
        '    /compact          Summarize conversation to free context',
        '    /export [file]    Export conversation as markdown',
        '    /title [text]     Show or set conversation title',
        '',
        '  Tools & System:',
        '    /tools            List available tools',
        '    /help             Show this help',
        '    /quit             Exit',
        '',
        'Keyboard shortcuts:',
        '  Enter             Send message',
        '  Shift+Enter       Insert newline',
        '  Ctrl+C x2        Exit',
        '  Ctrl+L            Clear screen',
        '  Ctrl+U            Clear prompt line',
        '  PageUp/PageDown   Scroll by page',
        '  Arrow Up/Down     Scroll 3 lines',
        '  Mouse wheel       Scroll',
        '  Middle click      Paste (image or text)',
        '  Click drag        Select text',
        '  Ctrl+Shift+C      Copy selection',
        '  Tab               Toggle collapse of nearest block',
        '  Ctrl+Y            Copy nearest code/tool block',
        '  Ctrl+A            Apply nearest diff block',
        '  Ctrl+V            Paste (image or text)',
      ];
      ctx.print(lines.join('\n'));
    },
  });

  // ── /clear ─────────────────────────────────────────────
  registry.register({
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear the conversation display (keeps LLM context)',
    handler(_args, ctx) {
      ctx.conversationManager.clearDisplay();
      ctx.renderRequest();
    },
  });

  // ── /reset ─────────────────────────────────────────────
  registry.register({
    name: 'reset',
    aliases: [],
    description: 'Full reset: clear display and conversation context',
    handler(_args, ctx) {
      ctx.conversationManager.resetAll();
      // Reload system prompt from file on reset
      if (ctx.reloadSystemPrompt) {
        ctx.runtime.systemPrompt = ctx.reloadSystemPrompt();
      }
      ctx.conversationManager.rebuildHistory();
      ctx.renderRequest();
    },
  });

  // ── /compact ───────────────────────────────────────────
  registry.register({
    name: 'compact',
    aliases: [],
    description: 'Summarize conversation to free context window',
    async handler(_args, ctx) {
      ctx.print('Compacting conversation...');
      await ctx.conversationManager.compact(ctx.providerRegistry, ctx.runtime.model);
      ctx.print('Conversation compacted.');
      ctx.renderRequest();
    },
  });

  // ── /config ────────────────────────────────────────────
  registry.register({
    name: 'config',
    aliases: ['cfg'],
    description: 'Show or set config values',
    usage: '[category|key] [value] | reset [key]',
    handler(args, ctx) {
      const cm = ctx.configManager;
      const all = cm.getAll();
      const categories = ['display', 'provider', 'behavior'] as const;

      // /config reset [key]
      if (args[0] === 'reset') {
        const resetKey = args[1] as ConfigKey | undefined;
        if (resetKey) {
          try {
            cm.reset(resetKey);
            const schema = CONFIG_SCHEMA.find(s => s.key === resetKey);
            const defaultVal = schema ? schema.default : '?';
            ctx.print(`Reset ${resetKey} to default: ${String(defaultVal)}`);
          } catch (e) {
            ctx.print(`Error: ${(e as Error).message}`);
          }
        } else {
          cm.reset();
          ctx.print('All config reset to defaults.');
        }
        return;
      }

      // /config (no args) — show all settings grouped by category
      if (args.length === 0) {
        const lines: string[] = ['Config settings:'];
        for (const cat of categories) {
          lines.push(`  [${cat}]`);
          const catObj = all[cat] as Record<string, unknown>;
          for (const [field, val] of Object.entries(catObj)) {
            const key = `${cat}.${field}`;
            const schema = CONFIG_SCHEMA.find(s => s.key === key);
            const desc = schema ? ` — ${schema.description}` : '';
            lines.push(`    ${key.padEnd(36)} ${String(val)}${desc}`);
          }
        }
        ctx.print(lines.join('\n'));
        return;
      }

      // /config <category> — show one category
      const firstArg = args[0];
      if (categories.includes(firstArg as typeof categories[number]) && args.length === 1) {
        const cat = firstArg as typeof categories[number];
        const catObj = all[cat] as Record<string, unknown>;
        const lines: string[] = [`[${cat}]`];
        for (const [field, val] of Object.entries(catObj)) {
          const key = `${cat}.${field}`;
          const schema = CONFIG_SCHEMA.find(s => s.key === key);
          const desc = schema ? ` — ${schema.description}` : '';
          lines.push(`  ${key.padEnd(36)} ${String(val)}${desc}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      // /config <dot.key> — show one setting
      if (args.length === 1 && firstArg.includes('.')) {
        const key = firstArg as ConfigKey;
        const schema = CONFIG_SCHEMA.find(s => s.key === key);
        if (!schema) {
          ctx.print(`Unknown config key: ${key}\nRun /config to see all keys.`);
          return;
        }
        try {
          const val = cm.get(key);
          const defaultVal = schema.default;
          const lines = [
            `${key}`,
            `  value:   ${String(val)}`,
            `  default: ${String(defaultVal)}`,
            `  type:    ${schema.type}${schema.enumValues ? ` (${schema.enumValues.join(', ')})` : ''}`,
            `  desc:    ${schema.description}`,
          ];
          ctx.print(lines.join('\n'));
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }

      // /config <dot.key> <value> — set value
      if (args.length >= 2 && firstArg.includes('.')) {
        const key = firstArg as ConfigKey;
        const rawValue = args.slice(1).join(' ');
        const schema = CONFIG_SCHEMA.find(s => s.key === key);
        if (!schema) {
          ctx.print(`Unknown config key: ${key}\nRun /config to see all keys.`);
          return;
        }

        let coerced: unknown;
        try {
          coerced = coerceValue(rawValue, schema.type, schema.enumValues);
        } catch (e) {
          ctx.print(`Invalid value for ${key}: ${(e as Error).message}`);
          return;
        }

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cm.set(key, coerced as any);
          ctx.print(`Set ${key} = ${String(coerced)}`);

          // Keep runtime in sync for live fields
          if (key === 'provider.model') ctx.runtime.model = coerced as string;
          if (key === 'provider.provider') ctx.runtime.provider = coerced as string;
          if (key === 'provider.reasoningEffort') ctx.runtime.reasoningEffort = coerced as string;
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }

      // Fallback: legacy model/provider/system shortcuts
      if (args.length >= 2) {
        const [key, ...rest] = args;
        const value = rest.join(' ');
        switch (key) {
          case 'system':
          case 'systemPrompt':
            ctx.runtime.systemPrompt = value;
            ctx.print(`System prompt updated (runtime only; use provider.systemPromptFile for persistence).`);
            break;
          case 'model':
            try {
              ctx.providerRegistry.setCurrentModel(value);
              const def = ctx.providerRegistry.getCurrentModel();
              ctx.runtime.model = def.id;
              ctx.runtime.provider = def.provider;
              cm.set('provider.model', value);
              ctx.print(`Model set to: ${def.displayName}`);
            } catch (e) {
              ctx.print(`Error: ${(e as Error).message}`);
            }
            break;
          default:
            ctx.print(`Unknown config key: ${key}\nRun /config to see all keys.`);
        }
        return;
      }

      ctx.print(`Usage: /config [category|key] [value]\n/config reset [key]`);
    },
  });

  // ── /tools ────────────────────────────────────────────
  registry.register({
    name: 'tools',
    aliases: ['t'],
    description: 'List available tools',
    handler(_args, ctx) {
      const tools = ctx.toolRegistry.list();
      const lines = ['Available tools:', ...tools.map(t => `  • ${t.definition.name}`)];
      ctx.print(lines.join('\n'));
    },
  });

  // ── /provider ──────────────────────────────────────────
  registry.register({
    name: 'provider',
    aliases: ['p'],
    description: 'Switch provider',
    usage: '[provider-name]',
    handler(args, ctx) {
      if (args.length === 0) {
        const providers = ['openai', 'anthropic', 'gemini', 'inceptionlabs'];
        const current = ctx.runtime.provider;
        ctx.print(['Available providers:', ...providers.map(p =>
          `  ${p === current ? '▶' : ' '} ${p}`
        )].join('\n'));
      } else {
        const providerName = args[0];
        const models = ctx.providerRegistry.getSelectableModels();
        const match = models.find(m => m.provider === providerName);
        if (!match) {
          ctx.print(`Unknown provider: ${providerName}. Available: openai, anthropic, gemini, inceptionlabs`);
          return;
        }
        try {
          ctx.providerRegistry.setCurrentModel(match.id);
          ctx.runtime.model = match.id;
          ctx.runtime.provider = providerName;
          ctx.configManager.set('provider.provider', providerName);
          ctx.configManager.set('provider.model', match.id);
          ctx.print(`Switched to provider: ${providerName} (model: ${match.id})`);
          ctx.eventBus.emit('command:model-changed', { provider: providerName, model: match.id });
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      }
    },
  });

  // ── /quit ─────────────────────────────────────────────
  registry.register({
    name: 'quit',
    aliases: ['q', ':q'],
    description: 'Exit the application',
    handler(_args, ctx) {
      ctx.exit();
    },
  });

  // ── /debug ────────────────────────────────────────────
  registry.register({
    name: 'debug',
    aliases: [],
    description: 'Toggle debug mode',
    handler(_args, ctx) {
      ctx.runtime.debugMode = !ctx.runtime.debugMode;
      ctx.print(`Debug mode: ${ctx.runtime.debugMode ? 'ON' : 'OFF'}`);
    },
  });

  // ── /effort ───────────────────────────────────────────
  registry.register({
    name: 'effort',
    aliases: ['e'],
    description: 'Show or set reasoning effort level',
    usage: '[instant|low|medium|high]',
    handler(args, ctx) {
      const VALID_LEVELS = ['instant', 'low', 'medium', 'high'] as const;
      type EffortLevel = typeof VALID_LEVELS[number];

      if (args.length === 0) {
        const current = (ctx.runtime.reasoningEffort || ctx.configManager.get('provider.reasoningEffort') || 'medium') as string;
        const budget = REASONING_BUDGET_MAP[current];
        const lines = [
          `Reasoning effort: ${current}`,
          `  Mercury-2:  reasoning_effort = '${current}'`,
          `  Claude:     thinking.budget_tokens = ${budget}`,
          `  Gemini:     thinking_config.thinking_budget = ${budget}`,
          `  GPT-5:      (no-op)`,
          ``,
          `Levels: instant (fastest/cheapest), low, medium (default), high (most thorough)`,
        ];
        ctx.print(lines.join('\n'));
        return;
      }

      const level = args[0] as EffortLevel;
      if (!VALID_LEVELS.includes(level)) {
        ctx.print(`Invalid effort level: ${level}\nValid levels: ${VALID_LEVELS.join(', ')}`);
        return;
      }

      ctx.runtime.reasoningEffort = level;
      ctx.configManager.set('provider.reasoningEffort', level);
      ctx.print(`Reasoning effort set to: ${level}`);
    },
  });

  // ── /lines ────────────────────────────────────────────
  registry.register({
    name: 'lines',
    aliases: [],
    description: 'Toggle line numbers on/off',
    handler(_args, ctx) {
      const current = ctx.configManager.get('display.lineNumbers');
      ctx.configManager.set('display.lineNumbers', !current);
      ctx.print(`Line numbers: ${!current ? 'ON' : 'OFF'}`);
      ctx.renderRequest();
    },
  });

  // ── /export ───────────────────────────────────────────
  registry.register({
    name: 'export',
    aliases: [],
    description: 'Export conversation as markdown',
    usage: '[filename.md]',
    async handler(args, ctx) {
      const messages = ctx.conversationManager.toJSON() as ExportableConversation;
      const lines: string[] = [];

      for (const msg of messages.messages) {
        if (msg.role === 'user') {
          lines.push(`## User\n\n${msg.content}\n`);
        } else if (msg.role === 'assistant') {
          lines.push(`## Assistant\n\n${msg.content}\n`);
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            for (const tc of msg.toolCalls) {
              lines.push(`### Tool Call: ${tc.name}\n\n\`\`\`json\n${JSON.stringify(tc.arguments, null, 2)}\n\`\`\`\n`);
            }
          }
        } else if (msg.role === 'tool') {
          const name = msg.toolName ?? msg.callId ?? 'tool';
          lines.push(`## Tool: ${name}\n\n\`\`\`\n${msg.content}\n\`\`\`\n`);
        } else if (msg.role === 'system') {
          lines.push(`## System\n\n${msg.content}\n`);
        }
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = args[0] ?? `goodvibes-export-${timestamp}.md`;
      const filepath = join(process.cwd(), filename);
      try {
        const { writeFile } = await import('fs/promises');
        await writeFile(filepath, lines.join('\n'), 'utf-8');
        ctx.print(`Conversation exported to: ${filepath}`);
      } catch (e) {
        ctx.print(`Export failed: ${(e as Error).message}`);
      }
    },
  });

  // ── /title ────────────────────────────────────────────
  registry.register({
    name: 'title',
    aliases: [],
    description: 'Show or set the conversation title',
    usage: '[text]',
    handler(args, ctx) {
      if (args.length === 0) {
        const current = ctx.conversationManager.title;
        ctx.print(current ? `Conversation title: ${current}` : 'No title set.');
      } else {
        ctx.conversationManager.title = args.join(' ');
        ctx.print(`Title set to: ${ctx.conversationManager.title}`);
        ctx.renderRequest();
      }
    },
  });
}

/** Coerce a string value to the appropriate type for a config setting. */
function coerceValue(
  raw: string,
  type: 'boolean' | 'number' | 'string' | 'enum',
  enumValues?: string[]
): unknown {
  switch (type) {
    case 'boolean': {
      if (raw === 'true' || raw === '1' || raw === 'yes') return true;
      if (raw === 'false' || raw === '0' || raw === 'no') return false;
      throw new Error(`Expected true/false, got: ${raw}`);
    }
    case 'number': {
      const n = Number(raw);
      if (isNaN(n)) throw new Error(`Expected a number, got: ${raw}`);
      return n;
    }
    case 'enum': {
      if (enumValues && !enumValues.includes(raw)) {
        throw new Error(`Expected one of: ${enumValues.join(', ')}; got: ${raw}`);
      }
      return raw;
    }
    case 'string':
      return raw;
  }
}

