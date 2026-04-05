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

export type {
  ShellNode,
  CommandNode,
  PipeNode,
  SequenceNode,
  SubshellNode,
} from './ast.ts';

export type {
  SegmentVerdict,
  CompoundVerdict,
} from './verdict.ts';

export { tokenize } from './tokenizer.ts';
export { segment } from './segmenter.ts';
export { canonicalize } from './canonicalizer.ts';
export { classifySegment, classifyCommand, higherPriority } from './classifier.ts';
export { collectCommandNodes, describeNode } from './ast.ts';
export { parseAST, parseCommandAST } from './parser.ts';
export { evaluateSegmentNode, evaluateCommandAST, buildDenialExplanation, DEFAULT_ALLOWED_CLASSES } from './verdict.ts';

import { tokenize } from './tokenizer.ts';
import { segment } from './segmenter.ts';
import { classifyCommand } from './classifier.ts';
import type { NormalizedCommand, CommandClassification } from './types.ts';
import { parseCommandAST } from './parser.ts';
import { evaluateCommandAST, DEFAULT_ALLOWED_CLASSES } from './verdict.ts';
import type { CompoundVerdict } from './verdict.ts';

/**
 * Normalizes a raw shell command string and evaluates per-segment verdicts.
 *
 * Uses the Shell AST parser to produce a CompoundVerdict with
 * per-segment classification and denial reasons. Requires the
 * `shell-ast-normalization` feature flag to be enabled; falls back to
 * `normalizeCommand` when the flag is disabled.
 *
 * @param command        - The raw shell command string to evaluate.
 * @param allowedClasses - Classification tiers to allow (default: read+write+network).
 * @returns A CompoundVerdict with per-segment breakdown.
 */
export function normalizeCommandWithVerdicts(
  command: string,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
): CompoundVerdict {
  const ast = parseCommandAST(command);
  return evaluateCommandAST(command, ast, allowedClasses);
}

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
