import type { CommandRegistry } from '../command-registry.ts';
import { CONFIG_SCHEMA, type ConfigKey } from '../../config/index.ts';
import { configSnapshotToProfileData, profileDataToConfigSnapshot } from '../../profiles/shape.ts';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { requireProfileManager } from './runtime-services.ts';

interface ConfigBundle {
  readonly schemaVersion: 'v1';
  readonly exportedAt: number;
  readonly config: Record<string, unknown>;
  readonly services?: Record<string, unknown>;
  readonly ecosystem?: {
    readonly plugins?: Record<string, unknown>;
    readonly skills?: Record<string, unknown>;
  };
}

function roundToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function getConfigSelectionAdjustmentMeta(schema: { key: ConfigKey; type: 'boolean' | 'number' | 'string' | 'enum' }) {
  if (schema.type !== 'number') return {};
  if (schema.key === 'wrfc.scoreThreshold') {
    return {
      adjustStep: 0.1,
      adjustMin: 0,
      adjustMax: 10,
      adjustPrecision: 1,
    };
  }
  return {
    adjustStep: 1,
  };
}

function inspectConfigBundle(bundle: ConfigBundle): string {
  const ecosystemPluginCount = bundle.ecosystem?.plugins && Array.isArray((bundle.ecosystem.plugins as { entries?: unknown[] }).entries)
    ? ((bundle.ecosystem.plugins as { entries: unknown[] }).entries.length)
    : 0;
  const ecosystemSkillCount = bundle.ecosystem?.skills && Array.isArray((bundle.ecosystem.skills as { entries?: unknown[] }).entries)
    ? ((bundle.ecosystem.skills as { entries: unknown[] }).entries.length)
    : 0;
  return [
    'Config Bundle Review',
    `  schemaVersion: ${bundle.schemaVersion}`,
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  config keys: ${Object.keys(bundle.config ?? {}).length}`,
    `  includes services: ${bundle.services ? 'yes' : 'no'}`,
    `  curated plugins: ${ecosystemPluginCount}`,
    `  curated skills: ${ecosystemSkillCount}`,
  ].join('\n');
}

function readOptionalJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function buildConfigSnapshot(
  manager: { get: (key: ConfigKey) => unknown },
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    try {
      snapshot[entry.key] = structuredClone(manager.get(entry.key));
    } catch {
      // ignore unreadable keys
    }
  }
  return snapshot;
}

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
        const pm = requireProfileManager(ctx);
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
            const data = configSnapshotToProfileData(currentConfig as Record<string, unknown>);
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
            for (const [key, value] of Object.entries(profileDataToConfigSnapshot(data))) {
              const schema = CONFIG_SCHEMA.find((entry) => entry.key === key as ConfigKey);
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

      if (args[0] === 'bundle') {
        const sub = args[1];
        const bundlePath = args[2];
        if (sub === 'export') {
          if (!bundlePath) {
            ctx.print('Usage: /config bundle export <path>');
            return;
          }
          const targetPath = resolve(process.cwd(), bundlePath);
          const servicesPath = join(process.cwd(), '.goodvibes', 'tui', 'services.json');
          const pluginCatalogPath = join(process.cwd(), '.goodvibes', 'tui', 'ecosystem', 'plugins.json');
          const skillCatalogPath = join(process.cwd(), '.goodvibes', 'tui', 'ecosystem', 'skills.json');
          const bundle: ConfigBundle = {
            schemaVersion: 'v1',
            exportedAt: Date.now(),
            config: buildConfigSnapshot(cm),
            services: readOptionalJson(servicesPath),
            ecosystem: {
              plugins: readOptionalJson(pluginCatalogPath),
              skills: readOptionalJson(skillCatalogPath),
            },
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Config bundle exported to ${targetPath}`);
          return;
        }

        if (sub === 'inspect') {
          if (!bundlePath) {
            ctx.print('Usage: /config bundle inspect <path>');
            return;
          }
          const sourcePath = resolve(process.cwd(), bundlePath);
          try {
            const bundle = JSON.parse(readFileSync(sourcePath, 'utf-8')) as ConfigBundle;
            ctx.print(`${inspectConfigBundle(bundle)}\n  path: ${sourcePath}`);
          } catch (error) {
            ctx.print(`Failed to read config bundle: ${(error as Error).message}`);
          }
          return;
        }

        if (sub === 'import') {
          if (!bundlePath) {
            ctx.print('Usage: /config bundle import <path>');
            return;
          }
          const sourcePath = resolve(process.cwd(), bundlePath);
          let bundle: ConfigBundle;
          try {
            bundle = JSON.parse(readFileSync(sourcePath, 'utf-8')) as ConfigBundle;
          } catch (error) {
            ctx.print(`Failed to read config bundle: ${(error as Error).message}`);
            return;
          }
          for (const entry of CONFIG_SCHEMA) {
            const value = (bundle.config as Record<string, unknown>)[entry.key];
            if (value === undefined) continue;
            cm.setDynamic(entry.key, value);
            if (entry.key === 'provider.model') ctx.runtime.model = value as string;
            if (entry.key === 'provider.provider') ctx.runtime.provider = value as string;
            if (entry.key === 'provider.reasoningEffort') ctx.runtime.reasoningEffort = value as string;
          }

          const ecosystemDir = join(process.cwd(), '.goodvibes', 'tui', 'ecosystem');
          if (bundle.services) {
            mkdirSync(dirname(join(process.cwd(), '.goodvibes', 'tui', 'services.json')), { recursive: true });
            writeFileSync(join(process.cwd(), '.goodvibes', 'tui', 'services.json'), JSON.stringify(bundle.services, null, 2) + '\n', 'utf-8');
          }
          if (bundle.ecosystem?.plugins) {
            mkdirSync(ecosystemDir, { recursive: true });
            writeFileSync(join(ecosystemDir, 'plugins.json'), JSON.stringify(bundle.ecosystem.plugins, null, 2) + '\n', 'utf-8');
          }
          if (bundle.ecosystem?.skills) {
            mkdirSync(ecosystemDir, { recursive: true });
            writeFileSync(join(ecosystemDir, 'skills.json'), JSON.stringify(bundle.ecosystem.skills, null, 2) + '\n', 'utf-8');
          }
          ctx.print(`Config bundle imported from ${sourcePath}`);
          return;
        }

        ctx.print('Usage: /config bundle export <path> | inspect <path> | import <path>');
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
            const toggleable = schema.type === 'boolean' || schema.type === 'enum';
            const adjustable = toggleable || schema.type === 'number';
            const adjustmentMeta = getConfigSelectionAdjustmentMeta(schema);
            return {
              id: schema.key,
              label: schema.key,
              detail: `${current} — ${schema.description}`,
              category: schema.key.split('.')[0],
              primaryAction: toggleable ? 'toggle' as const : 'select' as const,
              adjustable,
              ...adjustmentMeta,
              actions: schema.type === 'number'
                ? '[←/→] adjust  [⇧←/⇧→] ±10  [Enter] inspect'
                : toggleable
                ? '[Space/Enter] toggle  [←/→] adjust'
                : '[Enter] inspect',
            };
          });
          ctx.openSelection('Config Settings', items, { allowSearch: true }, (result) => {
            if (!result) return;
            const key = result.item.id as ConfigKey;
            const schema = CONFIG_SCHEMA.find((entry) => entry.key === key);
            if (!schema) return;
            if ((result.action === 'toggle' || result.action === 'increment' || result.action === 'decrement')
              && (schema.type === 'boolean' || schema.type === 'enum' || schema.type === 'number')) {
              const currentValue = cm.get(key);
              let nextValue: unknown = currentValue;
              if (schema.type === 'boolean') {
                if (result.action === 'increment') nextValue = true;
                else if (result.action === 'decrement') nextValue = false;
                else {
                  nextValue = !Boolean(currentValue);
                }
              } else if (schema.type === 'enum' && schema.enumValues && schema.enumValues.length > 0) {
                const currentIndex = Math.max(0, schema.enumValues.indexOf(String(currentValue)));
                if (result.action === 'decrement') {
                  nextValue = schema.enumValues[(currentIndex - 1 + schema.enumValues.length) % schema.enumValues.length]!;
                } else {
                  nextValue = schema.enumValues[(currentIndex + 1) % schema.enumValues.length]!;
                }
              } else if (schema.type === 'number') {
                const currentNumber = Number(currentValue);
                const delta = result.action === 'decrement' ? -(result.step ?? 1) : (result.step ?? 1);
                const precision = result.item.adjustPrecision ?? 0;
                const rounded = roundToPrecision(currentNumber + delta, precision);
                const clamped = Math.min(
                  result.item.adjustMax ?? rounded,
                  Math.max(result.item.adjustMin ?? rounded, rounded),
                );
                nextValue = clamped;
              }
              cm.setDynamic(key, nextValue);
              if (key === 'provider.model') ctx.runtime.model = nextValue as string;
              if (key === 'provider.provider') ctx.runtime.provider = nextValue as string;
              if (key === 'provider.reasoningEffort') ctx.runtime.reasoningEffort = nextValue as string;
              result.item.detail = `${String(nextValue)} — ${schema.description}`;
              ctx.renderRequest();
              return;
            }
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
