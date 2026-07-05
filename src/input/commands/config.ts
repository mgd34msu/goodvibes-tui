import type { CommandRegistry } from '../command-registry.ts';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { setActiveThemeMode, type ThemeMode } from '../../renderer/theme.ts';

export function registerConfigCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'config',
    aliases: ['cfg'],
    description: 'Open the fullscreen configuration workspace, or set a key directly',
    usage: '[category|key] | set <key> <value>',
    argsHint: '[category|key] | set <key> <value>',
    handler(args, ctx) {
      // Batch replay D2: `/config set <key> <value>` used to fall through to
      // the workspace with the assignment silently ignored — the dishonest-
      // fallthrough class. `set` is now a real verb.
      if (args[0] === 'set') {
        const key = args[1];
        const value = args.slice(2).join(' ');
        if (!key || value === '') {
          ctx.print('Usage: /config set <key> <value> — e.g. /config set display.themeMode light');
          return;
        }
        try {
          const before = ctx.platform.configManager.get(key as ConfigKey);
          ctx.platform.configManager.setDynamic(key as ConfigKey, coerceConfigValue(value));
          const after = ctx.platform.configManager.get(key as ConfigKey);
          ctx.print(`Set ${key}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
          // Forced theme modes apply immediately (matches the settings-modal
          // path); 'auto' re-probes on the next launch (stated honestly).
          if (key === 'display.themeMode') {
            if (after === 'dark' || after === 'light') {
              setActiveThemeMode(after as ThemeMode);
              ctx.print('Theme applied. Note: transcript, modal, and header/footer/thinking chrome all flip; only the background colour follows your terminal.');
            } else {
              ctx.print('Theme mode "auto" probes the terminal background on the next launch.');
            }
          }
        } catch (e) {
          ctx.print(`Could not set ${key}: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      if (ctx.openSettingsModal) {
        ctx.openSettingsModal(args[0]);
        return;
      }
      ctx.print('Fullscreen config workspace is not available in this runtime.');
    },
  });
}

/** Coerce CLI text to the JSON-ish scalar the config schema expects. */
function coerceConfigValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}
