import type { CommandRegistry, CommandContext } from './command-registry.ts';
import { logger } from '../utils/logger.ts';
import type { SelectionItem } from './selection-modal.ts';
import type { ConfigKey } from '../config/index.ts';
import { CONFIG_SCHEMA } from '../config/index.ts';
import { REASONING_BUDGET_MAP } from '../providers/interface.ts';
import type { ContentPart } from '../providers/interface.ts';
import { join, resolve } from 'path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { fetchModelContextWindows } from '../discovery/scanner.ts';
import type { CustomProviderConfig } from '../providers/custom-loader.ts';
import { randomBytes } from 'node:crypto';
import { getSessionManager } from '../sessions/manager.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { TemplateManager, parseTemplateArgs } from '../templates/manager.ts';
import { getBookmarkManager } from '../bookmarks/manager.ts';
import { getProfileManager } from '../profiles/manager.ts';
import type { BlockMeta } from '../core/conversation.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import { getSecretsManager } from '../config/secrets.ts';
import { scan, persistProviders } from '../discovery/index.ts';
import { planManager } from '../core/plan-manager-instance.ts';
import { classifyIntent } from '../core/intent-classifier.ts';
import { getPanelManager } from '../panels/panel-manager.ts';
import { resolveAndValidatePath } from '../utils/path-safety.ts';
import { TaskScheduler } from '../scheduler/scheduler.ts';
import { exportToMarkdown } from '../export/markdown.ts';
import { exportToHTML, exportToJSON, exportToMarkdownExtended, defaultExportPath } from '../export/session-export.ts';
import { getKeybindingsManager } from './keybindings.ts';
import { pluginManager, type PluginStatus } from '../plugins/manager.ts';
import { PLUGINS_DIR } from '../plugins/loader.ts';
import { EFFORT_DESCRIPTIONS } from '../providers/effort-levels.ts';
import { pinModel, unpinModel, isModelPinned, getPinned, recordUsage } from '../providers/favorites.ts';
import { GitService } from '../git/service.ts';
import { sessionMemoryStore } from '../core/session-memory.ts';
import { sessionLineageTracker } from '../core/session-lineage.ts';
import { handlePlanCommand } from '../core/plan-command-handler.ts';
import { ModeManager } from '../state/mode-manager.ts';

