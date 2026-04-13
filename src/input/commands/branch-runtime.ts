import type { CommandRegistry } from '../command-registry.ts';

export function registerBranchRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'fork',
    aliases: ['branch-save'],
    description: 'Save a named snapshot of the current conversation',
    usage: '[name]',
    argsHint: '[name]',
    handler(args, ctx) {
      const name = args[0];
      const branchName = ctx.session.conversationManager.forkBranch(name);
      const msgCount = ctx.session.conversationManager.getMessageCount();
      ctx.print(`Forked conversation as "${branchName}" (${msgCount} message${msgCount === 1 ? '' : 's'}).`);
    },
  });

  registry.register({
    name: 'branch',
    aliases: ['br'],
    description: 'List conversation branches or switch to one',
    usage: '[name]',
    argsHint: '[name]',
    handler(args, ctx) {
      if (args.length === 0) {
        const branches = ctx.session.conversationManager.listBranches();
        if (branches.length === 0) {
          ctx.print('No branches. Use /fork [name] to create one.');
          return;
        }
        const current = ctx.session.conversationManager.getCurrentBranch();
        const lines = [`Branches (current: ${current}):`];
        for (const branch of branches) {
          const marker = branch.isCurrent ? '▶' : ' ';
          lines.push(`  ${marker} ${branch.name}  (${branch.messageCount} message${branch.messageCount === 1 ? '' : 's'})`);
        }
        ctx.print(lines.join('\n'));
        return;
      }
      const name = args[0];
      const ok = ctx.session.conversationManager.switchBranch(name);
      if (!ok) {
        ctx.print(`Branch "${name}" not found. Use /fork [name] to create one, or /branch to list.`);
        return;
      }
      ctx.print(`Switched to branch "${name}".`);
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'merge',
    aliases: [],
    description: 'Append messages from a branch after the fork point',
    usage: '<name>',
    argsHint: '<name>',
    handler(args, ctx) {
      const name = args[0];
      if (!name) {
        ctx.print('Usage: /merge <branch-name>\nSee /branch for available branches.');
        return;
      }
      const ok = ctx.session.conversationManager.mergeBranch(name);
      if (!ok) {
        ctx.print(`Branch "${name}" not found. Use /branch to list available branches.`);
        return;
      }
      ctx.print(`Merged branch "${name}" into current conversation.`);
      ctx.renderRequest();
    },
  });
}
