import type { CommandRegistry } from '../command-registry.ts';
import { openCommandPanel } from './runtime-services.ts';

/**
 * Register the /qrcode command.
 *
 * Opens the QR Code panel which displays a scannable QR code for
 * companion app pairing, along with connection URL, token, and username.
 */
export function registerQrcodeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'qrcode',
    aliases: ['qr', 'pair'],
    description: 'Open the QR code panel for companion app pairing',
    usage: '',
    handler(_args, ctx) {
      openCommandPanel(ctx, 'qr-code');
    },
  });
}
