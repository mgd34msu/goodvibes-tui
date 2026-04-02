/**
 * Command normalization pipeline — barrel export and primary entry point.
 *
 * Exposes the normalizeCommand() function and all supporting types.
 * Pipeline: tokenize → segment → classify → NormalizedCommand
 */

export type {
  CommandToken,
  CommandSegment,
  CommandClassification,
  NormalizedCommand,
} from './types.ts';

export { tokenize } from './tokenizer.ts';
export { segment } from './segmenter.ts';
export { canonicalize } from './canonicalizer.ts';
export { classifySegment, classifyCommand, higherPriority } from './classifier.ts';

import { tokenize } from './tokenizer.ts';
import { segment } from './segmenter.ts';
import { classifyCommand } from './classifier.ts';
import type { NormalizedCommand } from './types.ts';

/**
 * Normalizes a raw shell command string into a fully analyzed NormalizedCommand.
 *
 * Pipeline:
 *  1. Tokenize: split the string into lexical tokens.
 *  2. Segment: split compound commands (&&, ||, ;, |) into segments.
 *  3. Classify: assign risk classifications and detect dangerous patterns.
 *
 * @param command - The raw shell command string to normalize.
 * @returns A NormalizedCommand with segments, classifications, and pattern analysis.
 *
 * @example
 * const result = normalizeCommand('rm -rf /tmp && git push --force');
 * result.highestClassification; // 'destructive'
 * result.hasDangerousPatterns; // true
 * result.dangerousPatterns; // ['rm -rf: recursive forced deletion', ...]
 */
export function normalizeCommand(command: string): NormalizedCommand {
  const trimmed = command.trim();
  const tokens = tokenize(trimmed);
  const segments = segment(tokens);
  const analysis = classifyCommand(trimmed, segments);

  return {
    original: command,
    segments,
    ...analysis,
  };
}
