// ---------------------------------------------------------------------------
// command-grammar.test.ts
// Command naming-grammar consistency lint.
//
// Conventions (derived from the majority pattern across 123 registered commands):
//
//   NAME        Lowercase kebab-case: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
//               Vim-style colon-prefix aliases (:q, :wq) are allowlisted.
//
//   ALIASES     Same pattern as name, OR a single letter, OR vim-prefix.
//               An alias must not be an empty string.
//
//   USAGE       Angle brackets for required args: "<arg>"
//               Square brackets for optional args: "[arg]"
//               MUST NOT be an empty string, omit the field instead.
//
//   ARGS_HINT   MUST be present for simple single-placeholder commands whose
//               usage is exactly "<arg>", "[arg]", or a two-token form of those.
//               Complex subcommand surfaces (usage lists alternatives with "|") are
//               exempt, they intentionally omit argsHint.
//               MUST NOT be an empty string when present, omit the field instead.
//
//   DESCRIPTION Starts with an uppercase letter.
//               Does NOT end with a period.
//               Must not be empty.
//
// Allowlist (commands that violate a specific rule for a documented reason):
//   See ALLOWLIST below. Each entry names the command + rule + reason.
//   The test asserts that every allowlist entry still refers to an existing
//   command (no stale entries).
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

// ---------------------------------------------------------------------------
// Convention helpers
// ---------------------------------------------------------------------------

/** Kebab-case name pattern: lowercase letters, digits, hyphens (not leading). */
const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Vim-prefix aliases allowed by design (single-char prefix + letter). */
const VIM_PREFIX_RE = /^:[a-z]+$/;

function isValidName(name: string): boolean {
  return KEBAB_RE.test(name);
}

function isValidAlias(alias: string): boolean {
  if (alias.length === 0) return false;
  if (VIM_PREFIX_RE.test(alias)) return true;
  // Single-letter aliases are allowed
  if (alias.length === 1 && /^[a-z]$/.test(alias)) return true;
  return KEBAB_RE.test(alias);
}

/** Returns true if usage contains angle/square-bracket placeholders. */
function usageTakesArgs(usage: string | null | undefined): boolean {
  if (!usage) return false;
  return /<[^>]+>|\[[^\]]+\]/.test(usage);
}

// ---------------------------------------------------------------------------
// Allowlist: commands exempted from specific rules with documented reasons
//
// shape: { name, rule, reason }
// Rules: 'name-kebab' | 'alias-kebab' | 'usage-empty' | 'args-hint-presence'
//        | 'desc-capital' | 'desc-no-trailing-period'
// ---------------------------------------------------------------------------

const ALLOWLIST: Array<{ name: string; rule: string; reason: string }> = [
  // /help alias "?", conventional Unix/CLI help shorthand; widely understood;
  // not kebab-case but an accepted single-character punctuation alias.
  { name: 'help', rule: 'alias-kebab', reason: '"?" is the conventional Unix help shorthand and a deliberate UX choice' },
];

// ---------------------------------------------------------------------------
// Test bootstrap
// ---------------------------------------------------------------------------

const registry = new CommandRegistry();
registerBuiltinCommands(registry);
const allCommands = registry.getAll();

// Build fast lookup for allowlist checks
const allowlistByNameAndRule = new Map<string, Set<string>>();
for (const entry of ALLOWLIST) {
  let rules = allowlistByNameAndRule.get(entry.name);
  if (!rules) {
    rules = new Set();
    allowlistByNameAndRule.set(entry.name, rules);
  }
  rules.add(entry.rule);
}

