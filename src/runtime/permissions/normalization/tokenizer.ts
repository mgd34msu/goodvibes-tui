/**
 * Tokenizer — converts a raw shell command string into an ordered list
 * of CommandToken objects.
 *
 * Handles:
 *  - Single- and double-quoted strings (preserves inner whitespace)
 *  - Shell operators: &&, ||, ;, |, >, >>, <, 2>
 *  - Variable expansions: $VAR, ${VAR}
 *  - Subshell expressions: $(...) and `...`
 *  - Flags (tokens starting with -)
 *  - Path-like tokens (contain / or ~)
 */

import type { CommandToken } from './types.ts';

/** Shell operator strings recognized by the tokenizer. */
const OPERATOR_TOKENS = new Set(['&&', '||', ';', '|', '>', '>>', '<', '2>']);

/** Shell redirect operator prefixes (single-char). */
const REDIRECT_CHARS = new Set(['>', '<']);

/**
 * Determines the semantic type for a raw token string.
 *
 * @param raw - The raw token value.
 * @param isFirst - True when this is the first non-operator token in its segment.
 * @returns The appropriate CommandToken type.
 */
function classifyTokenType(
  raw: string,
  isFirst: boolean,
): CommandToken['type'] {
  if (OPERATOR_TOKENS.has(raw)) {
    if (raw === '|' || raw === '&&' || raw === '||' || raw === ';') {
      return raw === '|' ? 'pipe' : 'operator';
    }
    return 'redirect';
  }
  if (raw.startsWith('$(') || raw.startsWith('`')) return 'subshell';
  if (raw.startsWith('-')) return 'flag';
  if (raw.includes('/') || raw.startsWith('~') || raw.startsWith('./') || raw.startsWith('../')) return 'path';
  if (isFirst) return 'command';
  return 'argument';
}

/**
 * Splits a command string into raw token strings, respecting quoting.
 *
 * @param input - The raw command string.
 * @returns Array of [rawValue, position] pairs.
 */
function splitRaw(input: string): Array<{ value: string; position: number }> {
  const results: Array<{ value: string; position: number }> = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace
    if (input[i] === ' ' || input[i] === '\t' || input[i] === '\n') {
      i++;
      continue;
    }

    const start = i;

    // Check for two-character operators first
    if (i + 1 < len) {
      const two = input.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '>>' || two === '2>') {
        results.push({ value: two, position: start });
        i += 2;
        continue;
      }
    }

    // Single-character operators
    const ch = input[i]!;
    if (ch === ';' || ch === '|' || ch === '<') {
      results.push({ value: ch, position: start });
      i++;
      continue;
    }
    if (ch === '>') {
      results.push({ value: '>', position: start });
      i++;
      continue;
    }

    // Backtick subshell
    if (ch === '`') {
      let j = i + 1;
      while (j < len && input[j] !== '`') j++;
      const raw = input.slice(i, j + 1);
      results.push({ value: raw, position: start });
      i = j + 1;
      continue;
    }

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < len && input[j] !== quote) {
        if (input[j] === '\\' && quote === '"') j++; // skip escaped char
        j++;
      }
      const raw = input.slice(i, j + 1);
      results.push({ value: raw, position: start });
      i = j + 1;
      continue;
    }

    // Regular token — read until whitespace or operator
    let j = i;
    while (j < len) {
      const c = input[j]!;
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === ';' || c === '|' || c === '<' || c === '>') break;
      if (j + 1 < len && (input.slice(j, j + 2) === '&&' || input.slice(j, j + 2) === '||')) break;
      // Backslash escape: consume the next character as a literal
      if (c === '\\' && j + 1 < len) { j += 2; continue; }
      j++;
    }
    results.push({ value: input.slice(i, j), position: start });
    i = j;
  }

  return results;
}

/**
 * Tokenizes a raw shell command string into an ordered array of CommandTokens.
 *
 * @param command - The raw shell command string to tokenize.
 * @returns Ordered array of CommandToken objects.
 */
export function tokenize(command: string): CommandToken[] {
  const raw = splitRaw(command);
  const tokens: CommandToken[] = [];
  let seenCommand = false;

  for (const { value, position } of raw) {
    const isOperator = OPERATOR_TOKENS.has(value);
    const isFirst = !seenCommand && !isOperator;

    const type = classifyTokenType(value, isFirst);

    // After an operator, the next non-operator token is a new command
    if (type === 'operator' || type === 'pipe') {
      seenCommand = false;
    } else if (type === 'command') {
      seenCommand = true;
    }

    tokens.push({ value, type, position });
  }

  return tokens;
}