let _serviceRegistry: ServiceRegistry | undefined;
function getServiceRegistry(): ServiceRegistry {
  if (!_serviceRegistry) _serviceRegistry = new ServiceRegistry();
  return _serviceRegistry;
}

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
    argsHint: '[name]',
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
          void recordUsage(def.id);
          ctx.eventBus.emit('command:model-changed', { provider: def.provider, model: def.id });
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      }
    },
  });

  // ── /commands ────────────────────────────────────────────
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

  // ── /shortcuts ──────────────────────────────────────────
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

  // ── /keybindings ─────────────────────────────────────────
  registry.register({
    name: 'keybindings',
    aliases: ['kb'],
    description: 'List current keyboard bindings and their config file path',
    handler(_args, ctx) {
      const km = getKeybindingsManager();
      const all = km.getAll();
      const lines: string[] = [
        `Keybindings config: ${km.getConfigPath()}`,
        '',
        `  ${'Action'.padEnd(28)}  ${'Binding'.padEnd(20)}  Description`,
        `  ${'─'.repeat(28)}  ${'─'.repeat(20)}  ${'─'.repeat(34)}`,
      ];
      for (const { action, combos, description } of all) {
        const label = combos.map(c => km.formatCombo(c)).join(', ');
        lines.push(`  ${action.padEnd(28)}  ${label.padEnd(20)}  ${description}`);
      }
      lines.push('');
      lines.push('To customize: create the config file with { "action": { "key": "x", "ctrl": true } }');
      ctx.print(lines.join('\n'));
    },
  });

  // ── /help ──────────────────────────────────────────────
  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and keyboard shortcuts',
    argsHint: '[command]',
    handler(_args, ctx) {
      // Use selection modal for interactive command picker
      // The ? key still opens the quick text overlay via handler.ts
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
          // Templates
          { id: '/template', label: '/template', detail: 'Browse templates', category: 'Templates' },
          { id: '/template save', label: '/template save <name>', detail: 'Save prompt as template', category: 'Templates' },
          { id: '/template use', label: '/template use <name>', detail: 'Execute template', category: 'Templates' },
          // Tools & System
          { id: '/tools', label: '/tools', detail: 'List available tools', category: 'Tools & System' },
          { id: '/permissions', label: '/permissions', detail: 'Permission settings', category: 'Tools & System' },
          { id: '/shortcuts', label: '/shortcuts', detail: 'View keyboard shortcuts reference', category: 'Tools & System' },
          { id: '/commands', label: '/commands', detail: 'Browse all commands in a scrollable list', category: 'Tools & System' },
          { id: '/secrets', label: '/secrets set|get|list|delete', detail: 'Manage encrypted API key secrets', category: 'Tools & System' },
          { id: '/danger', label: '/danger [key] [value]', detail: 'DANGEROUS SETTINGS', category: 'Tools & System', fg: '#ef4444' },
          { id: '/help', label: '/help', detail: 'This help', category: 'Tools & System' },
          { id: '/quit', label: '/quit', detail: 'Exit', category: 'Tools & System' }
        ];
        ctx.openSelection('Help  —  Commands', items, { allowSearch: true }, (result) => {
          if (!result) return;
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
      await ctx.conversationManager.compact(ctx.providerRegistry, ctx.runtime.model, 10, 'manual', ctx.runtime.provider);
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
    argsHint: '<key> [value]',
    handler(args, ctx) {
      const cm = ctx.configManager;
      const all = cm.getAll();
      const categories = ['display', 'provider', 'behavior', 'permissions', 'danger', 'tools'] as const;

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
                ...(cat === 'danger' ? { fg: '#ef4444' } : {}),
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
                cm.setDynamic(key, newVal);
              } else if (schema.type === 'enum' && schema.enumValues) {
                const idx = schema.enumValues.indexOf(String(currentVal));
                newVal = schema.enumValues[(idx + 1) % schema.enumValues.length];
                cm.setDynamic(key, newVal);
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
          cm.setDynamic(key, coerced);
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
    description: 'Switch provider or manage custom providers (add/remove)',
    usage: '[add <name> <baseURL> [apiKey] | remove <name> | <provider-name>]',
    argsHint: '[add|remove|name]',
    async handler(args, ctx) {
      const isValidProviderName = (name: string): boolean => /^[a-zA-Z0-9_-]+$/.test(name);
      // ── /provider add <name> <baseURL> [apiKey] ──────────────
      if (args[0] === 'add') {
        const addArgs = args.slice(1);
        if (addArgs.length < 2) {
          ctx.print('Usage: /provider add <name> <baseURL> [apiKey]\nExample: /provider add my-server http://192.168.0.85:8001/v1');
          return;
        }
        const [name, baseURL, apiKey] = addArgs;

        if (!isValidProviderName(name)) {
          ctx.print('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
          return;
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(baseURL);
        } catch {
          ctx.print(`Error: '${baseURL}' is not a valid URL. Example: http://192.168.0.85:8001/v1`);
          return;
        }

        const PROVIDER_PROBE_TIMEOUT_MS = 5000;
        const providersDir = join(homedir(), '.goodvibes', 'tui', 'providers');
        const providerFile = join(providersDir, `${name}.json`);

        if (existsSync(providerFile)) {
          ctx.print(`Error: Provider '${name}' already exists at ${providerFile}\nRemove it first with: /provider remove ${name}`);
          return;
        }

        ctx.print(`Probing ${baseURL}/models ...`);

        // Probe the server for models
        let discoveredModelIds: string[] = [];
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), PROVIDER_PROBE_TIMEOUT_MS);
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
          const res = await fetch(`${baseURL}/models`, { signal: controller.signal, headers });
          clearTimeout(timeoutId);
          if (res.ok) {
            const body = await res.json() as unknown;
            if (body && typeof body === 'object' && 'data' in body && Array.isArray((body as Record<string, unknown>).data)) {
              const data = (body as { data: unknown[] }).data;
              discoveredModelIds = data
                .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && 'id' in m)
                .map(m => String(m.id))
                .filter(Boolean);
            }
          }
        } catch (_err) {
          ctx.print(`Could not reach ${baseURL}/models — creating provider with placeholder config.`);
        }

        // Detect context windows
        let contextWindows: Record<string, number> = {};
        if (discoveredModelIds.length > 0) {
          if (parsedUrl.protocol === 'http:') {
            try {
              const host = parsedUrl.hostname;
              const port = parseInt(parsedUrl.port) || 80;
              contextWindows = await fetchModelContextWindows(host, port, 'unknown', discoveredModelIds);
            } catch (_err) {
              // Context window detection failed — use defaults
            }
          } else {
            ctx.print('Note: Context window detection is only supported for http:// URLs. Using defaults.');
          }
        }

        // Default model entry created for custom providers when discovery fails — edit the provider file to configure models manually.
        const DEFAULT_CUSTOM_MODEL = `${name}-model`;
        let models: CustomProviderConfig['models'];

        if (discoveredModelIds.length === 0) {
          ctx.print(`Warning: Could not discover models from ${baseURL}/models. Creating provider with a placeholder model entry.\nEdit ${providerFile} to configure models manually.`);
          models = [{
            id: DEFAULT_CUSTOM_MODEL,
            displayName: DEFAULT_CUSTOM_MODEL,
            contextWindow: 8192,
            capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
          }];
        } else {
          models = discoveredModelIds.map(id => ({
            id,
            displayName: id,
            contextWindow: contextWindows[id] ?? 8192,
            capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
          }));
        }

        const config: CustomProviderConfig = {
          name,
          displayName: name,
          type: 'openai-compat' as const,
          baseURL,
          ...(apiKey ? { apiKey } : {}),
          models,
        };

        try {
          mkdirSync(providersDir, { recursive: true });
          await writeFile(providerFile, JSON.stringify(config, null, 2), 'utf-8');
        } catch (e) {
          ctx.print(`Error writing provider file: ${(e as Error).message}`);
          return;
        }

        const ctxWindowSummary = discoveredModelIds.length > 0
          ? discoveredModelIds.map(id => `  • ${id} (${(contextWindows[id] ?? 8192).toLocaleString()} ctx)`).join('\n')
          : `  • ${DEFAULT_CUSTOM_MODEL} (placeholder)`;
        if (apiKey) {
          ctx.print('Tip: For better security, set the key as an env var and use "apiKeyEnv" in the config instead of "apiKey".');
        }
        ctx.print(`Provider '${name}' added with ${models.length} model(s):\n${ctxWindowSummary}\nThe file watcher will auto-register it shortly.`);
        return;
      }

      // ── /provider remove <name> ───────────────────────────────
      if (args[0] === 'remove' || args[0] === 'rm') {
        const removeArgs = args.slice(1);
        if (removeArgs.length === 0) {
          ctx.print('Usage: /provider remove <name>');
          return;
        }
        const name = removeArgs[0];
        if (!isValidProviderName(name)) {
          ctx.print('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
          return;
        }
        const providersDir = join(homedir(), '.goodvibes', 'tui', 'providers');
        const providerFile = join(providersDir, `${name}.json`);

        if (!existsSync(providerFile)) {
          ctx.print(`Error: No custom provider '${name}' found at ${providerFile}`);
          return;
        }

        try {
          await unlink(providerFile);
        } catch (e) {
          ctx.print(`Error removing provider file: ${(e as Error).message}`);
          return;
        }

        ctx.print(`Provider '${name}' removed. The file watcher will deregister it shortly.`);
        return;
      }

      // ── /provider [name] — switch provider ───────────────────
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
    usage: '[level]',
    argsHint: '<instant|low|medium|high>',
    handler(args, ctx) {
      const currentModel = ctx.providerRegistry.getCurrentModel();
      const VALID_LEVELS = currentModel.reasoningEffort ?? [];

      if (VALID_LEVELS.length === 0) {
        ctx.print(`Current model (${currentModel.displayName}) does not support configurable reasoning effort.`);
        return;
      }

      if (args.length === 0) {
        const current = (ctx.runtime.reasoningEffort || ctx.configManager.get('provider.reasoningEffort') || 'medium') as string;
        if (ctx.openSelection) {
          const descriptions: Record<string, string> = {
            ...EFFORT_DESCRIPTIONS,
            medium: 'Balanced speed and quality (default)',
          };
          const items: SelectionItem[] = VALID_LEVELS.map(level => ({
            id: level,
            label: level,
            detail: level === current ? `\u25c9 ${descriptions[level] ?? level}` : (descriptions[level] ?? level),
          }));
          ctx.openSelection('Reasoning Effort', items, { preSelectId: current, allowSearch: false }, (result) => {
            if (!result) return;
            const level = result.item.id as 'instant' | 'low' | 'medium' | 'high';
            ctx.runtime.reasoningEffort = level;
            ctx.configManager.set('provider.reasoningEffort', level);
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
          ``,
          `Levels: ${VALID_LEVELS.join(', ')}`,
        ];
        ctx.print(lines.join('\n'));
        return;
      }

      const level = args[0] as 'instant' | 'low' | 'medium' | 'high';
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
    description: 'Export conversation to a Markdown file',
    usage: '[format] [path]',
    argsHint: '[markdown] [path]',
    async handler(args, ctx) {
      // Parse args: /export [format] [path]
      let format = 'markdown';
      let outPath: string | undefined;

      for (const arg of args) {
        if (arg === 'markdown' || arg === 'md' || arg === 'text' || arg === 'txt') {
          format = arg === 'md' ? 'markdown' : arg === 'txt' ? 'text' : arg;
        } else {
          outPath = arg;
        }
      }

      // Default path: ./conversation-{timestamp}.md
      if (!outPath) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const ext = format === 'markdown' ? 'md' : 'txt';
        outPath = `./conversation-${ts}.${ext}`;
      }

      // Resolve relative paths from cwd
      const resolvedPath = resolve(
        outPath.startsWith('~') ? outPath.replace(/^~/, homedir()) : outPath.startsWith('/') ? outPath : join(process.cwd(), outPath)
      );

      // Path traversal guard — append separator to prevent prefix collisions
      const cwdPrefix = process.cwd().endsWith('/') ? process.cwd() : process.cwd() + '/';
      if (!resolvedPath.startsWith(cwdPrefix) && resolvedPath !== process.cwd()) {
        ctx.print('Error: Export path must be within the current directory.');
        return;
      }

      try {
        // Get raw messages from ConversationManager via toJSON
        const data = ctx.conversationManager.toJSON() as { messages: Array<Record<string, unknown>> };
        const msgs = data.messages ?? [];

        let fileContent: string;
        if (format === 'markdown') {
          // Map raw messages to ExportMessage shape
          const exportMsgs = msgs.map(m => ({
            role: String(m.role ?? 'user') as 'user' | 'assistant' | 'system' | 'tool',
            content: Array.isArray(m.content)
              ? m.content as import('../providers/interface.ts').ContentPart[]
              : String(m.content ?? ''),
            toolCalls: m.toolCalls as import('../types/tools.ts').ToolCall[] | undefined,
            callId: m.callId as string | undefined,
            toolName: m.toolName as string | undefined,
            reasoningContent: m.reasoningContent as string | undefined,
            reasoningSummary: m.reasoningSummary as string | undefined,
            usage: m.usage as { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined,
          }));
          fileContent = exportToMarkdown(exportMsgs, {
            model: ctx.runtime.model,
            provider: ctx.runtime.provider,
            sessionId: ctx.runtime.sessionId,
            title: ctx.conversationManager.title || undefined,
          });
        } else {
          // Plain text format
          const lines: string[] = [];
          for (const m of msgs) {
            const role = String(m.role ?? 'unknown').toUpperCase();
            const content = typeof m.content === 'string' ? m.content : '';
            if (!content.trim()) continue;
            lines.push(`[${role}]`);
            lines.push(content);
            lines.push('');
          }
          fileContent = lines.join('\n');
        }

        // Ensure parent directory exists
        const { dirname } = await import('node:path');
        const dir = dirname(resolvedPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        await writeFile(resolvedPath, fileContent, 'utf-8');
        ctx.print(`Exported ${msgs.length} messages to: ${resolvedPath}`);
      } catch (err) {
        ctx.print(`Export failed: ${(err as Error).message}`);
      }
    },
  });

  // ── /title ────────────────────────────────────────────
  registry.register({
    name: 'title',
    aliases: [],
    description: 'Show or set the conversation title',
    usage: '[text]',
    argsHint: '[text]',
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
    argsHint: '[name]',
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
        const agentRecords = AgentManager.getInstance().exportState();
        const { filePath, sanitizedName } = sessionManager.save(rawName, messages, meta, agentRecords);
        const nameNote = sanitizedName !== rawName ? ` (saved as "${sanitizedName}")` : '';
        const agentNote = agentRecords.length > 0 ? ` [${agentRecords.length} agent records]` : '';
        ctx.print(`Session saved: ${rawName}${nameNote}${agentNote}\n  → ${filePath}`);
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
    argsHint: '<name>',
    handler(args, ctx) {
      if (!args[0]) {
        ctx.print('Usage: /load <session-name>\nRun /sessions to list available sessions.');
        return;
      }
      const sessionManager = getSessionManager();
      try {
        const { meta, messages, agentRecords } = sessionManager.load(args[0]);
        ctx.conversationManager.resetAll();
        ctx.conversationManager.fromJSON({ messages: messages as never[] });
        if (meta.title) ctx.conversationManager.title = meta.title;
        ctx.conversationManager.rebuildHistory();
        AgentManager.getInstance().clear();
        if (agentRecords.length > 0) {
          AgentManager.getInstance().importState(agentRecords);
        }
        ctx.renderRequest();
        const agentNote = agentRecords.length > 0 ? ` [${agentRecords.length} agent records restored]` : '';
        ctx.print(`Session loaded: ${args[0]} (${messages.length} messages)${agentNote}`);
      } catch (e) {
        ctx.print(`Failed to load session: ${(e as Error).message}`);
      }
    },
  });

  // ── /undo ──────────────────────────────────────────────
  registry.register({
    name: 'undo',
    aliases: ['u'],
    description: 'Undo last action. /undo file — revert last file write/edit. /undo — remove last conversation turn.',
    usage: '[file]',
    argsHint: '[file]',
    handler(args, ctx) {
      const sub = args[0];

      // /undo file — revert the last write/edit tool operation
      if (sub === 'file') {
        if (!ctx.fileUndoManager) {
          ctx.print('File undo not available.');
          return;
        }
        try {
          const result = ctx.fileUndoManager.undo();
          if (result) {
            ctx.print(`File reverted: ${result.path} (${result.tool} tool). Use /redo file to re-apply.`);
          } else {
            ctx.print('Nothing to undo. No file operations recorded.');
          }
        } catch (err) {
          ctx.print(`File undo failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      // Default: conversation-level undo
      const success = ctx.conversationManager.undo();
      if (success) {
        ctx.print('Last turn undone. Use /redo to restore. Tip: /undo file to revert a file write/edit.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to undo. Tip: use /undo file to revert the last file write/edit.');
      }
    },
  });

  // ── /redo ──────────────────────────────────────────────
  registry.register({
    name: 'redo',
    aliases: [],
    description: 'Redo last undone action. /redo file — re-apply last reverted file. /redo — restore conversation turn.',
    usage: '[file]',
    argsHint: '[file]',
    handler(args, ctx) {
      const sub = args[0];

      // /redo file — re-apply the last reverted file operation
      if (sub === 'file') {
        if (!ctx.fileUndoManager) {
          ctx.print('File redo not available.');
          return;
        }
        try {
          const result = ctx.fileUndoManager.redo();
          if (result) {
            ctx.print(`File re-applied: ${result.path} (${result.tool} tool).`);
          } else {
            ctx.print('Nothing to redo.');
          }
        } catch (err) {
          ctx.print(`File redo failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      // Default: conversation-level redo
      const success = ctx.conversationManager.redo();
      if (success) {
        ctx.print('Turn restored. Tip: /redo file to re-apply a reverted file.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to redo. Tip: use /redo file to re-apply the last reverted file.');
      }
    },
  });

  // ── /retry ─────────────────────────────────────────────
  registry.register({
    name: 'retry',
    aliases: ['r'],
    description: 'Re-send the last user message',
    usage: '[modified text]',
    argsHint: '[modified text]',
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
    argsHint: '<save|use|list|edit|delete> [name]',
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
    argsHint: '[allow-all|prompt|custom]',
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
              cm.setDynamic('permissions.mode', nextMode);
              result.item.detail = nextMode;
              ctx.renderRequest();
              return; // Stay in modal
            } else {
              const toolKey = `permissions.tools.${result.item.id}` as Parameters<typeof cm.get>[0];
              const currentAction = cm.get(toolKey) as string;
              const nextAction = VALID_ACTIONS[(VALID_ACTIONS.indexOf(currentAction as typeof VALID_ACTIONS[number]) + 1) % VALID_ACTIONS.length];
              cm.setDynamic(toolKey, nextAction);
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
          cm.setDynamic(toolKey, action);
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
        cm.setDynamic('permissions.mode', newMode);
        ctx.print(`Permission mode set to: ${newMode}`);
      } catch (e) {
        ctx.print(`Error: ${(e as Error).message}`);
      }
    },
  });

  // ── /expand + /collapse shared helper ────────────────────
  function toggleBlocks(
    typeFilter: string,
    collapsed: boolean,
    ctx: CommandContext,
  ): void {
    const VALID_TYPES = ['all', 'thinking', 'tool', 'code'] as const;
    if (!VALID_TYPES.includes(typeFilter as typeof VALID_TYPES[number])) {
      ctx.print(`Unknown type: ${typeFilter}\nValid types: ${VALID_TYPES.join(', ')}`);
      return;
    }
    const blockRegistry = ctx.conversationManager.getBlockRegistry();
    if (!blockRegistry || blockRegistry.length === 0) {
      ctx.print('No blocks found.');
      return;
    }
    let count = 0;
    for (let i = 0; i < blockRegistry.length; i++) {
      const block = blockRegistry[i];
      const matchesType = typeFilter === 'all' ||
        (typeFilter === 'tool' && block.type === 'tool') ||
        (typeFilter === 'code' && block.type === 'code') ||
        (typeFilter === 'thinking' && block.type === 'thinking');
      if (!matchesType) continue;
      const isCurrentlyCollapsed = ctx.conversationManager.isCollapsed(i);
      if (collapsed ? !isCurrentlyCollapsed : isCurrentlyCollapsed) {
        ctx.conversationManager.toggleCollapseAtLine(block.startLine);
        count++;
      }
    }
    const verb = collapsed ? 'Collapsed' : 'Expanded';
    ctx.print(`${verb} ${count} block${count !== 1 ? 's' : ''}${typeFilter !== 'all' ? ` (${typeFilter})` : ''}.`);
    ctx.renderRequest();
  }

  // ── /expand ────────────────────────────────────────────
  registry.register({
    name: 'expand',
    aliases: [],
    description: 'Expand blocks by type',
    usage: '[all|thinking|tool|code]',
    argsHint: '[all|thinking|tool|code]',
    handler(args, ctx) {
      toggleBlocks(args[0] || 'all', false, ctx);
    },
  });

  // ── /collapse ──────────────────────────────────────────
  registry.register({
    name: 'collapse',
    aliases: [],
    description: 'Collapse blocks by type',
    usage: '[all|thinking|tool|code]',
    argsHint: '[all|thinking|tool|code]',
    handler(args, ctx) {
      toggleBlocks(args[0] || 'all', true, ctx);
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
    aliases: [],
    description: 'Manage encrypted API key secrets',
    usage: 'set <KEY> <value> | get <KEY> | list | delete <KEY>',
    argsHint: '<set|get|list|delete> [KEY]',
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
      const svcRegistry = getServiceRegistry();
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

  // ── /panel ───────────────────────────────────────────────────
  registry.register({
    name: 'panel',
    aliases: ['panels', 'p'],
    description: 'Open, close, or list panels. Usage: /panel [open <id>|close <id>|list|toggle|move|focus|split]',
    usage: '[open <id>|close <id>|list|toggle|move <top|bottom>|focus <top|bottom>|split]',
    argsHint: '<open|close|list|toggle|move|focus|split> [id]',
    handler(args, ctx) {
      const pm = getPanelManager();
      const sub = args[0]?.toLowerCase() ?? '';
      if (!sub || sub === 'toggle') {
        if (ctx.openPanelPicker) {
          ctx.openPanelPicker();
        } else {
          pm.toggle();
          ctx.renderRequest();
        }
      } else if (sub === 'list') {
        const types = pm.getRegisteredTypes();
        const open = pm.getAllOpen().map(p => p.id);
        const lines = ['Registered panels:', ...types.map(t =>
          `  ${open.includes(t.id) ? '\u25cf' : '\u25e6'} ${t.id.padEnd(14)} ${t.icon}  ${t.name.padEnd(12)} [${t.category}] ${t.description}`
        )];
        ctx.print(lines.join('\n'));
      } else if (sub === 'open') {
        const id = args[1];
        if (!id) { ctx.print('Usage: /panel open <panel-id>'); return; }
        try {
          pm.open(id);
          pm.show();
          ctx.renderRequest();
          ctx.print(`Panel opened: ${id}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      } else if (sub === 'close') {
        const id = args[1];
        if (!id) { ctx.print('Usage: /panel close <panel-id>'); return; }
        try {
          pm.close(id);
          ctx.renderRequest();
          ctx.print(`Panel closed: ${id}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      } else if (sub === 'move') {
        const dest = args[1]?.toLowerCase();
        if (dest !== 'top' && dest !== 'bottom') {
          ctx.print('Usage: /panel move <top|bottom>');
          return;
        }
        const panelId = args[2];
        try {
          pm.moveToPane(dest, panelId);
          ctx.renderRequest();
          ctx.print(`Panel moved to ${dest} pane`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      } else if (sub === 'focus') {
        const pane = args[1]?.toLowerCase();
        if (pane !== 'top' && pane !== 'bottom') {
          ctx.print('Usage: /panel focus <top|bottom>');
          return;
        }
        pm.focusPane(pane);
        ctx.renderRequest();
        ctx.print(`Focused ${pane} pane`);
      } else if (sub === 'split') {
        pm.toggleBottomPane();
        ctx.renderRequest();
        ctx.print(pm.isBottomPaneVisible() ? 'Bottom pane visible' : 'Bottom pane hidden');
      } else {
        // Treat bare argument as a panel id to open
        const id = args[0]!;
        try {
          pm.open(id);
          pm.show();
          ctx.renderRequest();
        } catch (e) {
          ctx.print(`Unknown panel "${id}". Use /panel list to see available panels.`);
        }
      }
    },
  });

  // ── /danger ──────────────────────────────────────────────────────
  registry.register({
    name: 'danger',
    aliases: [],
    argsHint: '[key] [value]',
    description: '⚠ Danger zone settings (agent recursion, daemon, HTTP listener)',
    usage: '[key] [value]',
    handler(args, ctx) {
      if (args.length === 0) {
        if (ctx.openSelection) {
          const cm = ctx.configManager;
          const all = cm.getAll();
          const dangerObj = all.danger as Record<string, unknown>;
          const toggleAction = new Map<string, import('./selection-modal.ts').SelectionAction>([['enter', 'toggle' as const]]);
          const items: SelectionItem[] = Object.entries(dangerObj).map(([field, val]) => {
            const key = `danger.${field}`;
            const schema = CONFIG_SCHEMA.find(s => s.key === key);
            return {
              id: key,
              label: key,
              detail: String(val),
              fg: '#ef4444',
              actions: schema ? `[Enter] toggle  ${schema.description}` : undefined,
            };
          });
          ctx.openSelection('⚠ Danger Zone', items, { allowSearch: false, customActions: toggleAction }, (result) => {
            if (!result) return;
            const key = result.item.id as import('../config/index.ts').ConfigKey;
            const schema = CONFIG_SCHEMA.find(s => s.key === key);
            if (result.action === 'toggle' && schema) {
              const currentVal = cm.get(key);
              let newVal: unknown = currentVal;
              if (schema.type === 'boolean') {
                newVal = !currentVal;
                cm.setDynamic(key, newVal);
              } else if (schema.type === 'number') {
                // Cycle common values for number settings
                const fieldName = key.replace('danger.', '');
                ctx.print(`Current: ${key} = ${String(currentVal)}. Use /danger ${fieldName} <value> to set.`);
                return;
              }
              result.item.detail = String(newVal);
              ctx.renderRequest();
              return;
            }
          });
        } else {
          const cm = ctx.configManager;
          const all = cm.getAll();
          const lines: string[] = ['⚠ Danger Zone Settings:', ''];
          const dangerObj = all.danger as Record<string, unknown>;
          for (const [field, val] of Object.entries(dangerObj)) {
            const key = `danger.${field}`;
            lines.push(`  ${key.padEnd(36)} ${String(val)}`);
          }
          ctx.print(lines.join('\n'));
        }
        return;
      }
      // /danger <key> <value> — shorthand for /config danger.<key> <value>
      const key = args[0].startsWith('danger.') ? args[0] : `danger.${args[0]}`;
      if (args.length === 1) {
        // Show single key
        try {
          const val = ctx.configManager.get(key as Parameters<typeof ctx.configManager.get>[0]);
          ctx.print(`${key} = ${String(val)}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      } else {
        // Set value
        const rawValue = args.slice(1).join(' ');
        try {
          const schema = CONFIG_SCHEMA.find(s => s.key === key);
          if (!schema) {
            ctx.print(`Unknown danger key: ${key}`);
            return;
          }
          let coerced: unknown = rawValue;
          if (schema.type === 'boolean') {
            coerced = rawValue === 'true' || rawValue === '1' || rawValue === 'yes';
          } else if (schema.type === 'number') {
            coerced = Number(rawValue);
          }
          ctx.configManager.setDynamic(key as Parameters<typeof ctx.configManager.get>[0], coerced);
          ctx.print(`⚠ Set ${key} = ${String(coerced)}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
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
      const scrollTop = ctx.getScrollTop?.() ?? 0;
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
      const scrollTop = ctx.getScrollTop?.() ?? 0;
      const prevLine = cm.prevErrorLine(scrollTop);
      if (prevLine < 0) {
        ctx.print('[No error messages found in conversation]');
      } else {
        ctx.eventBus.emit('scroll:to', { line: prevLine });
      }
    },
  });

  // ── /scan ─────────────────────────────────────────────────────
  registry.register({
    name: 'scan',
    aliases: [],
    description: 'Scan localhost and LAN for local LLM servers',
    async handler(_args, ctx) {
      ctx.print('Scanning for local LLM servers...');
      ctx.renderRequest();

      const result = await scan();

      if (result.servers.length === 0) {
        ctx.print(
          `[Scan] No local LLM servers found (scanned ${result.scannedHosts} hosts, ` +
          `${result.scannedPorts} ports in ${Math.round(result.durationMs / 1000)}s)`,
        );
      } else {
        const lines = [
          `[Scan] Found ${result.servers.length} server(s) in ${Math.round(result.durationMs / 1000)}s:`,
          '',
          ...result.servers.map((s) =>
            `  ${s.name.padEnd(30)} ${s.models.length} model(s)  ${s.host}:${s.port}`,
          ),
          '',
          'Use /model to select a discovered model.',
        ];
        ctx.print(lines.join('\n'));
      }

      // Register discovered providers into the registry
      try {
        ctx.providerRegistry.registerDiscoveredProviders(result.servers);
      } catch (err) {
        ctx.print(
          `[Scan] Warning: failed to register some providers: ${(err as Error).message}`,
        );
      }

      // Persist discovered servers for next session
      if (result.servers.length > 0) { persistProviders(result.servers); }

      ctx.renderRequest();
    },
  });

  // ── /session ───────────────────────────────────────────
  registry.register({
    name: 'session',
    aliases: ['sess'],
    description: 'Manage sessions: list, rename, resume, fork, save, info, export, search, delete',
    usage: '[list | rename <name> | resume <id|name> | fork | save | info <id> | export <id> [format] | search <query> | delete <id>]',
    argsHint: '<list|rename|resume|fork|save|info|export|search|delete>',
    async handler(args, ctx) {
      const sm = getSessionManager();
      const sub = args[0];

      // ── /session (no args) — current session info ──────────
      if (!sub) {
        const id = ctx.runtime.sessionId;
        const msgCount = ctx.conversationManager.getMessageCount();
        const title = ctx.conversationManager.title || '(untitled)';
        const meta = sm.getMeta(id);
        const started = meta ? new Date(meta.timestamp).toLocaleString() : 'this session';
        const lines = [
          'Current session',
          `  ID:       ${id}`,
          `  Name:     ${title}`,
          `  Started:  ${started}`,
          `  Messages: ${msgCount}`,
          `  Model:    ${ctx.runtime.model} (${ctx.runtime.provider})`,
        ];
        ctx.print(lines.join('\n'));
        return;
      }

      // ── /session list ──────────────────────────────────────
      if (sub === 'list') {
        const sessions = sm.list();
        if (sessions.length === 0) {
          ctx.print('No saved sessions. Use /session save [name] to save the current session.');
          return;
        }
        const lines = ['Sessions (most recent first):', ''];
        for (const s of sessions) {
          const date = new Date(s.timestamp).toLocaleString();
          const name = s.title || s.name;
          const model = s.model ? ` [${s.model}]` : '';
          const active = s.name === ctx.runtime.sessionId ? ' *' : '  ';
          lines.push(`${active} ${s.name.padEnd(28)} ${name.slice(0, 22).padEnd(22)} ${date}  ${s.messageCount} msgs${model}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      // ── /session rename <name> ─────────────────────────────
      if (sub === 'rename') {
        const newName = args.slice(1).join(' ').trim();
        if (!newName) {
          ctx.print('Usage: /session rename <new-name>');
          return;
        }
        try {
          // If the session hasn't been saved yet, force-save first so rename has a file to update
          const existingMeta = sm.getMeta(ctx.runtime.sessionId);
          if (!existingMeta) {
            const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
            sm.save(ctx.runtime.sessionId, exportData.messages ?? [], {
              title: ctx.conversationManager.title || '',
              model: ctx.runtime.model,
              provider: ctx.runtime.provider,
              timestamp: Date.now(),
            });
          }
          sm.rename(ctx.runtime.sessionId, newName);
          ctx.conversationManager.title = newName;
          ctx.print(`Session renamed to: ${newName}`);
          ctx.renderRequest();
        } catch (e) {
          ctx.print(`Failed to rename: ${(e as Error).message}`);
        }
        return;
      }

      // ── /session resume <id|name> ──────────────────────────
      if (sub === 'resume') {
        const target = args.slice(1).join(' ').trim();
        if (!target) {
          ctx.print('Usage: /session resume <session-id-or-name>');
          return;
        }
        // Find by exact name, partial ID prefix, or title match
        const sessions = sm.list();
        const found = sessions.find(s =>
          s.name === target ||
          s.name.startsWith(target) ||
          s.title.toLowerCase() === target.toLowerCase()
        );
        if (!found) {
          ctx.print(`Session not found: ${target}\nUse /session list to see available sessions.`);
          return;
        }
        try {
          const { meta, messages } = sm.load(found.name);
          ctx.conversationManager.resetAll();
          ctx.conversationManager.fromJSON({ messages: messages as never[] });
          if (meta.title) ctx.conversationManager.title = meta.title;
          ctx.conversationManager.rebuildHistory();
          // Update runtime to reflect resumed session
          ctx.runtime.sessionId = found.name;
          if (meta.model) {
            ctx.runtime.model = meta.model;
            try { ctx.providerRegistry.setCurrentModel(meta.model); } catch { /* model may not exist locally */ }
          }
          if (meta.provider) ctx.runtime.provider = meta.provider;
          ctx.renderRequest();
          ctx.print(`Resumed session: ${found.name}\n  Name: ${meta.title || '(untitled)'}\n  Messages: ${messages.length}\n  Model: ${meta.model || ctx.runtime.model}`);
        } catch (e) {
          ctx.print(`Failed to resume session: ${(e as Error).message}`);
        }
        return;
      }

      // ── /session fork ──────────────────────────────────────
      if (sub === 'fork') {
        const newId = `user-${randomBytes(4).toString('hex')}`;
        const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
        const messages = exportData.messages ?? [];
        const currentTitle = ctx.conversationManager.title;
        const forkName = args[1] ? args.slice(1).join(' ').trim() : `fork-of-${ctx.runtime.sessionId.slice(0, 8)}`;
        const meta = {
          title: forkName,
          model: ctx.runtime.model,
          provider: ctx.runtime.provider,
          timestamp: Date.now(),
        };
        try {
          sm.save(newId, messages, meta);
          // Update active session ID to the fork
          ctx.runtime.sessionId = newId;
          ctx.conversationManager.title = forkName;
          ctx.renderRequest();
          ctx.print(`Session forked:\n  New ID: ${newId}\n  Name:   ${forkName}\n  From:   ${currentTitle || ctx.runtime.sessionId}\n  Messages: ${messages.length}`);
        } catch (e) {
          ctx.print(`Failed to fork session: ${(e as Error).message}`);
        }
        return;
      }

      // ── /session save ──────────────────────────────────────
      if (sub === 'save') {
        const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
        const messages = exportData.messages ?? [];
        const rawName = args[1] ? args.slice(1).join(' ').trim() : (ctx.conversationManager.title || ctx.runtime.sessionId);
        const meta = {
          title: ctx.conversationManager.title,
          model: ctx.runtime.model,
          provider: ctx.runtime.provider,
          timestamp: Date.now(),
        };
        try {
          const { filePath, sanitizedName } = sm.save(rawName, messages, meta);
          // Switch active session to the saved name so auto-save continues here
          ctx.runtime.sessionId = sanitizedName;
          const nameNote = sanitizedName !== rawName ? ` (saved as "${sanitizedName}")` : '';
          ctx.print(`Session saved: ${rawName}${nameNote}\n  → ${filePath}`);
        } catch (e) {
          ctx.print(`Failed to save session: ${(e as Error).message}`);
        }
        return;
      }

      // ── /session info <id> ─────────────────────────────────
      if (sub === 'info') {
        const target = args[1] || ctx.runtime.sessionId;
        const sessions = sm.list();
        const found = sessions.find(s => s.name === target || s.name.startsWith(target));
        if (!found) {
          ctx.print(`Session not found: ${target}`);
          return;
        }
        const date = new Date(found.timestamp).toLocaleString();
        const lines = [
          `Session: ${found.name}`,
          `  Title:    ${found.title || '(untitled)'}`,
          `  Model:    ${found.model || '(unknown)'}`,
          `  Provider: ${found.provider || '(unknown)'}`,
          `  Date:     ${date}`,
          `  Messages: ${found.messageCount}`,
          `  File:     ${found.filePath}`,
        ];
        ctx.print(lines.join('\n'));
        return;
      }

      // ── /session export <id> [format] ──────────────────────
      if (sub === 'export') {
        const target = args[1];
        if (!target) {
          ctx.print('Usage: /session export <session-id> [markdown|text]\nUse /session export . to export the current session.');
          return;
        }
        const format = (args[2] || 'markdown').toLowerCase();
        const sessionId = target === '.' ? ctx.runtime.sessionId : target;
        const sessions = sm.list();
        const found = sessions.find(s => s.name === sessionId || s.name.startsWith(sessionId));
        if (!found && target !== '.') {
          // Try loading by sanitized name
          try {
            const { meta, messages } = sm.load(sessionId);
            _doExport(ctx, sessionId, meta.title, messages as Array<Record<string, unknown>>, format);
          } catch {
            ctx.print(`Session not found: ${sessionId}`);
          }
          return;
        }
        const loadName = found ? found.name : sessionId;
        try {
          const { meta, messages } = sm.load(loadName);
          _doExport(ctx, loadName, meta.title, messages as Array<Record<string, unknown>>, format);
        } catch (e) {
          ctx.print(`Failed to export session: ${(e as Error).message}`);
        }
        return;
      }

      // ── /session search <query> ────────────────────────────
      if (sub === 'search') {
        const query = args.slice(1).join(' ').trim();
        if (!query) {
          ctx.print('Usage: /session search <keyword>');
          return;
        }
        const results = sm.search(query);
        if (results.length === 0) {
          ctx.print(`No sessions found matching: "${query}"`);
          return;
        }
        const lines = [`Search results for "${query}" (${results.length} session${results.length !== 1 ? 's' : ''}):\n`];
        for (const r of results) {
          const date = new Date(r.session.timestamp).toLocaleString();
          lines.push(`  ${r.session.name}  ${r.session.title || '(untitled)'}  ${date}  (${r.matchCount} match${r.matchCount !== 1 ? 'es' : ''})`);
          for (const snippet of r.snippets) {
            lines.push(`    > ${snippet}`);
          }
          lines.push('');
        }
        ctx.print(lines.join('\n'));
        return;
      }

      // ── /session delete <id> ───────────────────────────────
      if (sub === 'delete') {
        const target = args[1];
        if (!target) {
          ctx.print('Usage: /session delete <session-id>');
          return;
        }
        const sessions = sm.list();
        const found = sessions.find(s => s.name === target || s.name.startsWith(target));
        if (!found) {
          ctx.print(`Session not found: ${target}`);
          return;
        }
        if (found.name === ctx.runtime.sessionId) {
          ctx.print(`Cannot delete the active session (${found.name}).\nSwitch to another session first with /session resume <id>.`);
          return;
        }
        try {
          sm.delete(found.name);
          ctx.print(`Session deleted: ${found.name}${found.title ? ` (${found.title})` : ''}`);
        } catch (e) {
          ctx.print(`Failed to delete session: ${(e as Error).message}`);
        }
        return;
      }

      // Unknown subcommand
      ctx.print(`Unknown subcommand: ${sub}\nUsage: /session [list | rename <name> | resume <id> | fork [name] | save [name] | info [id] | export <id> [format] | search <query> | delete <id>]`);
    },
  });

  // ── /plan ─────────────────────────────────────────────────
  registry.register({
    name: 'plan',
    description: 'Manage execution plans and adaptive execution strategy',
    usage: '[list | show <id> | mode | explain | override <strategy> | status | clear | <task description>]',
    argsHint: '[list|show|mode|explain|override|status|clear|<task>]',
    handler(args, ctx) {
      // ── Adaptive planner subcommands (Section 5.5) ─────────────────────
      const PLANNER_SUBS = ['mode', 'explain', 'override', 'status', 'clear'];
      if (args.length > 0 && PLANNER_SUBS.includes(args[0].toLowerCase())) {
        const result = handlePlanCommand(args[0], args.slice(1));
        ctx.print(result.output);
        return;
      }
      // ───────────────────────────────────────────────────────────────────

      if (args.length === 0) {
        // Show active plan status
        const active = planManager.getActive();
        if (!active) {
          ctx.print('No active plan. Use /plan <task description> to create one.');
          return;
        }
        const summary = planManager.getSummary(active);
        ctx.print(`Active plan: "${active.title}" [${active.status.toUpperCase()}]\n${summary}`);
        return;
      }

      if (args[0] === 'list') {
        const plans = planManager.list();
        if (plans.length === 0) {
          ctx.print('No plans found.');
          return;
        }
        const lines = plans.map((p) => {
          const marker = p.status === 'active' ? '▶' : ' ';
          return `  ${marker} ${p.id.slice(0, 8)}  [${p.status.padEnd(8)}]  ${p.title}`;
        });
        ctx.print(`Plans (${plans.length}):\n${lines.join('\n')}`);
        return;
      }

      if (args[0] === 'show') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /plan show <plan-id>');
          return;
        }
        // Support partial ID match
        const plans = planManager.list();
        const plan = plans.find((p) => p.id === id || p.id.startsWith(id));
        if (!plan) {
          ctx.print(`Plan not found: ${id}`);
          return;
        }
        ctx.print(planManager.toMarkdown(plan));
        return;
      }

      // Otherwise: treat args as task description — classify and force project mode
      const taskDescription = args.join(' ');
      const classification = classifyIntent(taskDescription);

      // Create a draft plan with no items — real items come from the model's response.
      // awaitingPlan=true signals the orchestrator to watch for the model's plan markdown.
      const plan = planManager.create(taskDescription, []);
      plan.awaitingPlan = true;
      planManager.save(plan);

      // Wire session lineage: the plan title is the original task for this session.
      sessionLineageTracker.setOriginalTask(taskDescription.slice(0, 200));

      ctx.print(
        `Plan created: "${plan.title}" (${plan.id.slice(0, 8)})\n` +
        `Intent: ${classification.intent} (confidence: ${(classification.confidence * 100).toFixed(0)}%)\n` +
        `Signals: ${classification.signals.join(', ') || 'none'}\n` +
        `The model will write the execution plan — agents will be spawned automatically.`
      );

      // Inject format instruction as a system message before the model's turn
      ctx.conversationManager.addSystemMessage(
        `You are creating an execution plan for the following task: "${taskDescription}"\n\n` +
        `Output the plan in EXACTLY this markdown format and nothing else:\n\n` +
        `## Phase 1: [Phase Name] [PENDING]\n` +
        `- [ ] [Task description] — PENDING\n` +
        `- [ ] [Task description] — PENDING (depends: [other task description])\n\n` +
        `## Phase 2: [Phase Name] [PENDING]\n` +
        `- [ ] [Task description] — PENDING (depends: [Phase 1 task description])\n\n` +
        `Rules:\n` +
        `- Each item must be a concrete, independently executable task\n` +
        `- Use (depends: ...) only where execution order truly matters\n` +
        `- Items without dependencies in the same phase can run in parallel\n` +
        `- Keep phases to 2-4 items each, aim for maximum parallelism\n` +
        `- Output ONLY the plan markdown — the system will parse it and spawn agents automatically`
      );

      // Send the task as a user message to trigger the model's plan response
      ctx.eventBus.emit('plan:activate', { planId: plan.id, task: taskDescription });
    },
  });

  // ── /schedule ───────────────────────────────────────────
  registry.register({
    name: 'schedule',
    aliases: ['sched'],
    description: 'Manage scheduled agent tasks (cron-like)',
    usage: 'add|list|remove|enable|disable|run',
    argsHint: 'add <cron> <prompt> [--name <n>] [--tz <zone>] | list | remove <id> | enable <id> | disable <id> | run <id>',
    async handler(args, ctx) {
      const scheduler = TaskScheduler.getInstance();
      const sub = args[0];

      if (!sub || sub === 'list') {
        const tasks = scheduler.list();
        if (tasks.length === 0) {
          ctx.print('No scheduled tasks.\nUse: /schedule add "*/30 * * * *" "check build status"');
          return;
        }
        const lines = ['Scheduled tasks:', ''];
        for (const t of tasks) {
          const status = t.enabled ? '\u25cf enabled ' : '\u25cb disabled';
          const tzLabel = t.timezone ? ` [${t.timezone}]` : '';
          const fmtDate = (ms: number) => {
            try {
              const opts: Intl.DateTimeFormatOptions = t.timezone
                ? { timeZone: t.timezone, dateStyle: 'short', timeStyle: 'short' }
                : { dateStyle: 'short', timeStyle: 'short' };
              return new Intl.DateTimeFormat(undefined, opts).format(new Date(ms));
            } catch { return new Date(ms).toLocaleString(); }
          };
          const next = t.nextRun ? `next: ${fmtDate(t.nextRun)}${tzLabel}` : 'next: unknown';
          const last = t.lastRun ? `last: ${fmtDate(t.lastRun)}` : 'last: never';
          const missed = t.missedRuns > 0 ? `  missed:${t.missedRuns}` : '';
          lines.push(`  ${t.id.slice(0, 12)}  ${status}  runs:${t.runCount}${missed}  ${next}  ${last}`);
          lines.push(`    name: ${t.name || '(unnamed)'}  cron: ${t.cron}${tzLabel}`);
          lines.push(`    prompt: ${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? '…' : ''}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'add') {
        // /schedule add "<cron>" "<prompt>" [--name <name>] [--model <model>] [--template <tmpl>]
        // Args after 'add': first is cron, rest up to -- flags is the prompt.
        // We support quoted-string parsing via shell-like splitting handled by the caller.
        // args[1] = cron, args[2..] = prompt words (already split by input handler)
        const cron = args[1];
        if (!cron) {
          ctx.print('Usage: /schedule add "<cron>" "<prompt>" [--name <name>] [--model <model>] [--template <tmpl>] [--tz <timezone>]\n' +
            'Examples:\n' +
            '  /schedule add "*/30 * * * *" "check build status and report failures"\n' +
            '  /schedule add "0 9 * * 1-5" "summarize open PRs" --name morning-standup --tz America/New_York');
          return;
        }

        // Parse remaining args: collect prompt words and named flags
        const remaining = args.slice(2);
        let name: string | undefined;
        let model: string | undefined;
        let template: string | undefined;
        let timezone: string | undefined;
        const promptWords: string[] = [];

        let i = 0;
        while (i < remaining.length) {
          const tok = remaining[i];
          if (tok === '--name' && i + 1 < remaining.length) {
            name = remaining[++i];
          } else if (tok === '--model' && i + 1 < remaining.length) {
            model = remaining[++i];
          } else if (tok === '--template' && i + 1 < remaining.length) {
            template = remaining[++i];
          } else if ((tok === '--tz' || tok === '--timezone') && i + 1 < remaining.length) {
            timezone = remaining[++i];
          } else {
            promptWords.push(tok);
          }
          i++;
        }

        const prompt = promptWords.join(' ');
        if (!prompt) {
          ctx.print('Usage: /schedule add "<cron>" "<prompt>"');
          return;
        }

        try {
          const task = scheduler.add({
            name: name ?? prompt.slice(0, 40),
            cron,
            prompt,
            model,
            template,
            timezone,
            enabled: true,
          });
          const tzLabel = task.timezone ? ` [${task.timezone}]` : '';
          const fmtNext = task.nextRun
            ? (() => {
                try {
                  const opts: Intl.DateTimeFormatOptions = task.timezone
                    ? { timeZone: task.timezone, dateStyle: 'short', timeStyle: 'short' }
                    : { dateStyle: 'short', timeStyle: 'short' };
                  return new Intl.DateTimeFormat(undefined, opts).format(new Date(task.nextRun)) + tzLabel;
                } catch { return new Date(task.nextRun).toLocaleString(); }
              })()
            : 'unknown';
          ctx.print(
            `Scheduled task created: ${task.id}\n` +
            `  name: ${task.name}\n` +
            `  cron: ${cron}${tzLabel}\n` +
            `  next run: ${fmtNext}`
          );
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'remove') {
        const id = args[1];
        if (!id) { ctx.print('Usage: /schedule remove <id>'); return; }
        // Support partial ID match
        const all = scheduler.list();
        const task = all.find((t) => t.id === id || t.id.startsWith(id));
        if (!task) { ctx.print(`Task not found: ${id}`); return; }
        scheduler.remove(task.id);
        ctx.print(`Removed scheduled task: ${task.id} (${task.name || task.prompt.slice(0, 30)})`);
        return;
      }

      if (sub === 'enable') {
        const id = args[1];
        if (!id) { ctx.print('Usage: /schedule enable <id>'); return; }
        const all = scheduler.list();
        const task = all.find((t) => t.id === id || t.id.startsWith(id));
        if (!task) { ctx.print(`Task not found: ${id}`); return; }
        scheduler.setEnabled(task.id, true);
        const next = task.nextRun ? new Date(task.nextRun).toLocaleString() : 'unknown';
        ctx.print(`Enabled task: ${task.id} — next run: ${next}`);
        return;
      }

      if (sub === 'disable') {
        const id = args[1];
        if (!id) { ctx.print('Usage: /schedule disable <id>'); return; }
        const all = scheduler.list();
        const task = all.find((t) => t.id === id || t.id.startsWith(id));
        if (!task) { ctx.print(`Task not found: ${id}`); return; }
        scheduler.setEnabled(task.id, false);
        ctx.print(`Disabled task: ${task.id}`);
        return;
      }

      if (sub === 'run') {
        const id = args[1];
        if (!id) { ctx.print('Usage: /schedule run <id>'); return; }
        const all = scheduler.list();
        const task = all.find((t) => t.id === id || t.id.startsWith(id));
        if (!task) { ctx.print(`Task not found: ${id}`); return; }
        try {
          const agentId = await scheduler.runNow(task.id);
          ctx.print(`Running task ${task.id} immediately — agent: ${agentId}`);
        } catch (e) {
          ctx.print(`Error running task: ${(e as Error).message}`);
        }
        return;
      }

      ctx.print('Usage: /schedule add|list|remove|enable|disable|run\n' +
        '  /schedule add "<cron>" <prompt words...>   Create a new scheduled task\n' +
        '  /schedule list                             List all scheduled tasks\n' +
        '  /schedule remove <id>                     Remove a task\n' +
        '  /schedule enable <id>                     Enable a task\n' +
        '  /schedule disable <id>                    Disable a task\n' +
        '  /schedule run <id>                        Run a task immediately');
    },
  });

  // ── /fork ────────────────────────────────────────────
  registry.register({
    name: 'fork',
    aliases: ['branch-save'],
    description: 'Save a named snapshot of the current conversation',
    usage: '[name]',
    argsHint: '[name]',
    handler(args, ctx) {
      const name = args[0];
      const branchName = ctx.conversationManager.forkBranch(name);
      const msgCount = ctx.conversationManager.getMessageCount();
      ctx.print(`Forked conversation as "${branchName}" (${msgCount} message${msgCount === 1 ? '' : 's'}).`);
    },
  });

  // ── /branch ──────────────────────────────────────────
  registry.register({
    name: 'branch',
    aliases: ['br'],
    description: 'List conversation branches or switch to one',
    usage: '[name]',
    argsHint: '[name]',
    handler(args, ctx) {
      if (args.length === 0) {
        const branches = ctx.conversationManager.listBranches();
        if (branches.length === 0) {
          ctx.print('No branches. Use /fork [name] to create one.');
          return;
        }
        const current = ctx.conversationManager.getCurrentBranch();
        const lines = [`Branches (current: ${current}):`];
        for (const b of branches) {
          const marker = b.isCurrent ? '▶' : ' ';
          lines.push(`  ${marker} ${b.name}  (${b.messageCount} message${b.messageCount === 1 ? '' : 's'})`);
        }
        ctx.print(lines.join('\n'));
        return;
      }
      const name = args[0];
      const ok = ctx.conversationManager.switchBranch(name);
      if (!ok) {
        ctx.print(`Branch "${name}" not found. Use /fork [name] to create one, or /branch to list.`);
        return;
      }
      ctx.print(`Switched to branch "${name}".`);
      ctx.renderRequest();
    },
  });

  // ── /merge ───────────────────────────────────────────
  registry.register({
    name: 'merge',
    aliases: [],
    description: 'Append messages from a branch after the fork point',
    usage: '<name>',
    argsHint: '<name>',
    handler(args, ctx) {
      const name = args[0];
      if (!name) {
        ctx.print('Usage: /merge <branch-name>\nSee /branch for available branches.');
        return;
      }
      const ok = ctx.conversationManager.mergeBranch(name);
      if (!ok) {
        ctx.print(`Branch "${name}" not found. Use /branch to list available branches.`);
        return;
      }
      ctx.print(`Merged branch "${name}" into current conversation.`);
      ctx.renderRequest();
    },
  });

  // ── /image ─────────────────────────────────────────────
  registry.register({
    name: 'image',
    aliases: ['img'],
    description: 'Attach an image file to the next message',
    usage: '<path> [prompt text]',
    argsHint: '<path> [prompt]',
    async handler(args, ctx) {
      if (args.length === 0) {
        ctx.print('Usage: /image <path> [prompt text]\nSupported formats: PNG, JPEG, WebP, GIF');
        return;
      }

      const rawPath = args[0];
      const promptText = args.slice(1).join(' ') || `Attached image: ${rawPath.split('/').pop() ?? rawPath}`;

      // Resolve and validate the path
      let resolvedPath: string;
      try {
        resolvedPath = resolveAndValidatePath(rawPath);
      } catch (err) {
        ctx.print(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      if (!existsSync(resolvedPath)) {
        ctx.print(`File not found: ${rawPath}`);
        return;
      }

      // Determine mediaType from extension
      const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();
      const SUPPORTED_EXTS: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
      };
      const mediaType = SUPPORTED_EXTS[ext];
      if (!mediaType) {
        ctx.print(`Unsupported image format: ${ext}\nSupported: ${Object.keys(SUPPORTED_EXTS).join(', ')}`);
        return;
      }

      // Enforce file size limit
      const stat = statSync(resolvedPath);
      const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
      if (stat.size > MAX_IMAGE_BYTES) {
        ctx.print(`Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum: 20MB`);
        return;
      }

      // Read and base64-encode the file
      let data: string;
      try {
        const bytes = await readFile(resolvedPath);
        data = bytes.toString('base64');
      } catch (err) {
        ctx.print(`Failed to read image: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      // Warn if current model doesn't support multimodal (orchestrator will strip images)
      const currentModel = ctx.providerRegistry.getCurrentModel();
      if (!currentModel.capabilities.multimodal) {
        ctx.print(`Warning: ${currentModel.displayName} does not support image input. The image will be stripped when sending.`);
      }

      // Emit as a multimodal message
      const content: ContentPart[] = [
        { type: 'text', text: promptText },
        { type: 'image', data, mediaType },
      ];
      ctx.eventBus.emit('input:submit', { text: promptText, content });
    },
  });

  registry.register({
    name: 'refresh-models',
    aliases: [],
    description: 'Refresh model catalog, benchmarks, and token limits',
    async handler(_args, ctx) {
      let catalogOk = false;
      let benchmarksOk = false;
      let limitsOk = false;

      // 1. Catalog
      ctx.print('Refreshing model catalog...');
      try {
        const { refreshCatalog, getCatalogModelDefinitions } = await import('../providers/model-catalog.ts');
        await refreshCatalog();
        catalogOk = true;
        const models = getCatalogModelDefinitions();
        const providerCount = new Set(models.map((m) => m.provider)).size;
        ctx.print(`Model catalog refreshed: ${models.length} models from ${providerCount} providers`);
      } catch (e) {
        ctx.print(`Catalog refresh failed: ${(e as Error).message}`);
      }

      // 2. Benchmarks
      ctx.print('Refreshing benchmarks...');
      try {
        const { refreshBenchmarks } = await import('../providers/model-benchmarks.ts');
        await refreshBenchmarks();
        benchmarksOk = true;
        ctx.print('Benchmarks refreshed.');
      } catch (e) {
        ctx.print(`Benchmarks refresh failed: ${(e as Error).message}`);
      }

      // 3. Token limits
      ctx.print('Refreshing token limits...');
      try {
        const { refreshModelLimits } = await import('../providers/model-limits.ts');
        const count = await refreshModelLimits();
        limitsOk = true;
        ctx.print(`Token limits refreshed: ${count} models updated.`);
      } catch (e) {
        ctx.print(`Token limits refresh failed: ${(e as Error).message}`);
      }

      if (!catalogOk || !benchmarksOk || !limitsOk) {
        ctx.print('Some refreshes failed — see messages above.');
      }
    },
  });

  // ── /notify ────────────────────────────────────────────
  registry.register({
    name: 'notify',
    aliases: [],
    description: 'Manage webhook notification URLs (ntfy.sh format)',
    usage: 'add <url> | remove <url> | list | clear | test',
    argsHint: 'add|remove|list|clear|test',
    async handler(args, ctx) {
      const { WebhookNotifier, getWebhookNotifier } = await import('../integrations/webhooks.ts');
      const cm = ctx.configManager;
      const notifications = cm.getCategory('notifications');
      const urls: string[] = Array.isArray(notifications.webhookUrls)
        ? [...notifications.webhookUrls]
        : [];

      const sub = args[0];

      if (!sub || sub === 'list') {
        if (urls.length === 0) {
          ctx.print('No webhook URLs configured.\nUse: /notify add <url>');
        } else {
          ctx.print(`Webhook URLs (${urls.length}):\n${urls.map((u, i) => `  ${i + 1}. ${u}`).join('\n')}`);
        }
        return;
      }

      if (sub === 'add') {
        const url = args[1];
        if (!url) {
          ctx.print('Usage: /notify add <url>\nExample: /notify add https://ntfy.sh/my-topic');
          return;
        }
        try { new URL(url); } catch {
          ctx.print(`Invalid URL: ${url}`);
          return;
        }
        if (urls.includes(url)) {
          ctx.print(`Already configured: ${url}`);
          return;
        }
        urls.push(url);
        cm.mergeCategory('notifications', { webhookUrls: urls });
        // Sync the live notifier if running
        const liveNotifier = getWebhookNotifier();
        if (liveNotifier) liveNotifier.setUrls(urls);
        ctx.print(`Webhook added: ${url}`);
        return;
      }

      if (sub === 'remove') {
        const url = args[1];
        if (!url) {
          ctx.print('Usage: /notify remove <url>');
          return;
        }
        const next = urls.filter((u) => u !== url);
        if (next.length === urls.length) {
          ctx.print(`Not found: ${url}`);
          return;
        }
        cm.mergeCategory('notifications', { webhookUrls: next });
        // Sync the live notifier if running
        const liveNotifier = getWebhookNotifier();
        if (liveNotifier) liveNotifier.setUrls(next);
        ctx.print(`Webhook removed: ${url}`);
        return;
      }

      if (sub === 'clear') {
        cm.mergeCategory('notifications', { webhookUrls: [] });
        // Sync the live notifier if running
        const liveNotifier = getWebhookNotifier();
        if (liveNotifier) liveNotifier.setUrls([]);
        ctx.print('All webhook URLs cleared.');
        return;
      }

      if (sub === 'test') {
        if (urls.length === 0) {
          ctx.print('No webhook URLs configured. Use: /notify add <url>');
          return;
        }
        ctx.print(`Testing ${urls.length} webhook${urls.length !== 1 ? 's' : ''}...`);
        // Use the live notifier if available so the test goes through the wired instance;
        // fall back to a fresh instance only if startup wiring hasn't completed yet.
        const notifier = getWebhookNotifier() ?? WebhookNotifier.fromConfig(urls);
        const results = await notifier.test();
        const lines = results.map((r) =>
          r.ok ? `  [ok] ${r.url}` : `  [fail] ${r.url} — ${r.error ?? 'unknown error'}`
        );
        ctx.print(lines.join('\n'));
        return;
      }

      ctx.print('Usage: /notify add <url> | remove <url> | list | clear | test');
    },
  });

  // ── /diff ────────────────────────────────────────────
  registry.register({
    name: 'diff',
    aliases: ['d'],
    description: 'Show unified diff of session file changes. Uses git diff HEAD if in a git repo.',
    usage: '[session|head|working|staged|<git-ref>]',
    argsHint: '[session|head|working|staged|<ref>]',
    async handler(args, ctx) {
      const { getPanelManager } = await import('../panels/panel-manager.ts');
      const { DiffPanel } = await import('../panels/diff-panel.ts');
      const { getChangedFiles } = await import('../sessions/change-tracker.ts');

      /**
       * Fire-and-forget: compute semantic diff for each file against a git ref
       * and attach the summary to the diff panel once complete.
       * Silently no-ops if tree-sitter is unavailable or content is unreadable.
       */
      async function enrichSemanticDiff(
        panel: InstanceType<typeof DiffPanel>,
        files: string[],
        ref: string,
        renderFn: () => void,
      ): Promise<void> {
        const { computeSemanticDiff, formatSemanticDiffSummary } = await import('../renderer/semantic-diff.ts');
        const { relative: pathRelative } = await import('path');
        // Resolve repo root once for all files — git show requires paths relative to repo root
        const repoRootProc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', cwd: process.cwd() });
        await repoRootProc.exited;
        const repoRoot = (await new Response(repoRootProc.stdout).text()).trim() || process.cwd();
        await Promise.allSettled(
          files.map(async (filePath) => {
            try {
              // Resolve absolute path for file reads
              const absPath = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
              // Build repo-root-relative path for git show
              const repoRelPath = filePath.startsWith('/') ? pathRelative(repoRoot, filePath) : filePath;
              const [beforeResult, afterResult] = await Promise.allSettled([
                (async () => {
                  const proc = Bun.spawn(
                    ['git', 'show', `${ref}:${repoRelPath}`],
                    { stdout: 'pipe', stderr: 'pipe', cwd: repoRoot },
                  );
                  const [text, exitCode] = await Promise.all([
                    new Response(proc.stdout).text(),
                    proc.exited,
                  ]);
                  if (exitCode !== 0) throw new Error(`git show failed for ${repoRelPath}`);
                  return text;
                })(),
                Bun.file(absPath).text(),
              ]);
              if (beforeResult.status !== 'fulfilled' || afterResult.status !== 'fulfilled') return;
              const semanticDiff = await computeSemanticDiff(
                filePath,
                beforeResult.value,
                afterResult.value,
              );
              if (!semanticDiff) return;
              const summary = formatSemanticDiffSummary(semanticDiff);
              if (summary) {
                panel.setSemanticSummary(filePath, summary);
                renderFn();
              }
            } catch {
              // Ignore per-file failures — semantic info is best-effort
            }
          }),
        );
      }

      const pm = getPanelManager();

      // Ensure the diff panel is open and the panel sidebar is visible
      let panel = pm.getAllOpen().find(p => p.id === 'diff');
      if (!panel) {
        try {
          panel = pm.open('diff');
        } catch {
          ctx.print('Could not open diff panel.');
          return;
        }
      }
      pm.activateById('diff');
      if (!pm.isVisible()) {
        pm.show();
      }

      const diffPanel = panel as InstanceType<typeof DiffPanel>;
      const sub = (args[0] ?? 'session').toLowerCase();

      switch (sub) {
        case 'working': {
          // Unstaged changes only: git diff
          ctx.print('Loading working-tree diff...');
          await diffPanel.showGitDiff();
          ctx.print('Diff panel updated: working tree changes.');
          // Enrich with semantic diff asynchronously (best-effort)
          const workingChangedFiles = await (async () => {
            const proc = Bun.spawn(['git', 'diff', '--name-only'], { stdout: 'pipe', cwd: process.cwd() });
            await proc.exited;
            return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
          })();
          if (workingChangedFiles.length > 0) {
            enrichSemanticDiff(diffPanel, workingChangedFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
          }
          break;
        }
        case 'staged': {
          // Staged changes: git diff --cached
          ctx.print('Loading staged diff...');
          const proc = Bun.spawn(['/bin/sh', '-c', 'git diff --cached'], { stdout: 'pipe', stderr: 'pipe', cwd: process.cwd() });
          const [raw, errText] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            ctx.print(`git diff --cached failed: ${errText.trim() || 'unknown error'}`);
            return;
          }
          if (!raw.trim()) {
            ctx.print('No staged changes.');
            diffPanel.showDiff('(no staged changes)', '@@ -0,0 +0,0 @@\n No staged changes.');
          } else {
            // Feed the full multi-file diff into the panel
            diffPanel.loadRawDiff(raw);
            ctx.print('Diff panel updated: staged changes.');
            // Enrich with semantic diff asynchronously (best-effort)
            const stagedChangedFiles = await (async () => {
              const proc = Bun.spawn(['git', 'diff', '--cached', '--name-only'], { stdout: 'pipe', cwd: process.cwd() });
              await proc.exited;
              return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
            })();
            if (stagedChangedFiles.length > 0) {
              enrichSemanticDiff(diffPanel, stagedChangedFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
            }
          }
          break;
        }
        case 'head': {
          // All changes vs last commit (staged + unstaged): git diff HEAD
          ctx.print('Loading diff vs HEAD...');
          await diffPanel.showGitDiff('HEAD');
          ctx.print('Diff panel updated: all changes vs HEAD.');
          // Enrich with semantic diff asynchronously (best-effort)
          const headChangedFiles = await (async () => {
            const proc = Bun.spawn(['/bin/sh', '-c', 'git diff HEAD --name-only'], { stdout: 'pipe', cwd: process.cwd() });
            await proc.exited;
            return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
          })();
          if (headChangedFiles.length > 0) {
            enrichSemanticDiff(diffPanel, headChangedFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
          }
          break;
        }
        case 'session':
        default: {
          // Session changes: use tracked file list, fall back to git diff HEAD
          const sessionFiles = getChangedFiles();
          if (sessionFiles.length > 0) {
            ctx.print(`Loading session diff (${sessionFiles.length} file${sessionFiles.length === 1 ? '' : 's'} changed this session)...`);
            await diffPanel.showFileDiffs(sessionFiles, 'HEAD');
            ctx.print(`Diff panel updated: ${sessionFiles.length} session file${sessionFiles.length === 1 ? '' : 's'}.`);
            // Enrich with semantic diff asynchronously (best-effort)
            enrichSemanticDiff(diffPanel, sessionFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
          } else {
            // No tracked changes yet — fall back to git diff HEAD
            ctx.print('No session changes tracked yet. Showing diff vs HEAD...');
            await diffPanel.showGitDiff('HEAD');
            ctx.print('Diff panel updated: all changes vs HEAD.');
            // Enrich with semantic diff for HEAD-changed files asynchronously
            const fallbackFiles = await (async () => {
              const proc = Bun.spawn(['/bin/sh', '-c', 'git diff HEAD --name-only'], { stdout: 'pipe', cwd: process.cwd() });
              await proc.exited;
              return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
            })();
            if (fallbackFiles.length > 0) {
              enrichSemanticDiff(diffPanel, fallbackFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
            }
          }
          break;
        }
      }

      ctx.renderRequest();
    },
  });

  // ── /mcp ─────────────────────────────────────────────
  registry.register({
    name: 'mcp',
    aliases: [],
    description: 'List connected MCP servers and their tools',
    usage: '[tools [<server>]]',
    argsHint: '[tools [server]]',
    async handler(args, ctx) {
      const subcommand = args[0];

      // /mcp tools [server] — list tools from all servers or a specific one
      if (subcommand === 'tools') {
        const filterServer = args[1];
        ctx.print('Fetching MCP tool list...');
        let allTools;
        try {
          allTools = await ctx.mcpRegistry.listAllTools();
        } catch (e) {
          ctx.print(`Error listing tools: ${(e as Error).message}`);
          return;
        }
        const tools = filterServer
          ? allTools.filter(t => t.serverName === filterServer)
          : allTools;

        if (tools.length === 0) {
          const msg = filterServer
            ? `No tools found for server "${filterServer}". Is it connected? Run /mcp to see server status.`
            : 'No MCP tools available. Configure servers in .goodvibes/mcp.json or ~/.config/mcp/mcp.json.';
          ctx.print(msg);
          return;
        }

        const lines: string[] = [`MCP Tools (${tools.length} total):`];
        let lastServer = '';
        for (const tool of tools) {
          if (tool.serverName !== lastServer) {
            lines.push(`\n  [${tool.serverName}]`);
            lastServer = tool.serverName;
          }
          const desc = tool.description ? `  — ${tool.description}` : '';
          lines.push(`    ${tool.toolName}${desc}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      // /mcp (no subcommand) — list servers and their connection status
      const servers = ctx.mcpRegistry.listServers();

      if (servers.length === 0) {
        ctx.print(
          'No MCP servers configured.\n' +
          'Add servers to one of these locations (scanned in order):\n' +
          '  ~/.config/mcp/mcp.json               (global XDG)\n' +
          '  ~/.mcp/mcp.json                      (global dotdir)\n' +
          '  ~/.config/claude/claude_desktop_config.json  (Claude Desktop)\n' +
          '  .mcp/mcp.json                        (project-local)\n' +
          '  .goodvibes/mcp.json                  (goodvibes project)\n' +
          '\nFormat: { "servers": [{ "name": "my-server", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }] }'
        );
        return;
      }

      const connected = servers.filter(s => s.connected);
      const disconnected = servers.filter(s => !s.connected);
      const lines: string[] = [
        `MCP Servers (${connected.length}/${servers.length} connected):`,
      ];
      for (const s of servers) {
        const status = s.connected ? '[connected]   ' : '[disconnected]';
        lines.push(`  ${status}  ${s.name}`);
      }
      if (connected.length > 0) {
        lines.push('');
        lines.push('Run "/mcp tools" to list all tools, or "/mcp tools <server>" for a specific server.');
      }
      if (disconnected.length > 0) {
        lines.push('');
        lines.push(`${disconnected.length} server(s) failed to connect. Check server command and args in your config.`);
      }
      ctx.print(lines.join('\n'));
    },
  });

  // ── /share ────────────────────────────────────────────────────────────────
  registry.register({
    name: 'share',
    aliases: [],
    description: 'Export the current session to a shareable format (html, json, md)',
    usage: '<html|json|md> [path] [--redact]',
    argsHint: '<html|json|md> [path]',
    async handler(args, ctx) {
      const FORMATS = ['html', 'json', 'md'] as const;
      type Format = typeof FORMATS[number];

      const format = args[0]?.toLowerCase() as Format | undefined;
      if (!format || !FORMATS.includes(format)) {
        ctx.print(
          'Usage: /share <html|json|md> [path] [--redact]\n' +
          '  html  — self-contained HTML with syntax highlighting\n' +
          '  json  — structured JSON (machine-readable)\n' +
          '  md    — Markdown\n' +
          '\n' +
          'Options:\n' +
          '  --redact  Redact API keys and personal paths from output\n' +
          '\n' +
          `Default path: ~/goodvibes-exports/session-<timestamp>.<ext>`,
        );
        return;
      }

      const remainingArgs = args.slice(1);
      const redact = remainingArgs.includes('--redact');
      const pathArgs = remainingArgs.filter(a => a !== '--redact');

      // Resolve output path
      let outputPath: string;
      if (pathArgs.length > 0) {
        const rawPath = pathArgs[0].replace(/^~/, homedir());
        // Path-traversal protection: if user supplies an absolute path outside
        // the project, we allow it (shares are exported for external use).
        // We still normalise to catch double-dots.
        outputPath = resolve(rawPath);
        // Note: path.resolve() always returns an absolute path on POSIX, so the
        // startsWith('/') guard was dead code. Exports are intentionally unrestricted
        // — users may share files to any location on the filesystem.
      } else {
        outputPath = defaultExportPath(format);
      }

      // Gather conversation messages from ConversationManager
      const convData = ctx.conversationManager.toJSON() as {
        messages: Array<{
          role: string;
          content: unknown;
          toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
          callId?: string;
          toolName?: string;
          reasoningContent?: string;
          reasoningSummary?: string;
          usage?: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
          cancelled?: boolean;
        }>;
      };

      if (!convData.messages || convData.messages.length === 0) {
        ctx.print('Nothing to export — conversation is empty.');
        return;
      }

      // Map to ExportMessage shape
      type ExportMsg = import('../export/session-export.ts').ExportMessage;
      const messages: ExportMsg[] = convData.messages.map(m => ({
        role: m.role as ExportMsg['role'],
        content: m.content as string,
        toolCalls: m.toolCalls,
        callId: m.callId,
        toolName: m.toolName,
        reasoningContent: m.reasoningContent,
        reasoningSummary: m.reasoningSummary,
        usage: m.usage,
        cancelled: m.cancelled,
      }));

      const metadata = {
        model: ctx.runtime.model,
        provider: ctx.runtime.provider,
        sessionId: ctx.runtime.sessionId,
        title: ctx.conversationManager.title || undefined,
      };

      const options = { redact };

      let outputContent: string;
      try {
        if (format === 'html') {
          outputContent = exportToHTML(messages, metadata, options);
        } else if (format === 'json') {
          outputContent = exportToJSON(messages, metadata, options);
        } else {
          outputContent = exportToMarkdownExtended(messages, metadata, options);
        }
      } catch (err) {
        ctx.print(`Export failed: ${(err as Error).message}`);
        return;
      }

      // Ensure output directory exists
      const { mkdirSync: _mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      try {
        _mkdirSync(dirname(outputPath), { recursive: true });
      } catch (mkdirErr) {
        // Non-fatal: writeFile will surface a clearer error if the directory
        // could not be created. Log for diagnostics.
        logger.warn(`[share] mkdir failed for ${dirname(outputPath)}:`, mkdirErr instanceof Error ? { message: mkdirErr.message } : undefined);
      }

      try {
        await writeFile(outputPath, outputContent, 'utf-8');
      } catch (err) {
        ctx.print(`Failed to write export: ${(err as Error).message}`);
        return;
      }

      const redactNote = redact ? ' (sensitive data redacted)' : '';
      ctx.print(`Exported ${format.toUpperCase()} session to ${outputPath}${redactNote}`);
    },
  });

  // ── /plugin ──────────────────────────────────────────────────────────────
  registry.register({
    name: 'plugin',
    aliases: [],
    description: 'Manage plugins (list, enable, disable, reload)',
    usage: 'list | enable <name> | disable <name> | reload',
    argsHint: 'list | enable | disable | reload',
    async handler(args, ctx) {
      const sub = args[0];

      if (!sub || sub === 'list') {
        const plugins = pluginManager.list() as PluginStatus[];
        if (plugins.length === 0) {
          ctx.print(
            'No plugins installed.\n' +
            `Plugin directory: ${PLUGINS_DIR}\n` +
            'Place a plugin folder there with manifest.json and index.ts.'
          );
          return;
        }
        const lines: string[] = ['Installed plugins:'];
        for (const p of plugins) {
          const statusIcon = p.active ? '[active]  ' : p.enabled ? '[loading] ' : '[disabled]';
          lines.push(`  ${statusIcon}  ${p.name.padEnd(24)} v${p.version}  —  ${p.description}`);
          if (p.author) lines.push(`            by ${p.author}`);
        }
        lines.push('');
        lines.push('Use /plugin enable <name> or /plugin disable <name> to toggle plugins.');
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'enable') {
        const name = args[1];
        if (!name) { ctx.print('Usage: /plugin enable <name>'); return; }
        const result = await pluginManager.enable(name);
        if (result.ok) {
          ctx.print(`Plugin '${name}' enabled and activated.`);
        } else {
          ctx.print(`Error: ${result.error}`);
        }
        return;
      }

      if (sub === 'disable') {
        const name = args[1];
        if (!name) { ctx.print('Usage: /plugin disable <name>'); return; }
        const result = await pluginManager.disable(name);
        if (result.ok) {
          ctx.print(`Plugin '${name}' disabled.`);
        } else {
          ctx.print(`Error: ${result.error}`);
        }
        return;
      }

      if (sub === 'reload') {
        ctx.print('Reloading plugins...');
        const { reloaded, failed } = await pluginManager.reload();
        ctx.print(`Done. ${reloaded} plugin(s) reloaded${failed > 0 ? `, ${failed} failed` : ''}.`);
        return;
      }

      ctx.print(
        'Usage: /plugin <subcommand>\n' +
        '  list              — show installed plugins and their status\n' +
        '  enable <name>     — enable a plugin\n' +
        '  disable <name>    — disable a plugin\n' +
        '  reload            — reload all enabled plugins'
      );
    },
  });

  // ── /pin ─────────────────────────────────────────────────────────────────
  registry.register({
    name: 'pin',
    description: 'Pin a model to the favorites list',
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const modelId = args[0];
      if (!modelId) {
        const pinned = await getPinned();
        if (pinned.length === 0) {
          ctx.print('No pinned models. Use /pin <model-id> to pin one.');
        } else {
          ctx.print('Pinned models:\n' + pinned.map(id => `  ★ ${id}`).join('\n'));
        }
        return;
      }
      const alreadyPinned = await isModelPinned(modelId);
      if (alreadyPinned) {
        ctx.print(`Model already pinned: ${modelId}`);
        return;
      }
      await pinModel(modelId);
      ctx.print(`Pinned: ${modelId}`);
    },
  });

  // ── /unpin ───────────────────────────────────────────────────────────────
  registry.register({
    name: 'unpin',
    description: 'Unpin a model from the favorites list',
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const modelId = args[0];
      if (!modelId) {
        ctx.print('Usage: /unpin <model-id>');
        return;
      }
      const wasPinned = await isModelPinned(modelId);
      if (!wasPinned) {
        ctx.print(`Model is not pinned: ${modelId}`);
        return;
      }
      await unpinModel(modelId);
      ctx.print(`Unpinned: ${modelId}`);
    },
  });

  // ── /git ──────────────────────────────────────────────────────────────────
  registry.register({
    name: 'git',
    aliases: ['g'],
    description: 'Git repository commands — status, log, diff',
    usage: '[status|log|diff]',
    argsHint: '[status|log|diff]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'status';
      const cwd = process.cwd();

      // Auto-initialise if not already a git repo
      if (!GitService.isGitRepo(cwd)) {
        const initResult = GitService.initRepo(cwd);
        if (!initResult.success) {
          ctx.print(`Failed to initialise git repository: ${initResult.error ?? 'unknown error'}`);
          return;
        }
        ctx.print(`Initialized git repository in ${cwd}`);
      }

      const git = GitService.getInstance(cwd);

      switch (sub) {
        case 'status': {
          try {
            const st = await git.status();
            const lines: string[] = ['Git status:'];
            if (st.isClean()) {
              lines.push('  Working tree clean — nothing to commit.');
            } else {
              if (st.staged.length > 0) {
                lines.push(`  Staged (${st.staged.length}):`);
                for (const f of st.staged) lines.push(`    + ${f}`);
              }
              if (st.modified.length > 0) {
                lines.push(`  Modified (${st.modified.length}):`);
                for (const f of st.modified) lines.push(`    ~ ${f}`);
              }
              if (st.not_added.length > 0) {
                lines.push(`  Untracked (${st.not_added.length}):`);
                for (const f of st.not_added) lines.push(`    ? ${f}`);
              }
              if (st.deleted.length > 0) {
                lines.push(`  Deleted (${st.deleted.length}):`);
                for (const f of st.deleted) lines.push(`    - ${f}`);
              }
            }
            ctx.print(lines.join('\n'));
          } catch (e) {
            ctx.print(`Git status failed: ${(e as Error).message}`);
          }
          break;
        }
        case 'log': {
          try {
            const entries = await git.log(10);
            const lines: string[] = [`Recent commits (${entries.length}):`];
            for (const entry of entries) {
              const date = entry.date.slice(0, 10);
              const hash = entry.hash.slice(0, 7);
              lines.push(`  ${hash}  ${date}  ${entry.message}`);
            }
            ctx.print(lines.join('\n'));
          } catch (e) {
            ctx.print(`Git log failed: ${(e as Error).message}`);
          }
          break;
        }
        case 'diff': {
          try {
            const diffText = await git.diff();
            if (!diffText.trim()) {
              ctx.print('No unstaged changes.');
            } else {
              // Truncate large diffs to keep TUI output manageable
              const MAX_DIFF = 4000;
              const output = diffText.length > MAX_DIFF
                ? diffText.slice(0, MAX_DIFF) + '\n\n...(diff truncated)'
                : diffText;
              ctx.print(output);
            }
          } catch (e) {
            ctx.print(`Git diff failed: ${(e as Error).message}`);
          }
          break;
        }
        default:
          ctx.print('Usage: /git [status|log|diff]\n  /git          — working tree status (default)\n  /git status   — working tree status\n  /git log      — recent commits\n  /git diff     — unstaged changes');
      }
    },
  });

  // ── /memory ──────────────────────────────────────────────
  registry.register({
    name: 'memory',
    description: 'Manage session memories (pinned across context compaction)',
    usage: '[list|add <text>|remove <id>]',
    argsHint: '[list|add|remove]',
    handler(args, ctx) {
      const sub = args[0] ?? 'list';

      if (sub === 'list' || args.length === 0) {
        const memories = sessionMemoryStore.list();
        if (memories.length === 0) {
          ctx.print('No session memories. Use !# prefix or /memory add <text> to create one.');
        } else {
          const lines = [
            `Session Memories (${memories.length}):`,
            ...memories.map(m => `  [${m.id}] ${m.text}`),
          ];
          ctx.print(lines.join('\n'));
        }

      } else if (sub === 'add') {
        const text = args.slice(1).join(' ').trim();
        if (!text) {
          ctx.print('Usage: /memory add <text>');
          return;
        }
        const id = sessionMemoryStore.add(text);
        ctx.print(`Memory added: [${id}] ${text}`);

      } else if (sub === 'remove') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /memory remove <id>');
          return;
        }
        const removed = sessionMemoryStore.remove(id);
        if (removed) {
          ctx.print(`Memory removed: [${id}]`);
        } else {
          ctx.print(`Memory not found: ${id}`);
        }

      } else {
        ctx.print(
          `Usage: /memory [list|add <text>|remove <id>]
  /memory              — list all session memories
  /memory list         — list all session memories
  /memory add <text>   — add a memory without sending a message
  /memory remove <id>  — remove a specific memory`
        );
      }
    },
  });

  // ── /mode ────────────────────────────────────────────────────────────────────
  registry.register({
    name: 'mode',
    aliases: ['hitl'],
    description: 'Manage HITL UX notification mode (quiet/balanced/operator)',
    usage: '[quiet|balanced|operator|show|set-domain <domain> <verbosity>]',
    argsHint: '[preset|show|set-domain]',
    handler(args, ctx) {
      const mgr = ModeManager.getInstance();
      const sub = args[0] ?? 'show';

      if (sub === 'quiet' || sub === 'balanced' || sub === 'operator') {
        const newMode = sub as 'quiet' | 'balanced' | 'operator';
        mgr.setHITLMode(newMode);
        try {
          ctx.configManager.setDynamic('behavior.hitlMode' as import('../config/schema.ts').ConfigKey, newMode);
        } catch (e) {
          logger.warn('[/mode] Failed to persist mode:', e);
        }
        const preset = mgr.getHITLPreset();
        ctx.print(`HITL mode set to: ${preset.name}\n${preset.description}`);
        ctx.renderRequest();
        return;
      }

      if (sub === 'show') {
        const current = mgr.getHITLMode();
        const preset = mgr.getHITLPreset();
        const overrides = mgr.getDomainOverrides();
        const lines: string[] = [
          `HITL mode: ${current}`,
          `  ${preset.description}`,
          `  Default domain verbosity: ${preset.defaultDomainVerbosity}`,
          `  Quiet-while-typing: ${preset.quietWhileTyping}`,
          `  Batch window: ${preset.batchWindowMs}ms`,
        ];
        const overrideEntries = Object.entries(overrides);
        if (overrideEntries.length > 0) {
          lines.push('  Per-domain overrides:');
          for (const [domain, verbosity] of overrideEntries) {
            lines.push(`    ${domain}: ${verbosity}`);
          }
        } else {
          lines.push('  No per-domain overrides.');
        }
        lines.push('');
        lines.push('Available presets:');
        for (const p of mgr.listHITLPresets()) {
          const marker = p.name === current ? '\u25b6' : ' ';
          lines.push(`  ${marker} ${p.name.padEnd(10)} ${p.description}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'set-domain') {
        const domain = args[1];
        const verbosity = args[2];
        if (!domain || !verbosity) {
          ctx.print('Usage: /mode set-domain <domain> <minimal|normal|verbose>');
          return;
        }
        if (verbosity !== 'minimal' && verbosity !== 'normal' && verbosity !== 'verbose') {
          ctx.print(`Invalid verbosity "${verbosity}". Valid values: minimal, normal, verbose`);
          return;
        }
        mgr.setDomainVerbosity(domain, verbosity as 'minimal' | 'normal' | 'verbose');
        ctx.print(`Domain "${domain}" verbosity set to: ${verbosity}`);
        return;
      }

      ctx.print(
        'Usage: /mode [quiet|balanced|operator|show|set-domain <domain> <verbosity>]\n'
        + '  /mode                          — show current mode and settings\n'
        + '  /mode show                     — show current mode and settings\n'
        + '  /mode quiet                    — suppress all non-critical notifications\n'
        + '  /mode balanced                 — surface warnings, batch info noise (default)\n'
        + '  /mode operator                 — full verbosity, no suppression\n'
        + '  /mode set-domain <d> <v>       — per-domain verbosity override (minimal|normal|verbose)'
      );
    },
  });

  // ── /ops ──────────────────────────────────────────────
  registry.register({
    name: 'ops',
    description: 'Operator Control Plane: view audit log, cancel/pause/resume/retry tasks and agents',
    usage: 'view | task <cancel|pause|resume|retry> <id> [note] | agent cancel <id> [note]',
    argsHint: '[view|task|agent]',
    handler(args, ctx) {
      const sub = args[0];

      if (sub === 'view' || sub === undefined) {
        if (ctx.openOpsPanel) {
          ctx.openOpsPanel();
        } else {
          ctx.print('Operator Control Plane panel is not available. Enable the operator-control-plane feature flag.');
        }
        return;
      }

      if (sub === 'task') {
        const action = args[1];
        const taskId = args[2];
        const note   = args.slice(3).join(' ') || undefined;
        if (!action || !taskId) {
          ctx.print('Usage: /ops task <cancel|pause|resume|retry> <task-id> [note]');
          return;
        }
        if (!ctx.opsControlPlane) {
          ctx.print('Operator Control Plane not active. Enable the operator-control-plane feature flag.');
          return;
        }
        try {
          switch (action) {
            case 'cancel': ctx.opsControlPlane.cancelTask(taskId, note); break;
            case 'pause':  ctx.opsControlPlane.pauseTask(taskId, note);  break;
            case 'resume': ctx.opsControlPlane.resumeTask(taskId, note); break;
            case 'retry':  ctx.opsControlPlane.retryTask(taskId, note);  break;
            default:
              ctx.print(`Unknown task action "${action}". Use: cancel, pause, resume, retry`);
              return;
          }
          ctx.print(`[Ops] Task ${taskId}: ${action} dispatched.`);
        } catch (e) {
          ctx.print(`[Ops] Error: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'agent') {
        const action = args[1];
        const agentId = args[2];
        const note    = args.slice(3).join(' ') || undefined;
        if (action !== 'cancel' || !agentId) {
          ctx.print('Usage: /ops agent cancel <agent-id> [note]');
          return;
        }
        if (!ctx.opsControlPlane) {
          ctx.print('Operator Control Plane not active. Enable the operator-control-plane feature flag.');
          return;
        }
        try {
          ctx.opsControlPlane.cancelAgent(agentId, note);
          ctx.print(`[Ops] Agent ${agentId}: cancel dispatched.`);
        } catch (e) {
          ctx.print(`[Ops] Error: ${(e as Error).message}`);
        }
        return;
      }

      ctx.print(
        'Usage: /ops <subcommand>\n'
        + '  /ops view                              — open the Ops Control panel (Ctrl+O)\n'
        + '  /ops task cancel <id> [note]           — cancel a task\n'
        + '  /ops task pause  <id> [note]           — pause a task\n'
        + '  /ops task resume <id> [note]           — resume a blocked task\n'
        + '  /ops task retry  <id> [note]           — retry a failed task\n'
        + '  /ops agent cancel <id> [note]          — cancel a running agent'
      );
    },
  });
}

/**
 * _doExport - Format and output a session's messages as markdown or plain text.
 * Used by /session export.
 */
function _doExport(
  ctx: { print: (text: string) => void },
  sessionId: string,
  title: string,
  messages: Array<Record<string, unknown>>,
  format: string,
): void {
  const lines: string[] = [];
  if (format === 'markdown') {
    lines.push(`# Session: ${title || sessionId}`);
    lines.push('');
    for (const msg of messages) {
      const role = String(msg.role ?? 'unknown');
      const content = String(msg.content ?? '');
      if (!content.trim()) continue;
      if (role === 'user') {
        lines.push(`## User`);
        lines.push('');
        lines.push(content);
        lines.push('');
      } else if (role === 'assistant') {
        lines.push(`## Assistant`);
        lines.push('');
        lines.push(content);
        lines.push('');
      } else if (role === 'tool') {
        const toolName = String(msg.toolName ?? 'tool');
        lines.push(`## Tool Result: ${toolName}`);
        lines.push('');
        lines.push('```');
        lines.push(content.slice(0, 2000) + (content.length > 2000 ? '\n...(truncated)' : ''));
        lines.push('```');
        lines.push('');
      }
    }
  } else {
    // Plain text format
    for (const msg of messages) {
      const role = String(msg.role ?? 'unknown').toUpperCase();
      const content = String(msg.content ?? '');
      if (!content.trim()) continue;
      lines.push(`[${role}]`);
      lines.push(content);
      lines.push('');
    }
  }
  ctx.print(lines.join('\n'));
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

