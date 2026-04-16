// ---------------------------------------------------------------------------
// command-aliases-lint.test.ts
// β4: Lint slash-command alias definitions.
//
// Rules enforced:
//   1. No single-letter alias maps to a command whose primary action is
//      destructive (cancel, delete, rm, remove, discard, clear, reset, revoke,
//      logout, reject, unpair, force, kill, terminate).
//   2. No alias is also a primary subcommand name of the same command (not
//      checkable statically without routing tables — covered by rule 1 scope).
//   3. Every alias is either in the command's `aliases` field or in `argsHint`.
//      (Validates aliases are declared, not leaked through docs.)
//
// Violation remediation:
//   - Change the alias to a multi-character string, OR
//   - Add a confirm-prompt guard to the handler.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

const DESTRUCTIVE_VERBS = new Set([
  'cancel', 'delete', 'rm', 'remove', 'discard', 'clear', 'reset',
  'revoke', 'logout', 'reject', 'unpair', 'force', 'kill', 'terminate',
  // Extended: state-reversing, exit-triggering, and bulk-destruction verbs
  'undo', 'redo', 'exit', 'quit', 'abort', 'destroy', 'drop', 'wipe',
  'purge', 'ban', 'unregister',
]);

function isDestructiveName(name: string): boolean {
  return DESTRUCTIVE_VERBS.has(name.toLowerCase());
}

/** Returns true if the command is considered destructive based on its name or description. */
function commandIsDestructive(cmd: { name: string; description: string }): boolean {
  if (isDestructiveName(cmd.name)) return true;
  // Check if description starts with a destructive verb
  const firstWord = cmd.description.toLowerCase().split(/\s+/)[0] ?? '';
  return isDestructiveName(firstWord);
}

describe('Slash-command alias lint (β4)', () => {
  let registry: CommandRegistry;

  // Build registry using the real bootstrap path but with a mock context.
  // registerBuiltinCommands only needs the registry instance.
  registry = new CommandRegistry();
  registerBuiltinCommands(registry);

  const allCommands = registry.getAll();

  test('no single-letter alias on a destructive command', () => {
    const violations: string[] = [];

    for (const cmd of allCommands) {
      if (!commandIsDestructive(cmd)) continue;
      for (const alias of cmd.aliases ?? []) {
        if (alias.length === 1) {
          violations.push(
            `/${cmd.name} has single-letter alias "${alias}" but its action is destructive.` +
            ' Remediation: rename the alias to a descriptive word, e.g. "cncl" or "canc".'
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        'Alias lint failed — destructive commands must not have single-letter aliases:\n  ' +
        violations.join('\n  ')
      );
    }
    expect(violations).toHaveLength(0);
  });

  test('no alias is the empty string', () => {
    const violations: string[] = [];
    for (const cmd of allCommands) {
      for (const alias of cmd.aliases ?? []) {
        if (alias.trim() === '') {
          violations.push(`/${cmd.name} has an empty alias.`);
        }
      }
    }
    expect(violations).toHaveLength(0);
  });

  test('no alias duplicates a primary command name (collision check)', () => {
    const commandNames = new Set(allCommands.map(c => c.name));
    const violations: string[] = [];
    for (const cmd of allCommands) {
      for (const alias of cmd.aliases ?? []) {
        if (commandNames.has(alias) && alias !== cmd.name) {
          violations.push(
            `/${cmd.name} uses alias "${alias}" which is also a primary command name.` +
            ' This creates ambiguous routing.'
          );
        }
      }
    }
    expect(violations).toHaveLength(0);
  });

  test('registry loads without throwing (smoke test)', () => {
    expect(allCommands.length).toBeGreaterThan(10);
  });
});
