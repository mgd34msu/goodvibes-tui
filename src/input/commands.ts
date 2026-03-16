import type { CommandRegistry, CommandContext } from './command-registry.ts';
import type { SelectionItem } from './selection-modal.ts';
import type { ConfigKey } from '../config/index.ts';
import { CONFIG_SCHEMA } from '../config/index.ts';
import { REASONING_BUDGET_MAP } from '../providers/interface.ts';
import { join } from 'path';
import { unlinkSync } from 'node:fs';
import { getSessionManager } from '../sessions/manager.ts';
import { TemplateManager, parseTemplateArgs } from '../templates/manager.ts';
import { getBookmarkManager } from '../bookmarks/manager.ts';
import { getProfileManager } from '../profiles/manager.ts';
import type { BlockMeta } from '../core/conversation.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import { getSecretsManager } from '../config/secrets.ts';

let _templateManager: TemplateManager | undefined;
function getTemplateManager(): TemplateManager {
  if (!_templateManager) _templateManager = new TemplateManager();
  return _templateManager;
}

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
        // Open the interactive model picker if available, else fall back to list
        if (ctx.openModelPicker) {
          ctx.openModelPicker();
        } else {
          const models = ctx.providerRegistry.getSelectableModels();
          const current = ctx.runtime.model;
          const lines = ['Available models:', ...models.map(m =>
            `  ${m.id === current ? '▶' : ' '} ${m.id.padEnd(36)} ${m.displayName} (${m.provider})`
          )];
          ctx.print(lines.join('\n'));
        }
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
      // Prefer dedicated help overlay if available
      if (ctx.openHelpOverlay) {
        ctx.openHelpOverlay();
        return;
      }
      if (ctx.openSelection) {
        const items: import('./selection-modal.ts').SelectionItem[] = [
          // Model & Provider
          { id: '/model', label: '/model [id]', detail: 'Select LLM model', category: 'Model & Provider' },
          { id: '/provider', label: '/provider [name]', detail: 'Switch provider', category: 'Model & Provider' },
          { id: '/effort', label: '/effort [level]', detail: 'Reasoning effort (instant/low/medium/high)', category: 'Model & Provider' },
          // Config & Display
          { id: '/config', label: '/config [key] [value]', detail: 'Show or set config values', category: 'Config & Display' },
          { id: '/config diff', label: '/config diff', detail: 'Show changed settings', category: 'Config & Display' },
          { id: '/config reset', label: '/config reset [key]', detail: 'Reset to defaults', category: 'Config & Display' },
          { id: '/config profile', label: '/config profile ...', detail: 'Save/load/list/delete profiles', category: 'Config & Display' },
          { id: '/debug', label: '/debug', detail: 'Toggle debug mode', category: 'Config & Display' },
          { id: '/lines', label: '/lines', detail: 'Toggle line numbers', category: 'Config & Display' },
          { id: '/expand', label: '/expand [type]', detail: 'Expand blocks (all|thinking|tool|code)', category: 'Config & Display' },
          { id: '/collapse', label: '/collapse [type]', detail: 'Collapse blocks', category: 'Config & Display' },
          { id: '/bookmarks', label: '/bookmarks', detail: 'List bookmarked blocks', category: 'Config & Display' },
          // Conversation
          { id: '/clear', label: '/clear', detail: 'Clear display (keep context)', category: 'Conversation' },
          { id: '/reset', label: '/reset', detail: 'Clear display + context', category: 'Conversation' },
          { id: '/compact', label: '/compact', detail: 'Summarize to free context', category: 'Conversation' },
          { id: '/export', label: '/export [file]', detail: 'Export as markdown', category: 'Conversation' },
          { id: '/title', label: '/title [text]', detail: 'Show or set title', category: 'Conversation' },
          { id: '/save', label: '/save [name]', detail: 'Save session', category: 'Conversation' },
          { id: '/load', label: '/load <name>', detail: 'Load session', category: 'Conversation' },
          { id: '/sessions', label: '/sessions', detail: 'List saved sessions', category: 'Conversation' },
          { id: '/undo', label: '/undo', detail: 'Remove last turn', category: 'Conversation' },
          { id: '/redo', label: '/redo', detail: 'Restore undone turn', category: 'Conversation' },
          { id: '/retry', label: '/retry [text]', detail: 'Re-send last message', category: 'Conversation' },
          // Templates
          { id: '/template', label: '/template', detail: 'Browse templates', category: 'Templates' },
          { id: '/template save', label: '/template save <name>', detail: 'Save prompt as template', category: 'Templates' },
          { id: '/template use', label: '/template use <name>', detail: 'Execute template', category: 'Templates' },
          // Tools & System
          { id: '/tools', label: '/tools', detail: 'List available tools', category: 'Tools & System' },
          { id: '/permissions', label: '/permissions', detail: 'Permission settings', category: 'Tools & System' },
          { id: '/secrets', label: '/secrets set|get|list|delete', detail: 'Manage encrypted API key secrets', category: 'Tools & System' },
          { id: '/help', label: '/help', detail: 'This help', category: 'Tools & System' },
          { id: '/quit', label: '/quit', detail: 'Exit', category: 'Tools & System' },
          // Keyboard shortcuts
          { id: 'k:enter', label: 'Enter', detail: 'Send message', category: 'Keyboard Shortcuts' },
          { id: 'k:shift-enter', label: 'Shift+Enter', detail: 'Insert newline', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-c', label: 'Ctrl+C x2', detail: 'Exit', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-l', label: 'Ctrl+L', detail: 'Clear screen', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-u', label: 'Ctrl+U', detail: 'Clear prompt line', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-f', label: 'Ctrl+F', detail: 'Search conversation', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-z', label: 'Ctrl+Z', detail: 'Undo prompt edit', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-sz', label: 'Ctrl+Shift+Z', detail: 'Redo prompt edit', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-v', label: 'Ctrl+V', detail: 'Paste (image or text)', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-y', label: 'Ctrl+Y', detail: 'Copy nearest block', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-a', label: 'Ctrl+A', detail: 'Apply nearest diff', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-b', label: 'Ctrl+B', detail: 'Bookmark block', category: 'Keyboard Shortcuts' },
          { id: 'k:ctrl-s', label: 'Ctrl+S', detail: 'Save block to file', category: 'Keyboard Shortcuts' },
          { id: 'k:tab', label: 'Tab', detail: 'Toggle collapse / path completion', category: 'Keyboard Shortcuts' },
          { id: 'k:page', label: 'PageUp/Down', detail: 'Scroll by page', category: 'Keyboard Shortcuts' },
          { id: 'k:arrows', label: 'Arrow Up/Down', detail: 'Scroll / history recall', category: 'Keyboard Shortcuts' },
          { id: 'k:mouse', label: 'Mouse wheel', detail: 'Scroll', category: 'Keyboard Shortcuts' },
          { id: 'k:middle', label: 'Middle click', detail: 'Paste', category: 'Keyboard Shortcuts' },
          { id: 'k:drag', label: 'Click drag', detail: 'Select text', category: 'Keyboard Shortcuts' },
          { id: 'k:copy', label: 'Ctrl+Shift+C', detail: 'Copy selection', category: 'Keyboard Shortcuts' },
        ];
        ctx.openSelection('Help  —  Commands & Shortcuts', items, { allowSearch: true }, (result) => {
          if (!result) return;
          // Keyboard shortcuts (id starts with 'k:') are informational only
          if (result.item.id.startsWith('k:')) return;
          // Execute the selected command through the command registry
          const cmd = result.item.id;
          if (cmd.startsWith('/')) {
            const parts = cmd.slice(1).trim().split(/\s+/);
            const name = parts[0];
            const cmdArgs = parts.slice(1);
            void registry.execute(name, cmdArgs, ctx);
            ctx.eventBus.emit('command:execute', { name, args: cmdArgs });
          }
        });
        return;
      }
      // Fallback: print text
      ctx.print('Use /help to open the help modal. Commands: /model, /provider, /config, /template, /tools, /permissions, /sessions, /bookmarks, /save, /load, /undo, /redo, /retry, /clear, /reset, /compact, /export, /title, /effort, /lines, /expand, /collapse, /debug, /quit');
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

      // /config profile save|load|list|delete
      if (args[0] === 'profile') {
        const sub = args[1];
        const profileName = args[2];
        const pm = getProfileManager();
        const currentConfig = cm.getAll();

        if (!sub || sub === 'list') {
          const profiles = pm.list();
          if (profiles.length === 0) {
            ctx.print('No saved profiles.\nUse /config profile save <name> to save current settings.');
            return;
          }
          const lines = ['Saved profiles:', ''];
          for (const p of profiles) {
            const date = new Date(p.timestamp).toLocaleString();
            lines.push(`  ${p.name.padEnd(28)} ${date}`);
          }
          ctx.print(lines.join('\n'));
          return;
        }

        if (sub === 'save') {
          if (!profileName) {
            ctx.print('Usage: /config profile save <name>');
            return;
          }
          try {
            const data = {
              display: currentConfig.display,
              provider: { model: currentConfig.provider.model, reasoningEffort: currentConfig.provider.reasoningEffort },
              behavior: currentConfig.behavior,
            };
            const filePath = pm.save(profileName, data);
            ctx.print(`Profile saved: ${profileName}\n  → ${filePath}`);
          } catch (e) {
            ctx.print(`Failed to save profile: ${(e as Error).message}`);
          }
          return;
        }

        if (sub === 'load') {
          if (!profileName) {
            ctx.print('Usage: /config profile load <name>');
            return;
          }
          try {
            const { data } = pm.load(profileName);
            // Apply display settings
            if (data.display) {
              for (const [field, val] of Object.entries(data.display)) {
                try {
                  cm.set(`display.${field}` as Parameters<typeof cm.set>[0], val as never);
                } catch (e) { ctx.print(`Warning: failed to apply display.${field}: ${(e as Error).message}`); }
              }
            }
            // Apply behavior settings
            if (data.behavior) {
              for (const [field, val] of Object.entries(data.behavior)) {
                try {
                  cm.set(`behavior.${field}` as Parameters<typeof cm.set>[0], val as never);
                } catch (e) { ctx.print(`Warning: failed to apply behavior.${field}: ${(e as Error).message}`); }
              }
            }
            // Apply provider settings (model + reasoningEffort only)
            if (data.provider) {
              if (data.provider.model && typeof data.provider.model === 'string') {
                try {
                  ctx.providerRegistry.setCurrentModel(data.provider.model);
                  const def = ctx.providerRegistry.getCurrentModel();
                  ctx.runtime.model = def.id;
                  ctx.runtime.provider = def.provider;
                  cm.set('provider.model', def.id);
                  cm.set('provider.provider', def.provider);
                } catch { /* skip invalid model */ }
              }
              if (data.provider.reasoningEffort && typeof data.provider.reasoningEffort === 'string') {
                ctx.runtime.reasoningEffort = data.provider.reasoningEffort;
                cm.set('provider.reasoningEffort', data.provider.reasoningEffort);
              }
            }
            ctx.print(`Profile loaded: ${profileName}`);
            ctx.renderRequest();
          } catch (e) {
            ctx.print(`Failed to load profile: ${(e as Error).message}`);
          }
          return;
        }

        if (sub === 'delete') {
          if (!profileName) {
            ctx.print('Usage: /config profile delete <name>');
            return;
          }
          const deleted = pm.delete(profileName);
          if (deleted) {
            ctx.print(`Profile deleted: ${profileName}`);
          } else {
            ctx.print(`Profile not found: ${profileName}`);
          }
          return;
        }

        ctx.print(`Unknown profile subcommand: ${sub}\nUsage: /config profile save|load|list|delete <name>`);
        return;
      }

      // /config diff — show settings that differ from defaults
      if (args[0] === 'diff') {
        const diffs: string[] = [];
        for (const setting of CONFIG_SCHEMA) {
          const currentVal = cm.get(setting.key as ConfigKey);
          const defaultVal = setting.default;
          // JSON.stringify comparison is safe here: all config values are primitives (boolean, number, string)
          if (JSON.stringify(currentVal) !== JSON.stringify(defaultVal)) {
            diffs.push(`  ${setting.key.padEnd(36)} ${String(defaultVal)} → ${String(currentVal)}`);
          }
        }
        if (diffs.length === 0) {
          ctx.print('All settings at defaults.');
        } else {
          ctx.print(['Settings changed from defaults:', ...diffs].join('\n'));
        }
        return;
      }

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

      // /config (no args) — open modal if available, else show text listing
      if (args.length === 0) {
        if (ctx.openSelection) {
          const items: SelectionItem[] = [];
          for (const cat of categories) {
            const catObj = all[cat] as Record<string, unknown>;
            for (const [field, val] of Object.entries(catObj)) {
              const key = `${cat}.${field}`;
              const schema = CONFIG_SCHEMA.find(s => s.key === key);
              items.push({
                id: key,
                label: key,
                detail: String(val),
                category: cat,
                actions: schema ? `[type] description: ${schema.description}` : undefined,
              });
            }
          }
          const spaceAction = new Map<string, import('./selection-modal.ts').SelectionAction>([[' ', 'toggle']]);
          ctx.openSelection('Config Settings  [Space] toggle/cycle', items, { allowSearch: true, customActions: spaceAction }, (result) => {
            if (!result) return;
            const key = result.item.id as import('../config/index.ts').ConfigKey;
            const schema = CONFIG_SCHEMA.find(s => s.key === key);
            if (result.action === 'toggle' && schema) {
              // Toggle boolean or cycle enum — update value and refresh item detail in-place
              const currentVal = cm.get(key);
              let newVal: unknown = currentVal;
              if (schema.type === 'boolean') {
                newVal = !currentVal;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                cm.set(key, newVal as any);
              } else if (schema.type === 'enum' && schema.enumValues) {
                const idx = schema.enumValues.indexOf(String(currentVal));
                newVal = schema.enumValues[(idx + 1) % schema.enumValues.length];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                cm.set(key, newVal as any);
                if (key === 'provider.reasoningEffort') ctx.runtime.reasoningEffort = String(newVal);
              }
              // Update the item's detail text so the modal shows the new value
              result.item.detail = String(newVal);
              ctx.renderRequest();
              return; // Don't close — stay in modal
            } else {
              // Select = show detail
              const val = cm.get(key);
              const defaultVal = schema ? schema.default : '?';
              const lines = [
                `${key}`,
                `  value:   ${String(val)}`,
                `  default: ${String(defaultVal)}`,
                `  type:    ${schema ? schema.type : 'unknown'}${schema?.enumValues ? ` (${schema.enumValues.join(', ')})` : ''}`,
                `  desc:    ${schema ? schema.description : ''}`,
              ];
              ctx.print(lines.join('\n'));
            }
          });
          return;
        }
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
      if (ctx.openSelection) {
        const items: SelectionItem[] = tools.map(t => ({
          id: t.definition.name,
          label: t.definition.name,
          detail: typeof t.definition.description === 'string'
            ? t.definition.description.slice(0, 50)
            : '',
        }));
        ctx.openSelection('Available Tools', items, { allowSearch: true }, (result) => {
          if (!result) return;
          const tool = tools.find(t2 => t2.definition.name === result.item.id);
          if (tool) {
            ctx.print(`Tool: ${tool.definition.name}\n  ${tool.definition.description ?? ''}`);
          }
        });
        return;
      }
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
        // Open the interactive provider picker if available, else fall back to list
        if (ctx.openProviderPicker) {
          ctx.openProviderPicker();
          return;
        }
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

  // ── /save ─────────────────────────────────────────────
  registry.register({
    name: 'save',
    aliases: [],
    description: 'Save current session to .goodvibes/tui/sessions/',
    usage: '[name]',
    handler(args, ctx) {
      const sessionManager = getSessionManager();
      const rawName = args[0] || ctx.conversationManager.title || `session-${Date.now()}`;
      const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
      const messages = exportData.messages ?? [];
      const meta = {
        title: ctx.conversationManager.title,
        model: ctx.runtime.model,
        provider: ctx.runtime.provider,
        timestamp: Date.now(),
      };
      try {
        const { filePath, sanitizedName } = sessionManager.save(rawName, messages, meta);
        const nameNote = sanitizedName !== rawName ? ` (saved as "${sanitizedName}")` : '';
        ctx.print(`Session saved: ${rawName}${nameNote}\n  → ${filePath}`);
      } catch (e) {
        ctx.print(`Failed to save session: ${(e as Error).message}`);
      }
    },
  });

  // ── /load ─────────────────────────────────────────────
  registry.register({
    name: 'load',
    aliases: [],
    description: 'Load a saved session',
    usage: '<name>',
    handler(args, ctx) {
      if (!args[0]) {
        ctx.print('Usage: /load <session-name>\nRun /sessions to list available sessions.');
        return;
      }
      const sessionManager = getSessionManager();
      try {
        const { meta, messages } = sessionManager.load(args[0]);
        ctx.conversationManager.resetAll();
        ctx.conversationManager.fromJSON({ messages: messages as never[] });
        if (meta.title) ctx.conversationManager.title = meta.title;
        ctx.conversationManager.rebuildHistory();
        ctx.renderRequest();
        ctx.print(`Session loaded: ${args[0]} (${messages.length} messages)`);
      } catch (e) {
        ctx.print(`Failed to load session: ${(e as Error).message}`);
      }
    },
  });

  // ── /undo ──────────────────────────────────────────────
  registry.register({
    name: 'undo',
    aliases: ['u'],
    description: 'Remove the last user+assistant turn',
    handler(_args, ctx) {
      const success = ctx.conversationManager.undo();
      if (success) {
        ctx.print('Last turn undone. Use /redo to restore.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to undo.');
      }
    },
  });

  // ── /redo ──────────────────────────────────────────────
  registry.register({
    name: 'redo',
    aliases: [],
    description: 'Restore the last undone turn',
    handler(_args, ctx) {
      const success = ctx.conversationManager.redo();
      if (success) {
        ctx.print('Turn restored.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to redo.');
      }
    },
  });

  // ── /retry ─────────────────────────────────────────────
  registry.register({
    name: 'retry',
    aliases: ['r'],
    description: 'Re-send the last user message',
    usage: '[modified text]',
    handler(args, ctx) {
      const lastMsg = ctx.conversationManager.getLastUserMessage();
      if (!lastMsg) {
        ctx.print('No message to retry.');
        return;
      }
      // Remove the last turn (user + response)
      ctx.conversationManager.undo();
      // Use modified text if provided, otherwise original
      const retryText = args.length > 0 ? args.join(' ') : lastMsg;
      // Submit as new input
      ctx.eventBus.emit('input:submit', { text: retryText });
    },
  });

  // ── /sessions ─────────────────────────────────────────
  registry.register({
    name: 'sessions',
    aliases: [],
    description: 'List saved sessions',
    async handler(_args, ctx) {
      const sessionManager = getSessionManager();
      const sessions = sessionManager.list();
      if (ctx.openSelection) {
        const deleteAction = new Map([['d', 'delete' as const]]);
        const items: SelectionItem[] = sessions.length === 0
          ? [{ id: '_empty', label: 'No saved sessions', detail: 'Use /save [name] to save' }]
          : sessions.map(s => ({
            id: s.name,
            label: s.name,
            detail: s.title || '(untitled)',
            actions: '[d] delete',
          }));
        ctx.openSelection('Sessions', items, { allowSearch: true, customActions: deleteAction }, (result) => {
          if (!result) return;
          if (result.action === 'delete') {
            try {
              const sessionInfo = sessions.find(s => s.name === result.item.id);
              if (sessionInfo) {
                unlinkSync(sessionInfo.filePath);
                ctx.print(`Session deleted: ${result.item.id}`);
              }
            } catch (e) {
              ctx.print(`Failed to delete session: ${(e as Error).message}`);
            }
          } else {
            // select = load
            try {
              const { meta, messages } = sessionManager.load(result.item.id);
              ctx.conversationManager.resetAll();
              ctx.conversationManager.fromJSON({ messages: messages as never[] });
              if (meta.title) ctx.conversationManager.title = meta.title;
              ctx.conversationManager.rebuildHistory();
              ctx.renderRequest();
              ctx.print(`Session loaded: ${result.item.id} (${messages.length} messages)`);
            } catch (e) {
              ctx.print(`Failed to load session: ${(e as Error).message}`);
            }
          }
        });
        return;
      }
      const lines = ['Saved sessions:', ''];
      for (const s of sessions) {
        const date = new Date(s.timestamp).toLocaleString();
        const title = s.title || '(untitled)';
        lines.push(`  ${s.name.padEnd(30)} ${title.padEnd(24)} ${date}  (${s.messageCount} msgs)`);
      }
      ctx.print(lines.join('\n'));
    },
  });

  // ── /template ───────────────────────────────────────
  registry.register({
    name: 'template',
    aliases: ['tmpl'],
    description: 'Manage and use prompt templates',
    usage: 'save <name> | use <name> [args] | list | edit <name> | delete <name>',
    handler(args, ctx) {
      const sub = args[0];
      const rest = args.slice(1);

      if (!sub || sub === 'list') {
        const templates = getTemplateManager().list();
        if (ctx.openSelection) {
          const deleteAction = new Map([['d', 'delete' as const], ['e', 'edit' as const]]);
          const items: SelectionItem[] = templates.length === 0
            ? [{ id: '_empty', label: 'No templates saved', detail: 'Use /template save <name>' }]
            : templates.map(t => ({
              id: t.name,
              label: t.name,
              detail: t.preview,
              category: t.scope === 'project' ? 'project' : 'global',
              actions: '[d] delete  [e] edit',
            }));
          ctx.openSelection('Templates', items, { allowSearch: true, customActions: deleteAction }, (result) => {
            if (!result) return;
            if (result.action === 'delete') {
              const deleted = getTemplateManager().delete(result.item.id);
              ctx.print(deleted ? `Template deleted: ${result.item.id}` : `Template not found: ${result.item.id}`);
            } else if (result.action === 'edit') {
              const content = getTemplateManager().load(result.item.id);
              if (content !== null) {
                ctx.print(`Template: ${result.item.id}\n\n${content}`);
              } else {
                ctx.print(`Template not found: ${result.item.id}`);
              }
            } else {
              // select = use template
              const content = getTemplateManager().load(result.item.id);
              if (content !== null) {
                ctx.eventBus.emit('input:submit', { text: content });
              } else {
                ctx.print(`Template not found: ${result.item.id}`);
              }
            }
          });
          return;
        }
        const lines = ['Templates:', ''];
        for (const t of templates) {
          const scopeTag = t.scope === 'project' ? '[project]' : '[global] ';
          lines.push(`  ${scopeTag} ${t.name.padEnd(28)} ${t.preview}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'save') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template save <name>');
          return;
        }
        const lastMsg = ctx.conversationManager.getLastUserMessage();
        const content = lastMsg || '# Template\n\nReplace this with your template content.\n';
        try {
          getTemplateManager().save(name, content);
          ctx.print(`Template saved: ${name}`);
        } catch (e) {
          ctx.print(`Failed to save template: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'use') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template use <name> [args...]');
          return;
        }
        const templateContent = getTemplateManager().load(name);
        if (templateContent === null) {
          ctx.print(`Template not found: ${name}\nRun /template list to see available templates.`);
          return;
        }
        const templateArgs = parseTemplateArgs(rest.slice(1));
        const expanded = getTemplateManager().expand(templateContent, templateArgs);
        ctx.eventBus.emit('input:submit', { text: expanded });
        return;
      }

      if (sub === 'edit') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template edit <name>');
          return;
        }
        const content = getTemplateManager().load(name);
        if (content === null) {
          ctx.print(`Template not found: ${name}`);
          return;
        }
        ctx.print(`Template: ${name}\n\n${content}`);
        return;
      }

      if (sub === 'delete') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template delete <name>');
          return;
        }
        const deleted = getTemplateManager().delete(name);
        if (deleted) {
          ctx.print(`Template deleted: ${name}`);
        } else {
          ctx.print(`Template not found: ${name}`);
        }
        return;
      }

      ctx.print(`Unknown subcommand: ${sub}\nUsage: /template save|use|list|edit|delete`);
    },
  });

  // ── /permissions ───────────────────────────────────
  registry.register({
    name: 'permissions',
    aliases: ['perms'],
    description: 'Show or set permission mode and per-tool settings',
    usage: '[allow-all|prompt|custom] | [tool <name> allow|prompt|deny]',
    handler(args, ctx) {
      const cm = ctx.configManager;
      const VALID_MODES = ['allow-all', 'prompt', 'custom'] as const;
      const VALID_ACTIONS = ['allow', 'prompt', 'deny'] as const;
      const VALID_TOOLS = ['file_read', 'file_write', 'file_edit', 'shell_exec', 'grep', 'list_dir', 'glob', 'delegate'] as const;
      type PermTool = typeof VALID_TOOLS[number];

      if (args.length === 0) {
        if (ctx.openSelection) {
          const cycleActions = new Map([['enter', 'toggle' as const]]);
          const items: SelectionItem[] = VALID_TOOLS.map(tool => {
            const toolKey = `permissions.tools.${tool}` as Parameters<typeof cm.get>[0];
            const action = cm.get(toolKey) as string;
            return {
              id: tool,
              label: tool,
              detail: action,
              category: 'tools',
              actions: '[Enter] cycle allow/prompt/deny',
            };
          });
          // Also add the mode item at the top
          const mode = cm.get('permissions.mode') as string;
          items.unshift({
            id: '__mode__',
            label: 'permission mode',
            detail: mode,
            category: 'global',
            actions: '[Enter] cycle allow-all/prompt/custom',
          });
          ctx.openSelection('Permissions', items, { allowSearch: true, customActions: cycleActions }, (result) => {
            if (!result) return;
            if (result.item.id === '__mode__') {
              const currentMode = cm.get('permissions.mode') as string;
              const nextMode = VALID_MODES[(VALID_MODES.indexOf(currentMode as typeof VALID_MODES[number]) + 1) % VALID_MODES.length];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              cm.set('permissions.mode', nextMode as any);
              result.item.detail = nextMode;
              ctx.renderRequest();
              return; // Stay in modal
            } else {
              const toolKey = `permissions.tools.${result.item.id}` as Parameters<typeof cm.get>[0];
              const currentAction = cm.get(toolKey) as string;
              const nextAction = VALID_ACTIONS[(VALID_ACTIONS.indexOf(currentAction as typeof VALID_ACTIONS[number]) + 1) % VALID_ACTIONS.length];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              cm.set(toolKey as Parameters<typeof cm.set>[0], nextAction as any);
              result.item.detail = nextAction;
              ctx.renderRequest();
              return; // Stay in modal
            }
          });
          return;
        }
        const mode = cm.get('permissions.mode');
        const lines = [`Permission mode: ${mode}`, '  Tool settings:'];
        for (const tool of VALID_TOOLS) {
          const toolKey = `permissions.tools.${tool}` as Parameters<typeof cm.get>[0];
          const action = cm.get(toolKey);
          lines.push(`    ${tool.padEnd(16)} ${action}`);
        }
        lines.push('');
        lines.push('  Modes: prompt (default), allow-all, custom');
        lines.push('  Usage: /permissions <mode> | /permissions tool <name> allow|prompt|deny');
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
          const toolKey = `permissions.tools.${toolName}` as Parameters<typeof cm.set>[0];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cm.set(toolKey, action as any);
          ctx.print(`Permission for ${toolName} set to: ${action}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }

      const newMode = args[0];
      if (!VALID_MODES.includes(newMode as typeof VALID_MODES[number])) {
        ctx.print(`Invalid mode: ${newMode}\nValid modes: ${VALID_MODES.join(', ')}`);
        return;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cm.set('permissions.mode', newMode as any);
        ctx.print(`Permission mode set to: ${newMode}`);
      } catch (e) {
        ctx.print(`Error: ${(e as Error).message}`);
      }
    },
  });

  // ── /expand ────────────────────────────────────────────
  registry.register({
    name: 'expand',
    aliases: [],
    description: 'Expand blocks by type',
    usage: '[all|thinking|tool|code]',
    handler(args, ctx) {
      const typeFilter = args[0] || 'all';
      const VALID_TYPES = ['all', 'thinking', 'tool', 'code'] as const;
      if (!VALID_TYPES.includes(typeFilter as typeof VALID_TYPES[number])) {
        ctx.print(`Unknown type: ${typeFilter}\nValid types: ${VALID_TYPES.join(', ')}`);
        return;
      }
      const registry = ctx.conversationManager.getBlockRegistry();
      if (!registry || registry.length === 0) {
        ctx.print('No blocks found.');
        return;
      }
      let count = 0;
      for (let i = 0; i < registry.length; i++) {
        const block = registry[i];
        const matchesType = typeFilter === 'all' ||
          (typeFilter === 'tool' && block.type === 'tool') ||
          (typeFilter === 'code' && block.type === 'code') ||
          (typeFilter === 'thinking' && block.type === 'thinking');
        if (!matchesType) continue;
        if (ctx.conversationManager.isCollapsed(i)) {
          ctx.conversationManager.toggleCollapseAtLine(block.startLine);
          count++;
        }
      }
      ctx.print(`Expanded ${count} block${count !== 1 ? 's' : ''}${typeFilter !== 'all' ? ` (${typeFilter})` : ''}.`);
      ctx.renderRequest();
    },
  });

  // ── /collapse ──────────────────────────────────────────
  registry.register({
    name: 'collapse',
    aliases: [],
    description: 'Collapse blocks by type',
    usage: '[all|thinking|tool|code]',
    handler(args, ctx) {
      const typeFilter = args[0] || 'all';
      const VALID_TYPES = ['all', 'thinking', 'tool', 'code'] as const;
      if (!VALID_TYPES.includes(typeFilter as typeof VALID_TYPES[number])) {
        ctx.print(`Unknown type: ${typeFilter}\nValid types: ${VALID_TYPES.join(', ')}`);
        return;
      }
      const registry = ctx.conversationManager.getBlockRegistry();
      if (!registry || registry.length === 0) {
        ctx.print('No blocks found.');
        return;
      }
      let count = 0;
      for (let i = 0; i < registry.length; i++) {
        const block = registry[i];
        const matchesType = typeFilter === 'all' ||
          (typeFilter === 'tool' && block.type === 'tool') ||
          (typeFilter === 'code' && block.type === 'code') ||
          (typeFilter === 'thinking' && block.type === 'thinking');
        if (!matchesType) continue;
        if (!ctx.conversationManager.isCollapsed(i)) {
          ctx.conversationManager.toggleCollapseAtLine(block.startLine);
          count++;
        }
      }
      ctx.print(`Collapsed ${count} block${count !== 1 ? 's' : ''}${typeFilter !== 'all' ? ` (${typeFilter})` : ''}.`);
      ctx.renderRequest();
    },
  });

  // ── /bookmarks ─────────────────────────────────────────
  registry.register({
    name: 'bookmarks',
    aliases: ['bm'],
    description: 'List bookmarked blocks',
    handler(_args, ctx) {
      // Prefer dedicated bookmark modal if available
      if (ctx.openBookmarkModal) {
        ctx.openBookmarkModal();
        return;
      }
      const bm = getBookmarkManager();
      const entries = bm.list();
      if (ctx.openSelection) {
        const deleteAction = new Map([['d', 'delete' as const]]);
        const items: SelectionItem[] = entries.length === 0
          ? [{ id: '_empty', label: 'No bookmarks', detail: 'Use Ctrl+B to bookmark' }]
          : entries.map(entry => ({
            id: entry.key,
            label: entry.label,
            detail: new Date(entry.timestamp).toLocaleTimeString(),
            actions: '[d] delete',
          }));
        ctx.openSelection('Bookmarks', items, { allowSearch: true, customActions: deleteAction }, (result) => {
          if (!result) return;
          if (result.action === 'delete') {
            bm.toggle(result.item.id); // toggle off (removes it)
            ctx.print(`Bookmark removed: ${result.item.id}`);
          } else {
            // select = scroll to bookmark
            ctx.eventBus.emit('bookmark:jump', { key: result.item.id });
          }
        });
        return;
      }
      const lines = ['Bookmarks:', ''];
      for (const entry of entries) {
        const date = new Date(entry.timestamp).toLocaleTimeString();
        lines.push(`  ${entry.key.padEnd(32)} ${entry.label}  (${date})`);
      }
      ctx.print(lines.join('\n'));
    },
  });

  // ── /secrets ──────────────────────────────────────────────
  registry.register({
    name: 'secrets',
    description: 'Manage encrypted API key secrets',
    usage: 'set <KEY> <value> | get <KEY> | list | delete <KEY>',
    async handler(args, ctx) {
      const mgr = getSecretsManager();
      const [sub, ...rest] = args;

      if (!sub || sub === 'list') {
        const keys = await mgr.list();
        if (keys.length === 0) {
          ctx.print('[secrets] No secrets stored. Use: /secrets set <KEY> <value>');
        } else {
          ctx.print(['[secrets] Stored keys (values are encrypted at rest):', ...keys.map(k => `  ${k}`)].join('\n'));
        }
        return;
      }

      if (sub === 'set') {
        const [key, ...valueParts] = rest;
        if (!key || valueParts.length === 0) {
          ctx.print('[secrets] Usage: /secrets set <KEY> <value>');
          return;
        }
        const value = valueParts.join(' ');
        await mgr.set(key, value);
        ctx.print(`[secrets] Stored: ${key} (encrypted at rest)`);
        return;
      }

      if (sub === 'get') {
        const [key] = rest;
        if (!key) {
          ctx.print('[secrets] Usage: /secrets get <KEY>');
          return;
        }
        const value = await mgr.get(key);
        if (value === null) {
          ctx.print(`[secrets] Not found: ${key}`);
        } else {
          ctx.print(`[secrets] ${key} = <stored> (use /secrets list to see all keys)`);
        }
        return;
      }

      if (sub === 'delete') {
        const [key] = rest;
        if (!key) {
          ctx.print('[secrets] Usage: /secrets delete <KEY>');
          return;
        }
        await mgr.delete(key);
        ctx.print(`[secrets] Deleted: ${key}`);
        return;
      }

      ctx.print('[secrets] Usage: /secrets set <KEY> <value> | get <KEY> | list | delete <KEY>');
    },
  });

  // ── /services ──────────────────────────────────────────────
  registry.register({
    name: 'services',
    aliases: ['svc'],
    description: 'Manage API service configurations',
    handler(_args, ctx) {
      const svcRegistry = new ServiceRegistry();
      const all = svcRegistry.getAll();
      const keys = Object.keys(all);

      if (ctx.openSelection) {
        const testAction = new Map<string, import('./selection-modal.ts').SelectionAction>([
          ['t', 'select' as const],
        ]);
        const items: SelectionItem[] = keys.length === 0
          ? [{ id: '_empty', label: 'No services configured', detail: '.goodvibes/tui/services.json' }]
          : keys.map((key) => {
              const svc = all[key];
              return {
                id: key,
                label: svc.name ?? key,
                detail: `${svc.authType}  ${svc.baseUrl ?? '(no url)'}`,
                actions: '[t] test',
              };
            });

        ctx.openSelection('Services', items, { allowSearch: true, customActions: testAction }, (result) => {
          if (!result || result.item.id === '_empty') return;
          // Test action: attempt GET to baseUrl/health
          const svc = all[result.item.id];
          if (!svc) return;
          const baseUrl = svc.baseUrl ?? '';
          if (!baseUrl) {
            ctx.print(`[services] ${result.item.id}: no baseUrl configured`);
            return;
          }
          const testUrl = baseUrl.replace(/\/$/, '') + '/health';
          ctx.print(`[services] Testing ${result.item.id} → GET ${testUrl} …`);
          void svcRegistry.resolveAuth(result.item.id).then(async (headers) => {
            const reqHeaders: Record<string, string> = {
              Accept: 'application/json',
              ...(headers ?? {}),
            };
            try {
              const resp = await fetch(testUrl, {
                method: 'GET',
                headers: reqHeaders,
                signal: AbortSignal.timeout(5000),
              });
              ctx.print(`[services] ${result.item.id}: HTTP ${resp.status} ${resp.ok ? '\u2713 OK' : '\u2717 error'}`);
            } catch (err) {
              // Fallback to baseUrl
              try {
                const resp2 = await fetch(baseUrl, {
                  method: 'GET',
                  headers: reqHeaders,
                  signal: AbortSignal.timeout(5000),
                });
                ctx.print(`[services] ${result.item.id}: HTTP ${resp2.status} ${resp2.ok ? '\u2713 OK' : '\u2717 error'}`);
              } catch (err2) {
                ctx.print(`[services] ${result.item.id}: error \u2014 ${(err2 as Error).message}`);
              }
            }
            ctx.renderRequest();
          });
        });
        return;
      }

      // Fallback: print to conversation
      if (keys.length === 0) {
        ctx.print('[services] No services configured. Add entries to .goodvibes/tui/services.json');
        return;
      }
      const lines = ['Services:', ''];
      for (const key of keys) {
        const svc = all[key];
        lines.push(`  ${key.padEnd(20)} ${svc.authType.padEnd(10)} ${svc.baseUrl ?? '(no url)'}`);
      }
      ctx.print(lines.join('\n'));
    },
  });
  // ── /settings ────────────────────────────────────────────────
  registry.register({
    name: 'settings',
    aliases: ['cfg-ui'],
    description: 'Open the config/settings browser modal',
    handler(_args, ctx) {
      if (ctx.openSettingsModal) {
        ctx.openSettingsModal();
      } else {
        ctx.print('Settings modal not available. Use /config to view or set values.');
      }
    },
  });

  // ── /sessions (enhanced: opens dedicated picker modal) ────────
  // (Note: /sessions is already registered above as the list/selection command.
  //  The dedicated SessionPickerModal is opened via ctx.openSessionPicker below.)

  // ── /profiles ────────────────────────────────────────────────
  registry.register({
    name: 'profiles',
    aliases: ['prof'],
    description: 'Open the profile picker modal (load/save/delete profiles)',
    handler(_args, ctx) {
      if (ctx.openProfilePicker) {
        ctx.openProfilePicker();
      } else {
        // Fallback: delegate to /config profile list
        const pm = getProfileManager();
        const profiles = pm.list();
        if (profiles.length === 0) {
          ctx.print('No saved profiles.\nUse /config profile save <name> to save current settings.');
          return;
        }
        const lines = ['Saved profiles:', ''];
        for (const p of profiles) {
          const date = new Date(p.timestamp).toLocaleString();
          lines.push(`  ${p.name.padEnd(28)} ${date}`);
        }
        ctx.print(lines.join('\n'));
      }
    },
  });

  // ── /context ─────────────────────────────────────────────────────
  registry.register({
    name: 'context',
    aliases: ['ctx'],
    description: 'Inspect context window usage (token breakdown per message)',
    handler: (_args, ctx) => {
      if (ctx.openContextInspector) {
        ctx.openContextInspector();
      } else {
        // Fallback: print summary to conversation
        const msgs = ctx.conversationManager.getMessagesForLLM();
        if (msgs.length === 0) {
          ctx.print('[context] No messages in conversation.');
          return;
        }
        const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
        let total = 0;
        const lines: string[] = ['Context breakdown:'];
        for (const m of msgs) {
          const text = typeof m.content === 'string'
            ? m.content
            : (m.content as Array<{ type: string; text?: string }>)
                .filter((p) => p.type === 'text')
                .map((p) => p.text ?? '')
                .join('');
          const t = estimateTokens(text);
          total += t;
          lines.push(`  ${m.role.padEnd(12)} ~${t.toLocaleString()} tokens`);
        }
        lines.push(`  ${'Total'.padEnd(12)} ~${total.toLocaleString()} tokens (${msgs.length} messages)`);
        ctx.print(lines.join('\n'));
      }
    },
  });

  // ── /next-error ───────────────────────────────────────────────
  registry.register({
    name: 'next-error',
    aliases: ['ne'],
    description: 'Jump to the next error message in the conversation',
    handler(_args, ctx) {
      const cm = ctx.conversationManager;
      const scrollTop = (ctx as unknown as { getScrollTop?: () => number }).getScrollTop?.() ?? 0;
      const nextLine = cm.nextErrorLine(scrollTop);
      if (nextLine < 0) {
        ctx.print('[No error messages found in conversation]');
      } else {
        ctx.eventBus.emit('scroll:to', { line: nextLine });
      }
    },
  });

  // ── /profiles ─────────────────────────────────────────────────
  registry.register({
    name: 'profiles',
    aliases: ['profile'],
    description: 'Browse and load config profiles',
    handler(_args, ctx) {
      if (ctx.openProfilePicker) {
        ctx.openProfilePicker();
      } else {
        const manager = getProfileManager();
        const profiles = manager.list();
        if (profiles.length === 0) {
          ctx.print('No profiles saved. Use /config profile save <name> to create one.');
        } else {
          const lines = ['Saved profiles:', ...profiles.map(p => `  ${p.name}`)];
          ctx.print(lines.join('\n'));
        }
      }
    },
  });

  // ── /prev-error ───────────────────────────────────────────────
  registry.register({
    name: 'prev-error',
    aliases: ['pe'],
    description: 'Jump to the previous error message in the conversation',
    handler(_args, ctx) {
      const cm = ctx.conversationManager;
      const scrollTop = (ctx as unknown as { getScrollTop?: () => number }).getScrollTop?.() ?? 0;
      const prevLine = cm.prevErrorLine(scrollTop);
      if (prevLine < 0) {
        ctx.print('[No error messages found in conversation]');
      } else {
        ctx.eventBus.emit('scroll:to', { line: prevLine });
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

