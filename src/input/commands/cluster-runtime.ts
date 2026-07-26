/**
 * cluster-runtime.ts — `/cluster` in the TUI.
 *
 * The same operations as the `goodvibes-daemon cluster` subcommands, reaching
 * the same daemon verbs through the same caller. There is no cluster logic in
 * this file and there must never be any: if `/cluster status` and
 * `cluster status` could disagree, one of them would be lying to somebody.
 *
 * The one honest difference is `join` without arguments. The CLI can stop and
 * ask which group and for the join key; a slash command has nowhere to ask, so
 * it requires `--group` and `--key` and says so — which is exactly what the
 * shared caller already reports for any non-interactive invocation.
 */
import { resolveDaemonHomeDir } from '@pellux/goodvibes-sdk/platform/workspace';
import { runClusterCommand, CLUSTER_SUBCOMMANDS } from '../../cluster/commands.ts';
import type { CommandRegistry } from '../command-registry.ts';

/** Subcommand → argument hint, surfaced as the operator types. */
export const CLUSTER_SUBCOMMAND_ARG_HINTS: Record<string, string> = {
  status: '',
  create: '[--name "<group name>"] [--passphrase "<phrase>"]',
  join: '--group <id> --key <join key>',
  key: '',
  nodes: '',
  forget: '<machine>',
  rotate: '[--now]',
  leave: '',
  rename: '"<new name>"',
  groups: '',
};

export function registerClusterRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'cluster',
    description: 'Share inbound channel work with your other goodvibes machines on this network',
    usage: `[${CLUSTER_SUBCOMMANDS.join('|')}] — status is the default; `
      + 'add --host/--port/--token to reach a daemon on another machine',
    argsHint: `[${CLUSTER_SUBCOMMANDS.join('|')}]`,
    async handler(args, ctx) {
      const argv = args.length === 0 ? ['status'] : args;
      const result = await runClusterCommand({
        argv,
        configManager: ctx.platform.configManager,
        daemonHomeDir: resolveDaemonHomeDir(),
        // A transcript is not a terminal for clipboard purposes: writing an
        // OSC 52 escape into the rendered conversation would put a control
        // sequence in the scrollback rather than on anyone's clipboard.
        isTerminal: false,
      });
      ctx.print(result.lines.join('\n'));
    },
  });
}
