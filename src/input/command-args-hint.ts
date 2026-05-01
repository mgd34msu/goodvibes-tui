import type { CommandRegistry } from './command-registry.ts';

const SUBCOMMAND_HINTS: Record<string, Record<string, string>> = {
  session: { rename: '<name>', resume: '<id|name>', info: '<id>', export: '<id> [format]', search: '<query>', delete: '<id>' },
  template: { save: '<name>', use: '<name> [args]', edit: '<name>', delete: '<name>' },
  secrets: { set: '<KEY> <value>', get: '<KEY>', delete: '<KEY>' },
  permissions: { tool: '<name> allow|prompt|deny' },
  config: { reset: '<key>' },
  danger: {},
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
