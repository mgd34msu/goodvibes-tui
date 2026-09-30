import type { CommandRegistry } from '../command-registry.ts';
import { AGENT_VIEW_NAMES, CHANGES_VIEW_NAMES, USAGE_VIEW_NAMES, takeTargetFlag } from '../views.ts';

/**
 * `/panel` is the legacy alias for the old pane names. Every view lives in a
 * modal, and the old names still arrive from muscle memory, notes, scripts and
 * deep links (`/panel open fleet --target <id>`). `/panel <name>` and
 * `/panel open <name>` open the modal that holds that content now;
 * `/panel list` says where each old name goes. The verbs that only made sense
 * for side panes (close, move, focus, split, width, height) have nothing to
 * act on and say so.
 */
export function registerLegacyPanelCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'panel',
    aliases: ['panels'],
    description: 'Open a view by its old pane name (fleet, tokens, git, …) in its modal; /panel list shows where each goes',
    usage: '[<name> | open <name> [--target <id>[:<kind>]] | list]',
    argsHint: '<name> | open <name> | list',
    handler(args, ctx) {
      const rest = [...args];
      const target = takeTargetFlag(rest);
      const sub = rest[0]?.toLowerCase() ?? '';
      if (!sub || sub === 'toggle') {
        ctx.print('There are no panes any more: views open as modals. Try /agents, /usage, /changes or /notifications, or ctrl+p to search.');
        return;
      }
      if (sub === 'list') {
        ctx.print([
          'Where the old panes went:',
          `  Agents (/agents, F2): ${AGENT_VIEW_NAMES.filter((n) => n !== 'agents').join(', ')}, hosted`,
          `  Usage (/usage): ${USAGE_VIEW_NAMES.filter((n) => n !== 'usage').join(', ')}`,
          `  Changes (/changes): ${CHANGES_VIEW_NAMES.filter((n) => n !== 'changes').join(', ')}`,
          '  Notifications (/notifications): notifications',
          '  Sessions (/sessions): sessions',
          '  Local Auth (/local-auth): local-auth',
          'Settings-style views (services, providers, plugins, hooks, memory, …) open their own modals by the same names.',
        ].join('\n'));
        return;
      }
      if (sub === 'close' || sub === 'move' || sub === 'focus' || sub === 'split' || sub === 'width' || sub === 'height') {
        ctx.print(`There are no panes to ${sub}: views open as modals and Esc closes them.`);
        return;
      }
      const name = sub === 'open' ? rest[1] : rest[0];
      if (!name) {
        ctx.print('Usage: /panel open <name> [--target <id>[:<kind>]]');
        return;
      }
      if (!ctx.openView) {
        ctx.print('Views are not available in this session.');
        return;
      }
      if (!ctx.openView(name, target)) ctx.print(`Nothing holds "${name}". /panel list shows where the old names go.`);
    },
  });
}
