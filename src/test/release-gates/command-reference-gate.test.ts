import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { categorizeBuiltinCommands } from '@/input/commands.ts';
import { renderCommandReferenceMarkdown } from '@/input/command-reference.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const DOC_PATH = join(ROOT, 'docs', 'commands-reference.md');

describe('command reference gate', () => {
  test('docs/commands-reference.md is in sync with the command registry', () => {
    const committed = readFileSync(DOC_PATH, 'utf8');
    const fresh = renderCommandReferenceMarkdown(categorizeBuiltinCommands());
    // If this fails, the generated command reference is stale — run
    // `bun run docs:commands` and commit the result.
    expect(committed).toBe(fresh);
  });

  test('every categorized command carries a non-empty category and description', () => {
    const entries = categorizeBuiltinCommands();
    expect(entries.length).toBeGreaterThan(0);
    for (const { command, category } of entries) {
      expect(category.length).toBeGreaterThan(0);
      expect(command.name.length).toBeGreaterThan(0);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  test('categorization covers exactly the registry-registered command set', () => {
    // The categorized list must be a complete, duplicate-free enumeration of
    // every command registerBuiltinCommands would register — guards against a
    // command group added to registration but missed by categorization.
    const { CommandRegistry } = require('@/input/command-registry.ts');
    const { registerBuiltinCommands } = require('@/input/commands.ts');
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const registered = new Set(registry.getAll().map((c: { name: string }) => c.name));
    const categorized = categorizeBuiltinCommands().map((e) => e.command.name);
    expect(new Set(categorized).size).toBe(categorized.length); // no duplicates
    expect(new Set(categorized)).toEqual(registered);
  });
});
