import { describe, expect, test } from 'bun:test';
import {
  COMPLETION_COMMANDS,
  GLOBAL_FLAGS,
  allCommandTokens,
  allFlagTokens,
  buildCompletionSurface,
  generateBash,
  generateCompletion,
  generateFish,
  generateZsh,
  type CompletionCommand,
  type CompletionFlag,
} from '../../cli/completions/generate.ts';

// ---------------------------------------------------------------------------
// Data integrity
// ---------------------------------------------------------------------------

describe('COMPLETION_COMMANDS data integrity', () => {
  test('no duplicate canonical names', () => {
    const names = COMPLETION_COMMANDS.map((c) => c.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('no duplicate alias tokens across commands', () => {
    const seen = new Map<string, string>();
    for (const cmd of COMPLETION_COMMANDS) {
      for (const alias of cmd.aliases) {
        const existing = seen.get(alias);
        // Aliases may appear in multiple commands only if they are the canonical name
        // (which cannot happen twice due to the previous test). So duplicate aliases
        // should not exist.
        expect(existing).toBeUndefined();
        seen.set(alias, cmd.name);
      }
    }
  });

  test('canonical name appears in its own aliases array', () => {
    for (const cmd of COMPLETION_COMMANDS) {
      expect(cmd.aliases).toContain(cmd.name);
    }
  });

  test('expected subcommands are present for keyed commands', () => {
    const byName = new Map<string, CompletionCommand>(
      COMPLETION_COMMANDS.map((c) => [c.name, c]),
    );

    const expectations: Record<string, readonly string[]> = {
      service: ['status', 'check', 'install', 'start', 'stop', 'restart', 'uninstall'],
      models: ['current', 'use', 'pin', 'recent'],
      providers: ['list', 'current', 'inspect', 'use'],
      auth: ['status', 'users', 'sessions', 'add-user', 'clear-bootstrap'],
      subscription: ['list', 'providers', 'inspect', 'login', 'logout'],
      secrets: ['list', 'providers', 'test', 'set', 'link', 'delete'],
      sessions: ['list', 'show', 'export', 'resume'],
      tasks: ['list', 'show', 'submit'],
      surfaces: ['list', 'check', 'show', 'enable', 'disable'],
      listener: ['test'],
      'control-plane': ['status'],
      bundle: ['export', 'inspect', 'import'],
      completion: ['bash', 'zsh', 'fish'],
      onboarding: ['status'],
    };

    for (const [name, expected] of Object.entries(expectations)) {
      const cmd = byName.get(name);
      expect(cmd).toBeDefined();
      for (const sub of expected) {
        expect(cmd!.subcommands).toContain(sub);
      }
    }
  });

  test('all core commands are present', () => {
    const names = new Set(COMPLETION_COMMANDS.map((c) => c.name));
    const required = [
      'tui', 'run', 'serve', 'web', 'service', 'status', 'doctor',
      'onboarding', 'models', 'providers', 'auth', 'subscription', 'secrets',
      'sessions', 'tasks', 'pair', 'surfaces', 'listener', 'control-plane',
      'bundle', 'remote', 'completion', 'help', 'version',
    ] as const;
    for (const name of required) {
      expect(names.has(name)).toBe(true);
    }
  });
});

describe('GLOBAL_FLAGS data integrity', () => {
  test('no duplicate primary flag names', () => {
    const names = GLOBAL_FLAGS.map((f) => f.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('--output has valueEnum with expected values', () => {
    const outputFlag = GLOBAL_FLAGS.find((f) => f.name === '--output');
    expect(outputFlag).toBeDefined();
    expect(outputFlag!.valueEnum).toContain('text');
    expect(outputFlag!.valueEnum).toContain('json');
    expect(outputFlag!.valueEnum).toContain('stream-json');
  });

  test('no flag has any type', () => {
    // Structural check: all flags have required fields
    for (const flag of GLOBAL_FLAGS) {
      expect(typeof flag.name).toBe('string');
      expect(typeof flag.takesValue).toBe('boolean');
      expect(typeof flag.description).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

describe('allCommandTokens', () => {
  test('no duplicates in result', () => {
    const tokens = allCommandTokens(COMPLETION_COMMANDS);
    const unique = new Set(tokens);
    expect(unique.size).toBe(tokens.length);
  });

  test('all canonical names are present', () => {
    const tokens = new Set(allCommandTokens(COMPLETION_COMMANDS));
    for (const cmd of COMPLETION_COMMANDS) {
      expect(tokens.has(cmd.name)).toBe(true);
    }
  });
});

describe('allFlagTokens', () => {
  test('no duplicates in result', () => {
    const tokens = allFlagTokens(GLOBAL_FLAGS);
    const unique = new Set(tokens);
    expect(unique.size).toBe(tokens.length);
  });

  test('all primary flag names present', () => {
    const tokens = new Set(allFlagTokens(GLOBAL_FLAGS));
    for (const flag of GLOBAL_FLAGS) {
      expect(tokens.has(flag.name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Bash generation
// ---------------------------------------------------------------------------

describe('generateBash', () => {
  const surface = buildCompletionSurface();
  const script = generateBash(surface);

  test('starts with shebang-style comment', () => {
    expect(script).toContain('# bash completion for goodvibes');
  });

  test('contains complete -F declaration', () => {
    expect(script).toContain('complete -F _goodvibes goodvibes');
  });

  test('contains all canonical command tokens', () => {
    const tokens = allCommandTokens(COMPLETION_COMMANDS);
    for (const tok of tokens) {
      expect(script).toContain(tok);
    }
  });

  test('contains all primary flag names', () => {
    for (const flag of GLOBAL_FLAGS) {
      expect(script).toContain(flag.name);
    }
  });

  test('contains output format enum values', () => {
    expect(script).toContain('text');
    expect(script).toContain('json');
    expect(script).toContain('stream-json');
  });

  test('subcommand functions present for commands with subcommands', () => {
    for (const cmd of COMPLETION_COMMANDS) {
      if (cmd.subcommands.length === 0) continue;
      const fnName = `_goodvibes_cmd_${cmd.name.replace(/-/g, '_')}`;
      expect(script).toContain(fnName);
    }
  });

  test('no duplicate complete declarations', () => {
    const completeLines = script
      .split('\n')
      .filter((l) => l.startsWith('complete -F'));
    const unique = new Set(completeLines);
    expect(unique.size).toBe(completeLines.length);
  });
});

// ---------------------------------------------------------------------------
// Zsh generation
// ---------------------------------------------------------------------------

describe('generateZsh', () => {
  const surface = buildCompletionSurface();
  const script = generateZsh(surface);

  test('starts with #compdef directive', () => {
    expect(script.trimStart()).toMatch(/^#compdef goodvibes/);
  });

  test('contains _goodvibes function', () => {
    expect(script).toContain('_goodvibes()');
  });

  test('ends with self-invocation', () => {
    expect(script.trimEnd()).toMatch(/_goodvibes "\$@"$/);
  });

  test('contains all canonical command names', () => {
    for (const cmd of COMPLETION_COMMANDS) {
      if (cmd.name === 'unknown') continue;
      expect(script).toContain(cmd.name);
    }
  });

  test('contains output format enum', () => {
    expect(script).toContain('(text json stream-json)');
  });

  test('contains subcommand describe blocks for commands with subcommands', () => {
    for (const cmd of COMPLETION_COMMANDS) {
      if (cmd.subcommands.length === 0) continue;
      for (const sub of cmd.subcommands) {
        expect(script).toContain(`'${sub}'`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fish generation
// ---------------------------------------------------------------------------

describe('generateFish', () => {
  const surface = buildCompletionSurface();
  const script = generateFish(surface);

  test('starts with header comment', () => {
    expect(script).toContain('# fish completion for goodvibes');
  });

  test('disables default file completion', () => {
    expect(script).toContain('complete -c goodvibes -f');
  });

  test('contains all canonical command names', () => {
    for (const cmd of COMPLETION_COMMANDS) {
      if (cmd.name === 'unknown') continue;
      expect(script).toContain(`"${cmd.name}"`);
    }
  });

  test('contains all primary flag long names', () => {
    for (const flag of GLOBAL_FLAGS) {
      const longName = flag.name.replace(/^--/, '');
      expect(script).toContain(`-l ${longName}`);
    }
  });

  test('output format values appear on the same line as -l output', () => {
    // Values must be attached directly to the -l output declaration so fish
    // can offer them after the flag. A separate __fish_seen_subcommand_from
    // guard line is inert for option flags (that function matches subcommand
    // words, not option tokens).
    const outputLine = script.split('\n').find((l) => l.includes('-l output'));
    expect(outputLine).toBeDefined();
    expect(outputLine).toContain('"text"');
    expect(outputLine).toContain('"json"');
    expect(outputLine).toContain('"stream-json"');
  });

  test('subcommand completions present for commands with subcommands', () => {
    for (const cmd of COMPLETION_COMMANDS) {
      if (cmd.subcommands.length === 0) continue;
      for (const sub of cmd.subcommands) {
        expect(script).toContain(`"${sub}"`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// generateCompletion dispatcher
// ---------------------------------------------------------------------------

describe('generateCompletion', () => {
  test('bash output matches generateBash', () => {
    const surface = buildCompletionSurface();
    expect(generateCompletion('bash')).toBe(generateBash(surface));
  });

  test('zsh output matches generateZsh', () => {
    const surface = buildCompletionSurface();
    expect(generateCompletion('zsh')).toBe(generateZsh(surface));
  });

  test('fish output matches generateFish', () => {
    const surface = buildCompletionSurface();
    expect(generateCompletion('fish')).toBe(generateFish(surface));
  });

  test('custom binary name propagates', () => {
    const script = generateCompletion('bash', 'gv');
    expect(script).toContain('complete -F _gv gv');
  });
});
