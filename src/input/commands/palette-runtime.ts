import type { CommandRegistry } from '../command-registry.ts';

/**
 * /palette, open the fuzzy command palette, a searchable picker over every
 * registered slash command. The palette itself is generated live from the
 * registry (see openCommandPalette in shell/ui-openers.ts); this command is
 * just the discoverable front door, mirroring the Ctrl+K chord.
 */
export function registerPaletteRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'palette',
    aliases: ['k'],
    description: 'Open the command palette to search and run any slash command',
    handler(_args, ctx) {
      if (!ctx.openCommandPalette) {
        ctx.print('The command palette is unavailable in this context.');
        return;
      }
      ctx.openCommandPalette();
    },
  });
}
