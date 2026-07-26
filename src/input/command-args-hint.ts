import type { CommandRegistry } from './command-registry.ts';
import { SESSION_SUBCOMMAND_ARG_HINTS } from './commands/session.ts';
import { CLUSTER_SUBCOMMAND_ARG_HINTS } from './commands/cluster-runtime.ts';

/**
 * Per-command subcommand → argument-hint maps. `session`'s entries come
 * straight from session.ts (SESSION_SUBCOMMAND_ARG_HINTS) — the same table
 * the `/session` switch itself is built from — so the two can never drift
 * apart; the others are hand-maintained here since they're small and their
 * owning modules don't export an equivalent table. A drift test
 * (src/test/input/command-args-hint.test.ts) checks every top-level key
 * below resolves to a real registered command.
 */
const SUBCOMMAND_HINTS: Record<string, Record<string, string>> = {
  session: SESSION_SUBCOMMAND_ARG_HINTS,
  cluster: CLUSTER_SUBCOMMAND_ARG_HINTS,
  template: { save: '<name>', use: '<name> [args]', edit: '<name>', delete: '<name>' },
  secrets: { set: '<KEY> <value>', get: '<KEY>', delete: '<KEY>' },
  permissions: { tool: '<name> allow|prompt|deny' },
  config: { reset: '<key>' },
  plugin: { enable: '<name>', disable: '<name>', reload: '' },
};

export function buildCommandArgsHint(
  prompt: string,
  commandRegistry: Pick<CommandRegistry, 'get'>,
): string | undefined {
  if (!prompt.startsWith('/')) return undefined;

  const spaceIdx = prompt.indexOf(' ');
  if (spaceIdx === -1) {
    const cmd = commandRegistry.get(prompt.slice(1));
    return cmd?.argsHint ?? cmd?.usage;
  }

  const cmdName = prompt.slice(1, spaceIdx);
  const cmd = commandRegistry.get(cmdName);
  if (!cmd) return undefined;

  const afterCmd = prompt.slice(spaceIdx + 1);
  const subSpaceIdx = afterCmd.indexOf(' ');
  if (subSpaceIdx !== -1) return undefined;

  const subMap = SUBCOMMAND_HINTS[cmdName];
  if (subMap && afterCmd in subMap) return subMap[afterCmd];
  return undefined;
}
