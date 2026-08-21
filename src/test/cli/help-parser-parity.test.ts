/**
 * Help-vs-parser parity test.
 *
 * This is a lint-style guard: every flag the parser recognises must appear in
 * --help output; every flag in --help must be accepted by the parser without
 * an "Unknown option" error; and every flag in the GLOBAL_FLAGS completions
 * table must correspond to a parseable flag.
 *
 * This test fails fast when flags drift between parser.ts, help.ts, and
 * completions/generate.ts, preventing silent documentation rot.
 */

import { describe, expect, test } from 'bun:test';
import { GOODVIBES_CLI_CATALOG, parseGoodVibesCli } from '@pellux/goodvibes-terminal-shell';
import { renderGoodVibesHelp } from '../../cli/help.ts';
import { GLOBAL_FLAGS } from '../../cli/completions/generate.ts';

// ---------------------------------------------------------------------------
// Ground truth: flags that the parser recognises.
//
// Derived by walking parser.ts branch-by-branch. Each entry is one long-form
// token the parser handles directly (aliases listed separately). When adding
// a flag to parser.ts, add it here too, the parity test will then enforce
// that help and completions are updated.
// ---------------------------------------------------------------------------

const PARSER_KNOWN_LONG_FLAGS = [
  '--help',
  '--version',
  '--print',
  '--json',
  '--no-alt-screen',
  '--open',
  '--continue',
  '--yes',
  '--non-interactive',
  '--strict',
  '--provider',
  '--model',
  '--daemon-home',
  '--working-dir',
  '--prompt',
  '--output-format',
  '--output',
  '--config',
  '--enable',
  '--disable',
  '--port',
  '--hostname',
  '--host',
  '--resume',
  '--session',
  '--fork',
] as const;

/** Short-flag aliases: each maps to a long flag in PARSER_KNOWN_LONG_FLAGS. */
const PARSER_SHORT_TO_LONG: ReadonlyMap<string, string> = new Map([
  ['-h', '--help'],
  ['-v', '--version'],
  ['-m', '--model'],
  ['-C', '--working-dir'],
  ['-c', '--config'],
  ['-p', '--prompt'],
  ['-o', '--output'],
  ['-r', '--resume'],
  ['-s', '--session'],
  ['-y', '--yes'],
]);

// ---------------------------------------------------------------------------
// Programmatic extraction: flags recognised by parser.ts source code.
//
// We read the parser source and regex-extract every flag literal from the
// `name === '--x'` and `name === '-x'` patterns the parser uses for its
// branch conditions.  The extracted set is then compared against the
// hand-maintained lists above so that any flag added to parser.ts but
// forgotten in the lists (or vice-versa) causes an immediate test failure.
// ---------------------------------------------------------------------------

/**
 * Every flag token this terminal's CLI vocabulary declares, read off the
 * catalog the parser is driven by. This is the ground truth the hand-lists
 * below are checked against, a declared token IS what the parser accepts, so
 * there is nothing to scrape and nothing that can be true of the source text
 * and false of the parse.
 */
function extractParserFlags(): Set<string> {
  const found = new Set<string>();
  for (const spec of GOODVIBES_CLI_CATALOG.globalFlags) {
    for (const token of spec.tokens) found.add(token);
  }
  for (const command of GOODVIBES_CLI_CATALOG.commands) {
    for (const spec of command.flags ?? []) {
      for (const token of spec.tokens) found.add(token);
    }
  }
  return found;
}

const PARSER_SOURCE_FLAGS = extractParserFlags();

// Long flags extracted from the parser source (everything starting with '--').
const SOURCE_LONG_FLAGS = new Set([...PARSER_SOURCE_FLAGS].filter((f) => f.startsWith('--')));
// Short flags extracted from the parser source (single dash + letter).
const SOURCE_SHORT_FLAGS = new Set([...PARSER_SOURCE_FLAGS].filter((f) => f.startsWith('-') && !f.startsWith('--')));

// ---------------------------------------------------------------------------
// Guard: hand-list set-equality vs. extracted set
//
// A flag added to parser.ts must also be added to the hand-list here, or this
// test will fail. That is the intended behaviour, the hand-list is the human
// cross-check; this assertion is what makes it drift-proof.
// ---------------------------------------------------------------------------

