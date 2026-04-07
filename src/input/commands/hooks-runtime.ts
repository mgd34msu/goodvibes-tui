import type { CommandRegistry } from '../command-registry.ts';
import { getHookWorkbench, listHookPointContracts } from '../../hooks/index.ts';

export function registerHooksRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'hooks',
    aliases: [],
    description: 'Inspect, author, simulate, and reload managed hook workflows',
    usage: '[contracts [filter] | reload | scaffold <name> <match> <type> | chain <name> <event1,event2,...> | remove <name> | enable <name> | disable <name> | simulate <eventPath> | inspect <path> | import <path> [merge|replace] | export [path]]',
    argsHint: '[subcommand]',
    async handler(args, ctx) {
      const workbench = getHookWorkbench();
      if (args.length === 0 && ctx.openHooksPanel) {
        ctx.openHooksPanel();
        return;
      }

      const subcommand = (args[0] ?? 'contracts').toLowerCase();
      if (subcommand === 'reload') {
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`Reloaded managed hooks from ${workbench.getHooksFilePath()}`);
        return;
      }
      if (subcommand === 'scaffold') {
        const [name, match, type] = args.slice(1);
        if (!name || !match || !type) {
          ctx.print('Usage: /hooks scaffold <name> <match> <command|prompt|agent|http|ts>');
          return;
        }
        if (!['command', 'prompt', 'agent', 'http', 'ts'].includes(type)) {
          ctx.print(`Unknown hook type: ${type}`);
          return;
        }
        workbench.loadManagedConfig();
        const hook = workbench.scaffoldHook(name, match, type as Parameters<typeof workbench.scaffoldHook>[2]);
        await workbench.saveManagedConfig();
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`Scaffolded managed hook ${hook.name} at ${match} in ${workbench.getHooksFilePath()}`);
        return;
      }
      if (subcommand === 'chain') {
        const name = args[1];
        const matches = args[2]?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
        if (!name || matches.length === 0) {
          ctx.print('Usage: /hooks chain <name> <event1,event2,...>');
          return;
        }
        workbench.loadManagedConfig();
        const chain = workbench.scaffoldChain(name, matches);
        await workbench.saveManagedConfig();
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`Scaffolded managed hook chain ${chain.name} with ${chain.steps.length} step(s).`);
        return;
      }
      if (subcommand === 'remove') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /hooks remove <name>');
          return;
        }
        workbench.loadManagedConfig();
        const removed = workbench.removeManagedEntry(name);
        if (!removed) {
          ctx.print(`No managed hook or chain named ${name}.`);
          return;
        }
        await workbench.saveManagedConfig();
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`Removed managed hook workflow entry ${name}.`);
        return;
      }
      if (subcommand === 'enable' || subcommand === 'disable') {
        const name = args[1];
        if (!name) {
          ctx.print(`Usage: /hooks ${subcommand} <name>`);
          return;
        }
        workbench.loadManagedConfig();
        const changed = workbench.toggleManagedHook(name, subcommand === 'enable');
        if (!changed) {
          ctx.print(`No managed hook named ${name}.`);
          return;
        }
        await workbench.saveManagedConfig();
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`${subcommand === 'enable' ? 'Enabled' : 'Disabled'} managed hook ${name}.`);
        return;
      }
      if (subcommand === 'simulate') {
        const eventPath = args[1];
        if (!eventPath) {
          ctx.print('Usage: /hooks simulate <eventPath>');
          return;
        }
        workbench.loadManagedConfig();
        const result = workbench.simulate(eventPath);
        ctx.print([
          `Hook simulation for ${result.eventPath}`,
          `  matched hooks: ${result.matchedHooks.length}`,
          ...result.matchedHooks.map((entry) => `    ${entry.name}  ${entry.pattern}  ${entry.type}`),
          `  matched chains: ${result.matchedChains.length}`,
          ...result.matchedChains.map((entry) => `    ${entry.name}  stepMatches=${entry.stepMatches}`),
        ].join('\n'));
        return;
      }
      if (subcommand === 'export') {
        workbench.loadManagedConfig();
        const path = await workbench.exportManagedConfig(args[1] ?? workbench.getHooksFilePath());
        ctx.print(`Exported managed hooks to ${path}`);
        return;
      }
      if (subcommand === 'inspect') {
        const path = args[1];
        if (!path) {
          ctx.print('Usage: /hooks inspect <path>');
          return;
        }
        const inspection = workbench.inspectManagedConfig(path);
        ctx.print([
          `Hook bundle inspection: ${inspection.path}`,
          `  hooks: ${inspection.hookCount}`,
          `  chains: ${inspection.chainCount}`,
          `  patterns: ${inspection.patterns.join(', ') || '(none)'}`,
        ].join('\n'));
        return;
      }
      if (subcommand === 'import') {
        const path = args[1];
        const strategy = args[2] === 'replace' ? 'replace' : 'merge';
        if (!path) {
          ctx.print('Usage: /hooks import <path> [merge|replace]');
          return;
        }
        workbench.loadManagedConfig();
        workbench.importManagedConfig(path, strategy);
        await workbench.saveManagedConfig();
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`Imported managed hooks from ${path} using ${strategy} strategy.`);
        return;
      }

      const filter = (subcommand === 'contracts' ? args.slice(1) : args).join(' ').trim().toLowerCase();
      const contracts = listHookPointContracts().filter((contract) => (
        filter.length === 0
        || contract.pattern.toLowerCase().includes(filter)
        || contract.description.toLowerCase().includes(filter)
      ));

      if (contracts.length === 0) {
        ctx.print(filter.length === 0 ? 'No hook contracts registered.' : `No hook contracts matched "${filter}".`);
        return;
      }

      const lines: string[] = [`Hook Contracts (${contracts.length}):`];
      for (const contract of contracts) {
        lines.push(`  ${contract.pattern}`);
        lines.push(`    authority=${contract.authority} mode=${contract.executionMode} deny=${contract.canDeny ? 'yes' : 'no'} mutate=${contract.canMutateInput ? 'yes' : 'no'} inject=${contract.canInjectContext ? 'yes' : 'no'} timeout=${contract.timeoutMs}ms policy=${contract.failurePolicy}`);
        lines.push(`    ${contract.description}`);
      }
      const managedHooks = workbench.listManagedHooks();
      const managedChains = workbench.listManagedChains();
      lines.push('');
      lines.push(`Managed hooks file: ${workbench.getHooksFilePath()}`);
      lines.push(`Managed entries: hooks=${managedHooks.length} chains=${managedChains.length}`);
      ctx.print(lines.join('\n'));
    },
  });
}
