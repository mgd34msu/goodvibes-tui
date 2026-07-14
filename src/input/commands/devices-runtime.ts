import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { formatDeviceLine, resolveTokenByIdPrefix } from '../../core/pairing-devices.ts';

/**
 * Register the /devices command — manage the per-device pairing tokens minted by
 * the pairing surfaces. Mirrors the pairing.tokens.* gateway verbs the daemon
 * serves (list/rename/revoke/migrate/revoke-shared) so the terminal has the same
 * capability as the web app's device manager.
 *
 *   /devices                      list paired devices (name · created · last-seen · id)
 *   /devices rename <id> <name>   rename a device token (id or unambiguous prefix)
 *   /devices revoke <id>          revoke a device token immediately
 *   /devices migrate-shared [name] mint a per-device token off the legacy shared token
 *   /devices revoke-shared        revoke the legacy shared token (it stops authenticating)
 */
export function registerDevicesRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'devices',
    aliases: ['device'],
    description: 'Manage paired-device tokens (list, rename, revoke, migrate-shared)',
    usage: '[list|rename <id> <name>|revoke <id>|migrate-shared [name]|revoke-shared]',
    argsHint: '[list|rename|revoke|migrate-shared|revoke-shared]',
    handler(args, ctx) {
      const pairingTokens = ctx.platform.pairingTokens;
      if (!pairingTokens) {
        ctx.print('Device management is unavailable in this runtime (no pairing token service wired).');
        return;
      }
      const sub = (args[0] ?? 'list').toLowerCase();

      if (sub === 'list') {
        renderList(ctx, pairingTokens);
        return;
      }

      if (sub === 'rename') {
        const idOrPrefix = args[1];
        const name = args.slice(2).join(' ').trim();
        if (!idOrPrefix || !name) {
          ctx.print('Usage: /devices rename <id> <new name>');
          return;
        }
        const resolved = resolveTokenByIdPrefix(pairingTokens.list(), idOrPrefix);
        if (!resolved.ok) {
          ctx.print(resolved.reason === 'ambiguous' ? `Ambiguous device id "${idOrPrefix}" — use more characters.` : `No device matches "${idOrPrefix}".`);
          return;
        }
        pairingTokens.rename(resolved.token.id, name);
        ctx.print(`Renamed device to "${name}".`);
        return;
      }

      if (sub === 'revoke') {
        const idOrPrefix = args[1];
        if (!idOrPrefix) {
          ctx.print('Usage: /devices revoke <id>');
          return;
        }
        const resolved = resolveTokenByIdPrefix(pairingTokens.list(), idOrPrefix);
        if (!resolved.ok) {
          ctx.print(resolved.reason === 'ambiguous' ? `Ambiguous device id "${idOrPrefix}" — use more characters.` : `No device matches "${idOrPrefix}".`);
          return;
        }
        const revoked = pairingTokens.revoke(resolved.token.id);
        ctx.print(revoked ? `Revoked "${resolved.token.name}" — its token stops working immediately.` : `Device "${resolved.token.name}" was already absent.`);
        return;
      }

      if (sub === 'migrate-shared') {
        const name = args.slice(1).join(' ').trim() || 'migrated device';
        const minted = pairingTokens.mintForMigration({ name });
        ctx.print(
          `Minted a per-device token "${minted.name}" (shown once): ${minted.token}\n` +
          'Pair this device with it, then run /devices revoke-shared to retire the legacy shared token.',
        );
        return;
      }

      if (sub === 'revoke-shared') {
        if (pairingTokens.isLegacyRevoked()) {
          ctx.print('The legacy shared token is already revoked.');
          return;
        }
        pairingTokens.revokeLegacyShared();
        ctx.print('Revoked the legacy shared token — devices still on it must re-pair with their own token.');
        return;
      }

      ctx.print(`Unknown /devices subcommand: ${sub}. Use: list | rename | revoke | migrate-shared | revoke-shared`);
    },
  });
}

function renderList(ctx: CommandContext, pairingTokens: NonNullable<CommandContext['platform']['pairingTokens']>): void {
  const list = pairingTokens.list();
  const lines: string[] = ['Paired devices:'];
  if (list.length === 0) {
    lines.push('  (none yet — pair one with /pair)');
  } else {
    for (const token of list) lines.push(`  ${formatDeviceLine(token)}`);
  }
  lines.push(
    '',
    pairingTokens.isLegacyRevoked()
      ? 'Legacy shared token: revoked.'
      : 'Legacy shared token: active — run /devices migrate-shared then /devices revoke-shared to retire it.',
  );
  ctx.print(lines.join('\n'));
}
