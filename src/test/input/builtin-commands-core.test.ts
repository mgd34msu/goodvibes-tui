import { describe, expect, test } from 'bun:test';

import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

describe('input/registerBuiltinCommands shell core extraction', () => {
  test('registers the extracted shell core commands', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    expect(registry.get('model')?.name).toBe('model');
    expect(registry.get('help')?.name).toBe('help');
    expect(registry.get('clear')?.name).toBe('clear');
    expect(registry.get('compact')?.name).toBe('compact');
    expect(registry.get('quit')?.name).toBe('quit');
    expect(registry.get('effort')?.name).toBe('effort');
    expect(registry.get('lines')?.name).toBe('lines');
  });
});
