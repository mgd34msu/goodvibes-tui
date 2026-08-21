import type { CommandRegistry } from '../command-registry.ts';
import { openModalCommand } from './runtime-services.ts';

/**
 * Register the /qrcode command.
 *
 * `/qrcode` (no args, aliases /qr /pair) opens the device-pairing modal: a QR of
 * the `#pair=<token>` deep link plus the offer set. Each open mints its own
 * named per-device token, so `/qrcode regenerate` no longer rotates a shared
 * token, it simply re-opens the modal, which mints a fresh token and QR. The
 * previously-shown token stays valid until you revoke it in
 * /settings → security → devices.
 */
export function registerQrcodeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'qrcode',
    aliases: ['qr', 'pair'],
    description: 'Open the device-pairing modal (QR deep link + offers); each open mints a fresh device token',
    usage: '[regenerate]',
    argsHint: '[regenerate]',
    handler(args, ctx) {
      if (args[0]?.toLowerCase() === 'regenerate') {
        // Each pairing-modal open mints its own token, so "regenerate" is just a
        // fresh open: the re-pull mints a new named token + QR in place. The
        // prior token is not rotated out from under a live device, revoke it
        // explicitly in /settings → security → devices when you no longer need it.
        ctx.print('Opening a fresh pairing QR; it mints a new device token. Revoke old ones in /settings → security → devices.');
        openModalCommand(ctx, 'pairing-modal');
        return;
      }
      openModalCommand(ctx, 'pairing-modal');
    },
  });
}
