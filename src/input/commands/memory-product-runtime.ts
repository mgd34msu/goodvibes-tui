import type { CommandRegistry } from '../command-registry.ts';

export function registerMemoryProductRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'memory-sync',
    aliases: ['memsync'],
    description: 'Dedicated front-door for durable memory export/import and bundle exchange',
    usage: '[export <path> [scope] | import <path>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? '').toLowerCase();
      if (!ctx.executeCommand) {
        ctx.print('Memory sync controls are not available in this runtime.');
        return;
      }
      if (sub === 'export' && args[1]) {
        const scope = args[2];
        const recallArgs = ['export', args[1], ...(scope ? ['--scope', scope] : [])];
        await ctx.executeCommand('recall', recallArgs);
        return;
      }
      if (sub === 'import' && args[1]) {
        await ctx.executeCommand('recall', ['import', args[1]]);
        return;
      }
      ctx.print('Usage: /memory-sync [export <path> [scope] | import <path>]');
    },
  });

  registry.register({
    name: 'handoff',
    description: 'Dedicated front-door for reviewable memory handoff bundles',
    usage: '[export <path> [scope] | inspect <path> | import <path>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? '').toLowerCase();
      if (!ctx.executeCommand) {
        ctx.print('Handoff controls are not available in this runtime.');
        return;
      }
      if (sub === 'export' && args[1]) {
        const scope = args[2];
        await ctx.executeCommand('recall', ['handoff-export', args[1], ...(scope ? ['--scope', scope] : [])]);
        return;
      }
      if (sub === 'inspect' && args[1]) {
        await ctx.executeCommand('recall', ['handoff-inspect', args[1]]);
        return;
      }
      if (sub === 'import' && args[1]) {
        await ctx.executeCommand('recall', ['handoff-import', args[1]]);
        return;
      }
      ctx.print('Usage: /handoff [export <path> [scope] | inspect <path> | import <path>]');
    },
  });

  registry.register({
    name: 'session-memory',
    description: 'Dedicated front-door for session-scoped memory capture and review. All subcommands are filtered to scope=session.',
    usage: '[queue [limit] | export <path> | add <class> <summary...>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'queue').toLowerCase();
      if (!ctx.executeCommand) {
        ctx.print('Session memory controls are not available in this runtime.');
        return;
      }
      if (sub === 'queue') {
        // Pass --scope session so only session-scoped records appear in the queue.
        await ctx.executeCommand('recall', ['queue', '--scope', 'session', ...(args[1] ? [args[1]] : [])]);
        return;
      }
      if (sub === 'export' && args[1]) {
        await ctx.executeCommand('recall', ['export', args[1], '--scope', 'session']);
        return;
      }
      if (sub === 'add' && args.length >= 3) {
        await ctx.executeCommand('recall', ['add', args[1], ...args.slice(2), '--scope', 'session']);
        return;
      }
      ctx.print('Usage: /session-memory [queue [limit] | export <path> | add <class> <summary...>]\nAll subcommands are scoped to session records only.');
    },
  });

  registry.register({
    name: 'team-memory',
    description: 'Dedicated front-door for team/shared memory review and exchange. The queue and export subcommands are filtered to scope=team.',
    usage: '[queue [limit] | export <path> | import <path> | capture policy]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'queue').toLowerCase();
      if (!ctx.executeCommand) {
        ctx.print('Team memory controls are not available in this runtime.');
        return;
      }
      if (sub === 'queue') {
        // Pass --scope team so only team-scoped records appear in the queue.
        await ctx.executeCommand('recall', ['queue', '--scope', 'team', ...(args[1] ? [args[1]] : [])]);
        return;
      }
      if (sub === 'export' && args[1]) {
        await ctx.executeCommand('recall', ['handoff-export', args[1], '--scope', 'team']);
        return;
      }
      if (sub === 'import' && args[1]) {
        await ctx.executeCommand('recall', ['handoff-import', args[1]]);
        return;
      }
      if (sub === 'capture' && args[1]?.toLowerCase() === 'policy') {
        await ctx.executeCommand('recall', ['capture', 'policy']);
        return;
      }
      ctx.print('Usage: /team-memory [queue [limit] | export <path> | import <path> | capture policy]\nqueue and export are scoped to team records; import applies the bundle\'s own scopes and capture policy is global.');
    },
  });
}