function isAllowlisted(name: string, rule: string): boolean {
  return allowlistByNameAndRule.get(name)?.has(rule) ?? false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Slash-command grammar lint', () => {
  test('registry loads with commands registered (smoke)', () => {
    expect(allCommands.length).toBeGreaterThan(10);
  });

  test('primary name is lowercase kebab-case', () => {
    const violations: string[] = [];
    for (const cmd of allCommands) {
      if (isAllowlisted(cmd.name, 'name-kebab')) continue;
      if (!isValidName(cmd.name)) {
        violations.push(`/${cmd.name}: primary name "${cmd.name}" does not match kebab-case pattern`);
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('aliases are lowercase kebab-case, single-letter, or vim-style (:q)', () => {
    const violations: string[] = [];
    for (const cmd of allCommands) {
      for (const alias of cmd.aliases ?? []) {
        if (isAllowlisted(cmd.name, 'alias-kebab')) continue;
        if (!isValidAlias(alias)) {
          violations.push(`/${cmd.name}: alias "${alias}" does not match allowed alias pattern`);
        }
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('usage is not an empty string (omit the field instead)', () => {
    const violations: string[] = [];
    for (const cmd of allCommands) {
      if (isAllowlisted(cmd.name, 'usage-empty')) continue;
      // Type annotation: usage is string | undefined. Runtime may carry '' from JS.
      const usage = cmd.usage as string | null | undefined;
      if (usage === '') {
        violations.push(
          `/${cmd.name}: usage is an empty string; omit the field when the command takes no arguments`,
        );
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('argsHint is not an empty string (omit the field instead)', () => {
    // argsHint presence is optional for complex subcommand surfaces (many panel-launchers
    // document their subcommands in usage but don't surface an inline hint).
    // When argsHint IS present, it must not be empty, omit the field instead.
    const violations: string[] = [];
    for (const cmd of allCommands) {
      if (isAllowlisted(cmd.name, 'args-hint-empty')) continue;
      const hint = cmd.argsHint as string | null | undefined;
      if (hint !== null && hint !== undefined && hint.trim() === '') {
        violations.push(
          `/${cmd.name}: argsHint is an empty string; omit the field when no inline hint is needed`,
        );
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('argsHint is present for simple single-arg commands (those with usage of the form "<arg>" or "[arg]")', () => {
    // Enforce argsHint only for commands whose usage string is a simple single placeholder
    // (e.g. "<model-id>", "[name]", "<text>"). Complex subcommand usage strings are exempt
    // because many panel-launcher commands intentionally list subcommands in usage as
    // documentation but do not surface an inline hint.
    const SIMPLE_USAGE_RE = /^[<\[][^|>\]]+[>\]]$|^[<\[][^|>\]]+[>\]]\s+[<\[][^|>\]]+[>\]]$/;
    const violations: string[] = [];
    for (const cmd of allCommands) {
      if (isAllowlisted(cmd.name, 'args-hint-presence')) continue;
      const usage = cmd.usage as string | null | undefined;
      if (usage && SIMPLE_USAGE_RE.test(usage.trim())) {
        const hint = cmd.argsHint as string | null | undefined;
        if (!hint || hint.trim() === '') {
          violations.push(
            `/${cmd.name}: usage "${usage}" is a simple placeholder but argsHint is missing`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('description starts with an uppercase letter', () => {
    const violations: string[] = [];
    for (const cmd of allCommands) {
      if (isAllowlisted(cmd.name, 'desc-capital')) continue;
      const first = cmd.description[0];
      if (!first || first !== first.toUpperCase() || first === first.toLowerCase()) {
        violations.push(
          `/${cmd.name}: description "${cmd.description.slice(0, 60)}" does not start with an uppercase letter`,
        );
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('description does not end with a period', () => {
    const violations: string[] = [];
    for (const cmd of allCommands) {
      if (isAllowlisted(cmd.name, 'desc-no-trailing-period')) continue;
      if (cmd.description.trimEnd().endsWith('.')) {
        violations.push(
          `/${cmd.name}: description ends with a period; trailing periods are not part of the convention`,
        );
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('description is not empty', () => {
    const violations: string[] = [];
    for (const cmd of allCommands) {
      if (!cmd.description || cmd.description.trim() === '') {
        violations.push(`/${cmd.name}: description is empty`);
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  test('allowlist contains only existing commands (no stale entries)', () => {
    const registeredNames = new Set(allCommands.map((c) => c.name));
    const stale: string[] = [];
    for (const entry of ALLOWLIST) {
      if (!registeredNames.has(entry.name)) {
        stale.push(
          `Allowlist entry for "/${entry.name}" (rule: ${entry.rule}) is stale; no such command is registered`,
        );
      }
    }
    expect(stale, stale.join('\n')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Negative fixture: verify the lint catches a nonconforming registration.
  // This uses a fresh registry so it does not pollute the shared one.
  // -------------------------------------------------------------------------
  test('lint catches a nonconforming command in a fresh registry (negative fixture)', () => {
    const fresh = new CommandRegistry();
    // Register a command that violates multiple rules:
    //   - name uses CamelCase (fails name-kebab)
    //   - usage is empty string (fails usage-empty)
    //   - description ends with period (fails desc-no-trailing-period)
    fresh.register({
      name: 'BadCommand',
      aliases: [],
      description: 'This is wrong.',
      usage: '',
      handler: () => {},
    });

    const [bad] = fresh.getAll();
    if (!bad) throw new Error('Expected a command to be registered');

    // Name violation
    expect(isValidName(bad.name)).toBe(false);
    // Usage-empty violation
    expect(bad.usage).toBe('');
    // Description trailing period violation
    expect(bad.description.trimEnd().endsWith('.')).toBe(true);

    // Alias predicate violations (and guards against over-tightening)
    expect(isValidAlias('Bad')).toBe(false);
    expect(isValidAlias('')).toBe(false);
    expect(isValidAlias(':q')).toBe(true);
    expect(isValidAlias('m')).toBe(true);

    // Second nonconforming registration: arg-taking usage with no argsHint,
    // lowercase description start, non-kebab alias.
    fresh.register({
      name: 'bad-two',
      aliases: ['Bad_Alias'],
      description: 'lowercase start',
      usage: '<thing>',
      handler: () => {},
    });
    const badTwo = fresh.getAll().find((c) => c.name === 'bad-two');
    if (!badTwo) throw new Error('Expected bad-two to be registered');
    // args-hint-presence violation: simple placeholder usage, argsHint absent
    expect(usageTakesArgs(badTwo.usage)).toBe(true);
    expect(badTwo.argsHint ?? '').toBe('');
    // desc-capital violation
    expect(/^[A-Z]/.test(badTwo.description)).toBe(false);
    // alias violation detected on a live registration
    expect((badTwo.aliases ?? []).every(isValidAlias)).toBe(false);

    // Third registration: a blank description no longer registers at all,
    // the registry refuses it at the door, which supersedes detect-after-the-fact.
    expect(() =>
      fresh.register({
        name: 'bad-three',
        aliases: [],
        description: '   ',
        handler: () => {},
      }),
    ).toThrow(/no description/);
    expect(fresh.getAll().some((c) => c.name === 'bad-three')).toBe(false);
  });
});
