import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CommandRegistry, CommandContext } from './command-registry.ts';

/**
 * registerBuiltinCommands - Register all built-in slash commands into the registry.
 * Call once during application startup.
 */
export function registerBuiltinCommands(registry: CommandRegistry): void {

  // ── /model ───────────────────────────────────────────────────────────────
  registry.register({
    name: 'model',
    aliases: ['m'],
    description: 'Select or display the current LLM model',
    usage: '[model-id]',
    handler(args, ctx) {
      if (args.length === 0) {
        // List selectable models
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
          // Persist to config
          saveConfigKey('model', modelId);
          saveConfigKey('provider', def.provider);
          ctx.print(`Switched to model: ${def.displayName} (${def.provider})`);
          ctx.eventBus.emit('command:model-changed', { provider: def.provider, model: def.id });
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      }
    },
  });

  // ── /help ────────────────────────────────────────────────────────────────
  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and keyboard shortcuts',
    handler(_args, ctx) {
      const lines = [
        'Slash commands:',
        '  /model [id]       Select LLM model',
        '  /provider [name]  Switch provider',
        '  /clear            Clear display (keep context)',
        '  /reset            Clear display + context',
        '  /compact          Summarize conversation to free context',
        '  /config [k] [v]   Show or set config values',
        '  /tools            List available tools',
        '  /debug            Toggle debug mode',
        '  /help             Show this help',
        '  /quit             Exit',
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
        '  Left click        Middle-click paste',
        '  Click drag        Select text',
        '  Ctrl+Shift+C      Copy selection',
      ];
      ctx.print(lines.join('\n'));
    },
  });

  // ── /clear ───────────────────────────────────────────────────────────────
  registry.register({
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear the conversation display (keeps LLM context)',
    handler(_args, ctx) {
      ctx.conversationManager.clearDisplay();
      ctx.renderRequest();
    },
  });

  // ── /reset ───────────────────────────────────────────────────────────────
  registry.register({
    name: 'reset',
    aliases: [],
    description: 'Full reset: clear display and conversation context',
    handler(_args, ctx) {
      ctx.conversationManager.resetAll();
      ctx.print('Conversation reset.');
    },
  });

  // ── /compact ─────────────────────────────────────────────────────────────
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

  // ── /config ──────────────────────────────────────────────────────────────
  registry.register({
    name: 'config',
    aliases: ['cfg'],
    description: 'Show or set config values',
    usage: '[key] [value]',
    handler(args, ctx) {
      if (args.length === 0) {
        // Show current config (mask API keys)
        const lines = [
          `provider:     ${ctx.runtime.provider}`,
          `model:        ${ctx.runtime.model}`,
          `autoApprove:  ${ctx.config.autoApprove}`,
          `workingDir:   ${ctx.config.workingDir}`,
          `systemPrompt: ${ctx.runtime.systemPrompt ? ctx.runtime.systemPrompt.slice(0, 60) + '...' : '(none)'}`,
          `debug:        ${ctx.runtime.debugMode}`,
        ];
        ctx.print(lines.join('\n'));
      } else if (args.length === 1) {
        ctx.print(`Usage: /config <key> <value>`);
      } else {
        const [key, ...rest] = args;
        const value = rest.join(' ');
        switch (key) {
          case 'system':
          case 'systemPrompt':
            ctx.runtime.systemPrompt = value;
            saveConfigKey('systemPrompt', value);
            ctx.print(`System prompt updated.`);
            break;
          case 'model':
            try {
              ctx.providerRegistry.setCurrentModel(value);
              const def = ctx.providerRegistry.getCurrentModel();
              ctx.runtime.model = def.id;
              ctx.runtime.provider = def.provider;
              saveConfigKey('model', value);
              ctx.print(`Model set to: ${def.displayName}`);
            } catch (e) {
              ctx.print(`Error: ${(e as Error).message}`);
            }
            break;
          default:
            ctx.print(`Unknown config key: ${key}`);
        }
      }
    },
  });

  // ── /tools ───────────────────────────────────────────────────────────────
  registry.register({
    name: 'tools',
    aliases: ['t'],
    description: 'List available tools',
    handler(_args, ctx) {
      // Tools are accessible via the orchestrator; we emit an event to request the list
      // For now, show the registered tool names from config context
      const toolNames = [
        'file-read', 'file-write', 'file-edit',
        'shell-exec', 'grep', 'list-dir', 'glob',
      ];
      const lines = ['Available tools:', ...toolNames.map(n => `  • ${n}`)];
      ctx.print(lines.join('\n'));
    },
  });

  // ── /provider ────────────────────────────────────────────────────────────
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
        // Find a selectable model for the requested provider
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
          saveConfigKey('provider', providerName);
          saveConfigKey('model', match.id);
          ctx.print(`Switched to provider: ${providerName} (model: ${match.id})`);
          ctx.eventBus.emit('command:model-changed', { provider: providerName, model: match.id });
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      }
    },
  });

  // ── /quit ────────────────────────────────────────────────────────────────
  registry.register({
    name: 'quit',
    aliases: ['q', ':q'],
    description: 'Exit the application',
    handler(_args, ctx) {
      ctx.exit();
    },
  });

  // ── /debug ───────────────────────────────────────────────────────────────
  registry.register({
    name: 'debug',
    aliases: [],
    description: 'Toggle debug mode',
    handler(_args, ctx) {
      ctx.runtime.debugMode = !ctx.runtime.debugMode;
      ctx.print(`Debug mode: ${ctx.runtime.debugMode ? 'ON' : 'OFF'}`);
    },
  });
}

/**
 * saveConfigKey - Persist a single config key to the global config file.
 * Creates the directory and file if they don't exist.
 */
export function saveConfigKey(key: string, value: string): void {
  try {
    const configDir = join(homedir(), '.config', 'goodvibes');
    const configPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(configPath)) {
        existing = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }
    } catch { /* file may not exist yet or may be malformed */ }
    existing[key] = value;
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  } catch { /* non-fatal: config save failure */ }
}
