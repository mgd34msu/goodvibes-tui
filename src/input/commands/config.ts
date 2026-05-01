import type { CommandRegistry } from '../command-registry.ts';

export function registerConfigCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'config',
    aliases: ['cfg'],
    description: 'Open the fullscreen configuration workspace',
    usage: '[category|key]',
    argsHint: '[category|key]',
    handler(args, ctx) {
      if (ctx.openSettingsModal) {
        ctx.openSettingsModal(args[0]);
        return;
      }
      ctx.print('Fullscreen config workspace is not available in this runtime.');
    },
  });
}