describe('help-parser parity: hand-lists match parser source', () => {
  // Build the set from the hand-maintained long-flag list for comparison.
  // --cd and --working-dir are the same branch; parser source has --cd as a
  // secondary literal.  Include it in the expected set extracted from source.
  const HAND_LONG_SET = new Set<string>(PARSER_KNOWN_LONG_FLAGS);

  // parser.ts has `name === '--cd'` as a secondary alias alongside --working-dir;
  // it is intentionally omitted from PARSER_KNOWN_LONG_FLAGS (covered by
  // --working-dir) and from completions.  Account for it in the source set
  // rather than adding it to the hand-list.
  const SOURCE_LONG_ADJUSTED = new Set(SOURCE_LONG_FLAGS);
  SOURCE_LONG_ADJUSTED.delete('--cd'); // alias of --working-dir; hand-list uses the canonical

  test('every long flag in the CLI catalog is in PARSER_KNOWN_LONG_FLAGS', () => {
    const missing = [...SOURCE_LONG_ADJUSTED].filter((f) => !HAND_LONG_SET.has(f));
    expect(missing).toEqual([]);
  });

  test('every entry in PARSER_KNOWN_LONG_FLAGS exists in the CLI catalog', () => {
    const phantom = [...HAND_LONG_SET].filter((f) => !SOURCE_LONG_FLAGS.has(f));
    expect(phantom).toEqual([]);
  });

  // Short flags: hand-list is the keys of PARSER_SHORT_TO_LONG.
  const HAND_SHORT_SET = new Set<string>(PARSER_SHORT_TO_LONG.keys());

  test('every short flag in the CLI catalog is in PARSER_SHORT_TO_LONG', () => {
    const missing = [...SOURCE_SHORT_FLAGS].filter((f) => !HAND_SHORT_SET.has(f));
    expect(missing).toEqual([]);
  });

  test('every entry in PARSER_SHORT_TO_LONG exists in the CLI catalog', () => {
    const phantom = [...HAND_SHORT_SET].filter((f) => !SOURCE_SHORT_FLAGS.has(f));
    expect(phantom).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

function parse(args: string[]) {
  return parseGoodVibesCli(args, 'goodvibes');
}

/** Returns true when the parser did NOT emit an "Unknown option" error for a
 * flag token. Flags that need a value are supplied a dummy argument. */
function isKnownToParser(flag: string, needsValue = false): boolean {
  const args = needsValue ? [flag, 'dummy'] : [flag];
  const result = parse(args);
  return !result.errors.some((e) => e.startsWith('Unknown option:'));
}

// ---------------------------------------------------------------------------
// Flags that take a value argument (used to avoid false "requires value" errors
// when testing parser acceptance).
// ---------------------------------------------------------------------------

const FLAGS_THAT_TAKE_VALUE = new Set([
  '--provider',
  '--model',
  '--daemon-home',
  '--working-dir',
  '--prompt',
  '--output-format',
  '--output',
  '--config',
  '--enable',
  '--disable',
  '--port',
  '--hostname',
  '--host',
  '--session',
  // --resume and --fork are optional-value; bare forms work fine
]);

// ---------------------------------------------------------------------------
// 1. Parser accepts every documented long flag without "Unknown option" error
// ---------------------------------------------------------------------------

describe('help-parser parity: parser accepts every known long flag', () => {
  for (const flag of PARSER_KNOWN_LONG_FLAGS) {
    test(`parser accepts ${flag}`, () => {
      const needsValue = FLAGS_THAT_TAKE_VALUE.has(flag);
      expect(isKnownToParser(flag, needsValue)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Parser accepts every known short flag
// ---------------------------------------------------------------------------

describe('help-parser parity: parser accepts every known short flag', () => {
  for (const [shortFlag, longFlag] of PARSER_SHORT_TO_LONG) {
    test(`parser accepts ${shortFlag} (alias for ${longFlag})`, () => {
      const needsValue = FLAGS_THAT_TAKE_VALUE.has(longFlag);
      expect(isKnownToParser(shortFlag, needsValue)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Help text contains every documented long flag
// ---------------------------------------------------------------------------

describe('help-parser parity: --help text contains every parser flag', () => {
  const helpText = renderGoodVibesHelp('goodvibes');

  // Flags that are aliases documented inline (not on their own line in help)
  // and therefore may appear anywhere in the help string rather than as a
  // standalone option entry.
  const HELP_INLINE_FLAGS = new Set(['--host', '--output-format', '--working-dir', '--print', '--json']);

  for (const flag of PARSER_KNOWN_LONG_FLAGS) {
    test(`help contains ${flag}`, () => {
      expect(helpText).toContain(flag);
    });
  }

  // Short aliases should also appear in help text
  for (const shortFlag of PARSER_SHORT_TO_LONG.keys()) {
    test(`help contains short alias ${shortFlag}`, () => {
      expect(helpText).toContain(shortFlag);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. GLOBAL_FLAGS completions table, no ghost flags (must be parseable)
// ---------------------------------------------------------------------------

describe('help-parser parity: GLOBAL_FLAGS completions has no ghost flags', () => {
  for (const flag of GLOBAL_FLAGS) {
    test(`GLOBAL_FLAGS["${flag.name}"] is accepted by the parser`, () => {
      const needsValue = flag.takesValue;
      expect(isKnownToParser(flag.name, needsValue)).toBe(true);
    });

    if (flag.short !== undefined) {
      const short = flag.short;
      test(`GLOBAL_FLAGS short "${short}" is accepted by the parser`, () => {
        const needsValue = flag.takesValue;
        expect(isKnownToParser(short, needsValue)).toBe(true);
      });
    }

    if (flag.aliases !== undefined) {
      for (const alias of flag.aliases) {
        test(`GLOBAL_FLAGS alias "${alias}" (of "${flag.name}") is accepted by the parser`, () => {
          const needsValue = flag.takesValue;
          expect(isKnownToParser(alias, needsValue)).toBe(true);
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 5. GLOBAL_FLAGS completions table, no missing flags (every parser flag present)
// ---------------------------------------------------------------------------

describe('help-parser parity: GLOBAL_FLAGS completions contains all parser flags', () => {
  const allCompletionTokens = new Set<string>();
  for (const flag of GLOBAL_FLAGS) {
    allCompletionTokens.add(flag.name);
    if (flag.short !== undefined) allCompletionTokens.add(flag.short);
    for (const alias of flag.aliases ?? []) allCompletionTokens.add(alias);
  }

  // Flags that are intentionally absent from completions (pure aliases that
  // are covered by their canonical entry). Add to this set only when there is
  // a clear reason; do NOT use it to paper over real drift.
  const ALLOWED_ABSENT_FROM_COMPLETIONS = new Set<string>([
    // --output-format is in GLOBAL_FLAGS as an alias of --output
    // --working-dir is in GLOBAL_FLAGS as an alias of --cd
    // --host is in GLOBAL_FLAGS as an alias of --hostname
  ]);

  for (const flag of PARSER_KNOWN_LONG_FLAGS) {
    if (ALLOWED_ABSENT_FROM_COMPLETIONS.has(flag)) continue;
    test(`GLOBAL_FLAGS contains parser flag ${flag}`, () => {
      expect(allCompletionTokens.has(flag)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Deprecation warning: --output-format emits a deprecation warning
// ---------------------------------------------------------------------------

describe('deprecation warnings', () => {
  test('--output-format emits a deprecation warning in result.warnings', () => {
    const result = parse(['--output-format', 'json']);
    expect(result.warnings).toContain(
      '--output-format is deprecated; use --output (or -o) instead.',
    );
    // Still works, parses the value correctly
    expect(result.flags.outputFormat).toBe('json');
    // Not a hard error
    expect(result.errors).toHaveLength(0);
  });

  test('--output does NOT emit a deprecation warning', () => {
    const result = parse(['--output', 'json']);
    expect(result.warnings).toHaveLength(0);
  });

  test('-o (short) does NOT emit a deprecation warning', () => {
    const result = parse(['-o', 'stream-json']);
    expect(result.warnings).toHaveLength(0);
  });

  test('multiple --output-format usages accumulate multiple warnings', () => {
    const result = parse(['--output-format', 'json', '--output-format', 'text']);
    expect(result.warnings.filter((w) => w.includes('--output-format is deprecated'))).toHaveLength(2);
  });

  test('result.warnings is empty by default (no flags)', () => {
    const result = parse([]);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. No ghost flags in help text (spot-check for removed flags)
// ---------------------------------------------------------------------------

describe('help-parser parity: help text has no ghost flags', () => {
  const helpText = renderGoodVibesHelp('goodvibes');

  // Flags that were removed from the parser but must NOT appear in help.
  // If completions/generate.ts listed them, they were ghost flags.
  const REMOVED_FLAGS = ['--raw-output', '--accept-raw-output-risk'];

  for (const flag of REMOVED_FLAGS) {
    test(`help does NOT contain removed flag ${flag}`, () => {
      expect(helpText).not.toContain(flag);
    });
  }
});
