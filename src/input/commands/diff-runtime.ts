import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { ChangesSource } from '../changes-git.ts';

/** `session` (default), `working` (not staged), `staged`, or `head` (everything vs HEAD). */
function sourceFor(arg: string | undefined): ChangesSource {
  const sub = (arg ?? 'session').toLowerCase();
  if (sub === 'working' || sub === 'unstaged') return 'working';
  if (sub === 'staged' || sub === 'cached') return 'staged';
  if (sub === 'head' || sub === 'all') return 'head';
  return 'session';
}

function openChanges(ctx: CommandContext, args: string[]): void {
  if (!ctx.openChanges) {
    ctx.print('The Changes view is not available in this session.');
    return;
  }
  ctx.openChanges({ source: sourceFor(args[0]) });
}

/**
 * `/changes` and `/diff`: the Changes modal over this repository. With no
 * argument it shows the files this session edited against HEAD (everything vs
 * HEAD when none are tracked yet); `working`, `staged` and `head` pick the
 * other views, which v also cycles inside the modal.
 */
export function registerDiffRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'changes',
    description: 'Changed files with a tinted diff and semantic summary: stage hunks, comment for the model, mark reviewed',
    usage: '[session|working|staged|head]',
    argsHint: '[session|working|staged|head]',
    handler(args, ctx) {
      openChanges(ctx, args);
    },
  });
  registry.register({
    name: 'diff',
    aliases: ['d'],
    description: 'Show the diff of this session\'s file changes (or working, staged, or everything vs HEAD) in Changes',
    usage: '[session|head|working|staged]',
    argsHint: '[session|head|working|staged]',
    handler(args, ctx) {
      openChanges(ctx, args);
    },
  });
}
