import { join } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { openModalCommand, requireShellPaths } from './runtime-services.ts';
import { regenerateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';

/**
 * Register the /qrcode command.
 *
 * `/qrcode` (no args) opens the companion-app pairing modal (QR code + URL/
 * token/username). `/qrcode regenerate` rotates the companion pairing token:
 * it re-keys the shared operator-token store, so the previously-issued token is
 * rejected on the next auth and a fresh QR must be scanned to reconnect.
 */
export function registerQrcodeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'qrcode',
    aliases: ['qr', 'pair'],
    description: 'Open the companion-app pairing modal (QR code), or regenerate the pairing token',
    usage: '[regenerate]',
    argsHint: '[regenerate]',
    handler(args, ctx) {
      if (args[0]?.toLowerCase() === 'regenerate') {
        const shellPaths = requireShellPaths(ctx);
        const daemonHomeDir = join(shellPaths.homeDirectory, '.goodvibes', 'daemon');
        try {
          const rotated = regenerateCompanionToken({ daemonHomeDir });
          ctx.print(
            'Pairing token rotated. The previous token is now rejected — ' +
            `re-scan the QR (new peer ${rotated.peerId.slice(0, 8)}…) to reconnect the companion app.`,
          );
        } catch (error) {
          ctx.print(`Could not regenerate the pairing token: ${String(error)}`);
        }
        return;
      }
      openModalCommand(ctx, 'pairing-modal');
    },
  });
}
