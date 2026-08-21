import type { CommandRegistry } from '../command-registry.ts';

/**
 * `/editor`, open the current composer draft in the user's $EDITOR / $VISUAL,
 * then load the edited text back into the composer. The actual terminal
 * suspend/resume and buffer round-trip are wired in main.ts as the
 * `openComposerEditor` command action; this command is the front door for it.
 */
export function registerEditorRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'editor',
    aliases: ['ed'],
    description: 'Edit the current composer draft in your $EDITOR, then resume with the result',
    handler(_args, ctx) {
      if (!ctx.openComposerEditor) {
        ctx.print('External editor composition is not available in this runtime.');
        return;
      }
      ctx.openComposerEditor();
    },
  });
}
