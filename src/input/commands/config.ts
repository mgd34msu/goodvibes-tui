import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { setActiveThemeMode, type ThemeMode } from '../../renderer/theme.ts';
import {
  buildGoodVibesSecretKey,
  defaultSecretBackedScope,
  isSecretConfigKey,
  persistSecretBackedConfigValue,
} from '../../config/secret-config.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export function registerConfigCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'config',
    aliases: ['cfg'],
    description: 'Open the fullscreen configuration workspace, or set a key directly',
    usage: '[category|key] | set <key> <value>',
    argsHint: '[category|key] | set <key> <value>',
    async handler(args, ctx) {
      // An earlier replay fix: `/config set <key> <value>` used to fall through to
      // the workspace with the assignment silently ignored, the dishonest-
      // fallthrough class. `set` is now a real verb.
      if (args[0] === 'set') {
        const key = args[1];
        const value = args.slice(2).join(' ');
        if (!key || value === '') {
          ctx.print('Usage: /config set <key> <value>; e.g. /config set display.themeMode light');
          return;
        }
        // A credential key must never take the generic path below: setDynamic
        // writes the value it is handed straight into a settings JSON file, so
        // `/config set surfaces.email.password hunter2` used to put the mailbox
        // password in cleartext on disk. The settings modal already routes these
        // keys through the secret manager (settings-modal-secrets.ts); this
        // command has to route them the same way, or the two ways of setting the
        // same key disagree about where the value lands.
        if (isSecretConfigKey(key)) {
          await handleSecretConfigSet(ctx, key as ConfigKey, value);
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

/**
 * Store a credential-bearing config key through the secret manager instead of
 * writing it into a config file: the value goes to the secret store and the
 * config key keeps only a `goodvibes://secrets/...` reference to it.
 *
 * The entered value is never echoed. The transcript is a diagnostic surface,
 * it is scrolled back through, copied into support threads and captured in
 * screen recordings, so it gets the reference and the store key, never the
 * secret.
 *
 * With no secret manager in this runtime there is nowhere safe to put it, and
 * the command REFUSES rather than falling back to a plaintext config write.
 */
async function handleSecretConfigSet(
  ctx: CommandContext,
  key: ConfigKey,
  value: string,
): Promise<void> {
  const secretKey = buildGoodVibesSecretKey(key);
  const secretsManager = ctx.platform?.secretsManager;
  if (!secretsManager) {
    ctx.print(
      `${key} holds a credential, and this runtime has no secret store to put it in; `
      + `refusing rather than writing it in cleartext into a config file.\n`
      + `  Store it with: /secrets set ${secretKey} <value>`,
    );
    return;
  }
  try {
    const configValue = await persistSecretBackedConfigValue(
      ctx.platform.configManager,
      secretsManager,
      key,
      value,
    );
    const scope = defaultSecretBackedScope(key);
    ctx.print(
      `Set ${key}: stored in the ${scope} secret tier as ${secretKey} (value hidden).\n`
      + `  ${key} now holds the reference ${configValue}; the value itself is never written to a config file.`
      + (scope === 'daemon'
        ? '\n  The daemon reads that tier, so this keeps working with this client closed.'
        : ''),
    );
  } catch (e) {
    ctx.print(`Could not set ${key}: ${summarizeError(e)}`);
  }
}

/** Coerce CLI text to the JSON-ish scalar the config schema expects. */
function coerceConfigValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}
