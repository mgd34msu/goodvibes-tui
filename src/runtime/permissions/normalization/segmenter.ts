/**
 * Segmenter — splits a list of CommandTokens into discrete CommandSegments
 * at compound command boundaries (&&, ||, ;, |).
 *
 * Each segment carries its own token list, resolved command name, positional
 * args, flags, and the operator that connects it to the next segment.
 */

import type { CommandSegment, CommandToken } from './types.ts';
import { canonicalize } from './canonicalizer.ts';

/** Operator token types that act as segment boundaries. */
type SegmentBoundary = '&&' | '||' | ';' | '|';

const BOUNDARY_VALUES = new Set<string>(['&&', '||', ';', '|']);

/**
 * Builds a single CommandSegment from a slice of tokens and an optional
 * trailing operator.
 *
 * @param tokens - Tokens belonging to this segment (excluding operator).
 * @param operator - The operator that follows this segment, if any.
 * @returns A fully populated CommandSegment.
 */
function buildSegment(
  tokens: CommandToken[],
  operator?: SegmentBoundary,
): CommandSegment {
  const commandToken = tokens.find((t) => t.type === 'command');
  const rawCommand = commandToken?.value ?? '';
  const command = canonicalize(rawCommand);

  const args = tokens
    .filter((t) => t.type === 'argument')
    .map((t) => t.value);

  const flags = tokens
    .filter((t) => t.type === 'flag')
    .map((t) => t.value);

  const raw = tokens.map((t) => t.value).join(' ');

  return { raw, tokens, command, args, flags, operator };
}

/**
 * Splits an ordered list of CommandTokens into CommandSegments, splitting
 * at operator and pipe tokens (&&, ||, ;, |).
 *
 * @param tokens - The full token list from the tokenizer.
 * @returns Ordered array of CommandSegment objects.
 */
export function segment(tokens: CommandToken[]): CommandSegment[] {
  if (tokens.length === 0) return [];

  const segments: CommandSegment[] = [];
  let currentTokens: CommandToken[] = [];

  for (const token of tokens) {
    if (
      (token.type === 'operator' || token.type === 'pipe') &&
      BOUNDARY_VALUES.has(token.value)
    ) {
      const operator = token.value as SegmentBoundary;
      segments.push(buildSegment(currentTokens, operator));
      currentTokens = [];
    } else {
      currentTokens.push(token);
    }
  }

  // Push the final segment (no trailing operator)
  if (currentTokens.length > 0) {
    segments.push(buildSegment(currentTokens));
  }

  return segments;
}
