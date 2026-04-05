import type { CommandRegistry } from '../command-registry.ts';
import { CONFIG_SCHEMA, type ConfigKey } from '../../config/index.ts';
import { getProfileManager } from '../../profiles/manager.ts';

function coerceValue(
  raw: string,
  type: 'boolean' | 'number' | 'string' | 'enum',
  enumValues?: string[],
): unknown {
  switch (type) {
    case 'boolean':
      if (raw === 'true' || raw === '1' || raw === 'yes') return true;
      if (raw === 'false' || raw === '0' || raw === 'no') return false;
      throw new Error(`Expected true/false, got: ${raw}`);
    case 'number': {
      const n = Number(raw);
      if (isNaN(n)) throw new Error(`Expected a number, got: ${raw}`);
      return n;
    }
    case 'enum':
      if (enumValues && !enumValues.includes(raw)) {
        throw new Error(`Expected one of: ${enumValues.join(', ')}; got: ${raw}`);
      }
      return raw;
    case 'string':
    default:
      return raw;
  }
}

export function registerConfigCommand(registry: CommandRegistry): void {
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
            const data = currentConfig as Record<string, unknown>;
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
            for (const [key, value] of Object.entries(data)) {
              const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
              if (!schema) continue;
              cm.setDynamic(key as ConfigKey, value);
              if (key === 'provider.model') ctx.runtime.model = value as string;
              if (key === 'provider.provider') ctx.runtime.provider = value as string;
              if (key === 'provider.reasoningEffort') ctx.runtime.reasoningEffort = value as string;
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
          if (deleted) ctx.print(`Profile deleted: ${profileName}`);
          else ctx.print(`Profile not found: ${profileName}`);
          return;
        }

        ctx.print(`Unknown profile subcommand: ${sub}\nUsage: /config profile save|load|list|delete <name>`);
        return;
      }

      if (args[0] === 'diff') {
        const lines = ['Changed settings:'];
        let changed = 0;
        for (const setting of CONFIG_SCHEMA) {
          try {
            const value = cm.get(setting.key);
            if (JSON.stringify(value) !== JSON.stringify(setting.default)) {
              changed++;
              lines.push(`  ${setting.key.padEnd(36)} ${String(value)}  (default: ${String(setting.default)})`);
            }
          } catch {
            // ignore invalid reads
          }
        }
        if (changed === 0) lines.push('  (none)');
        ctx.print(lines.join('\n'));
        return;
      }

      if (args[0] === 'reset') {
        const resetKey = args[1];
        if (!resetKey) {
          ctx.print('Usage: /config reset <key>');
          return;
        }
        const schema = CONFIG_SCHEMA.find((entry) => entry.key === resetKey);
        if (!schema) {
          ctx.print(`Unknown config key: ${resetKey}`);
          return;
        }
        try {
          cm.setDynamic(resetKey as ConfigKey, schema.default);
          if (resetKey === 'provider.model') ctx.runtime.model = schema.default as string;
          if (resetKey === 'provider.provider') ctx.runtime.provider = schema.default as string;
          if (resetKey === 'provider.reasoningEffort') ctx.runtime.reasoningEffort = schema.default as string;
          ctx.print(`Reset ${resetKey} to default: ${String(schema.default)}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }

      if (args.length === 0) {
        if (ctx.openSelection) {
          const items = CONFIG_SCHEMA.map((schema) => {
            let current = '';
            try {
              current = String(cm.get(schema.key));
            } catch {
              current = '(unavailable)';
            }
            return {
              id: schema.key,
              label: schema.key,
              detail: `${current} — ${schema.description}`,
              category: schema.key.split('.')[0],
            };
          });
          ctx.openSelection('Config Settings', items, { allowSearch: true }, (result) => {
            if (!result) return;
            const key = result.item.id as ConfigKey;
            const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
            if (!schema) return;
            const value = cm.get(key);
            const lines = [
              `${key}`,
              `  value:   ${String(value)}`,
              `  default: ${String(schema.default)}`,
              `  type:    ${schema.type}${schema.enumValues ? ` (${schema.enumValues.join(', ')})` : ''}`,
              `  desc:    ${schema.description}`,
            ];
            ctx.print(lines.join('\n'));
          });
          return;
        }
        const lines: string[] = ['Config settings:'];
        for (const cat of categories) {
          lines.push(`  [${cat}]`);
          const catObj = all[cat] as Record<string, unknown>;
          for (const [field, val] of Object.entries(catObj)) {
            const key = `${cat}.${field}`;
            const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
            const desc = schema ? ` — ${schema.description}` : '';
            lines.push(`    ${key.padEnd(36)} ${String(val)}${desc}`);
          }
        }
        ctx.print(lines.join('\n'));
        return;
      }

      const firstArg = args[0];
      if (categories.includes(firstArg as typeof categories[number]) && args.length === 1) {
        const cat = firstArg as typeof categories[number];
        const catObj = all[cat] as Record<string, unknown>;
        const lines: string[] = [`[${cat}]`];
        for (const [field, val] of Object.entries(catObj)) {
          const key = `${cat}.${field}`;
          const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
          const desc = schema ? ` — ${schema.description}` : '';
          lines.push(`  ${key.padEnd(36)} ${String(val)}${desc}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (args.length === 1 && firstArg.includes('.')) {
        const key = firstArg as ConfigKey;
        const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
        if (!schema) {
          ctx.print(`Unknown config key: ${key}\nRun /config to see all keys.`);
          return;
        }
        try {
          const val = cm.get(key);
          const lines = [
            `${key}`,
            `  value:   ${String(val)}`,
            `  default: ${String(schema.default)}`,
            `  type:    ${schema.type}${schema.enumValues ? ` (${schema.enumValues.join(', ')})` : ''}`,
            `  desc:    ${schema.description}`,
          ];
          ctx.print(lines.join('\n'));
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }

      if (args.length >= 2 && firstArg.includes('.')) {
        const key = firstArg as ConfigKey;
        const rawValue = args.slice(1).join(' ');
        const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
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
          if (key === 'provider.model') ctx.runtime.model = coerced as string;
          if (key === 'provider.provider') ctx.runtime.provider = coerced as string;
          if (key === 'provider.reasoningEffort') ctx.runtime.reasoningEffort = coerced as string;
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }

      if (args.length >= 2) {
        const [key, ...rest] = args;
        const value = rest.join(' ');
        switch (key) {
          case 'system':
          case 'systemPrompt':
            ctx.runtime.systemPrompt = value;
            ctx.print('System prompt updated (runtime only; use provider.systemPromptFile for persistence).');
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

      ctx.print('Usage: /config [category|key] [value]\n/config reset [key]');
    },
  });
}
