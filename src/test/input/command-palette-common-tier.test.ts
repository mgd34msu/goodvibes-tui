/**
 * item 4: the '/' command palette listed all 130+ registered commands in
 * one flat alphabetical block ("the 132-command palette unranked" evaluator
 * finding), a bare '/' with no filter typed yet gave no signal about which
 * dozen commands actually matter day to day. Fixed by curating a "common"
 * first tier (CommandRegistry.COMMON_COMMAND_NAMES) that fuzzyMatch('') ranks
 * ahead of the alphabetical rest; typed filtering (any non-empty query) is
 * completely unaffected, every command is still searched, exactly as
 * before. The dropdown (autocomplete-overlay.ts) draws a separator at the
 * boundary; AutocompleteEngine.commonCount tells it where.
 */
import { describe, expect, test } from 'bun:test';
import { CommandRegistry, COMMON_COMMAND_NAMES, type CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { AutocompleteEngine } from '../../input/autocomplete.ts';

function noopHandler() {}

function buildSmallRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  // A deliberately small mix: 3 curated "common" names, and several
  // alphabetically-earlier non-common names that would otherwise sort first.
  for (const name of ['help', 'model', 'quit', 'aardvark', 'apple', 'banana', 'zebra']) {
    registry.register({ name, description: `desc for ${name}`, handler: noopHandler });
  }
  return registry;
}

describe('CommandRegistry.fuzzyMatch: common tier on empty query (item 4)', () => {
  test('COMMON_COMMAND_NAMES has exactly the curated 12, all real command names', () => {
    expect([...COMMON_COMMAND_NAMES].sort()).toEqual(
      ['checkpoint', 'codebase', 'config', 'help', 'imagine', 'model', 'panel', 'quit', 'recall', 'search', 'sessions', 'workstream'].sort(),
    );
  });

  test('every curated common name is actually registered in the real builtin command set', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    for (const name of COMMON_COMMAND_NAMES) {
      expect(registry.get(name), `expected /${name} to be a registered command`).toBeDefined();
    }
  });

  test('an empty query ranks common names first (alphabetical within the tier), then the alphabetical rest', () => {
    const registry = buildSmallRegistry();
    const results = registry.fuzzyMatch('');
    const names = results.map((r) => r.command.name);

    // Common tier: help, model, quit, alphabetical within the tier.
    expect(names.slice(0, 3)).toEqual(['help', 'model', 'quit']);
    // Alphabetical rest, 'aardvark'/'apple'/'banana' would sort BEFORE
    // 'help' in a flat alphabetical list; they must not here.
    expect(names.slice(3)).toEqual(['aardvark', 'apple', 'banana', 'zebra']);
  });

  test('a non-empty query is completely unaffected by tiering; every command is still ranked by actual match quality, not tier', () => {
    const registry = buildSmallRegistry();
    const results = registry.fuzzyMatch('a');
    const names = results.map((r) => r.command.name);
    // 'aardvark' and 'apple' both START WITH 'a' (score 80) and must rank
    // ahead of 'banana' and 'zebra' (subsequence-only matches on 'a', lower
    // score), including ahead of 'help'/'model'/'quit', none of which match
    // 'a' at all and so are absent entirely. Tiering plays no role once a
    // query is typed.
    expect(names.slice(0, 2).sort()).toEqual(['aardvark', 'apple']);
    expect(names).not.toContain('help');
    expect(names).not.toContain('model');
  });
});

describe('AutocompleteEngine.commonCount (item 4)', () => {
  test('commonCount marks the leading common-tier run only when the query is empty', () => {
    const registry = buildSmallRegistry();
    const engine = new AutocompleteEngine(registry);

    engine.update('');
    expect(engine.getState().commonCount).toBe(3); // help, model, quit

    engine.update('a');
    expect(engine.getState().commonCount).toBe(0); // typed filter, tiering does not apply
  });
});
