/**
 * quality-score.ts
 *
 * Compaction quality scoring — evaluates the output of a compaction strategy
 * by combining compression ratio and semantic retention signals.
 *
 * Score range: 0.0 (worst) → 1.0 (best)
 * Auto-switch threshold: scores below LOW_QUALITY_THRESHOLD trigger a strategy
 * escalation to the next more-aggressive strategy.
 */

import type { StrategyInput, StrategyOutput, CompactionStrategy } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Compaction runs scoring below this value are considered low-quality and
 * trigger an automatic strategy switch.
 */
export const LOW_QUALITY_THRESHOLD = 0.4;

/**
 * Keywords that indicate a message is a compaction handoff/summary note.
 */
const HANDOFF_MARKERS = ['[Session', 'compaction', 'collapsed', 'summarized', 'condensed', 'context window'] as const;

/**
 * Weight given to compression ratio in the composite score (0–1).
 * The remainder is allocated to semantic retention.
 */
const COMPRESSION_WEIGHT = 0.55;

/**
 * Weight given to semantic retention signals in the composite score (0–1).
 */
const RETENTION_WEIGHT = 0.45;

/**
 * Minimum meaningful compression ratio. A run with zero or negative compression
 * scores 0 on the compression axis.
 */
const MIN_COMPRESSION_RATIO = 0;

/**
 * Compression ratio above which the compression dimension is fully saturated.
 * Anything at or above this (e.g. 80% reduction) receives a perfect compression score.
 */
const MAX_COMPRESSION_RATIO = 0.8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Letter grade derived from the composite quality score. */
export type CompactionQualityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Semantic retention signals evaluated during scoring. */
export interface SemanticRetentionSignals {
  /** At least one handoff/summary message is present in the output. */
  hasHandoff: boolean;
  /** Output contains non-trivial content (not just a blank handoff note). */
  hasNonTrivialContent: boolean;
  /** The output message count is a reasonable fraction of the input. */
  messageCountSane: boolean;
  /** The output token count is positive. */
  positiveTokenCount: boolean;
}

/** Full quality score breakdown for a compaction run. */
export interface CompactionQualityScore {
  /** Fraction of tokens removed: (tokensBefore - tokensAfter) / tokensBefore. */
  compressionRatio: number;
  /** Normalised compression dimension score (0–1). */
  compressionScore: number;
  /** Semantic retention dimension score (0–1). */
  retentionScore: number;
  /** Composite quality score: weighted sum of compression + retention (0–1). */
  score: number;
  /** Letter grade derived from score. */
  grade: CompactionQualityGrade;
  /** Individual semantic retention signals. */
  signals: SemanticRetentionSignals;
  /** True when score < LOW_QUALITY_THRESHOLD and strategy escalation should occur. */
  isLowQuality: boolean;
  /** Human-readable description of the score for diagnostics. */
  description: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Extracts plain text content from a provider message.
 */
function extractTextContent(msg: StrategyOutput['messages'][number]): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}

/**
 * Evaluates the semantic retention signals from a strategy output.
 *
 * These are lightweight structural checks — no LLM call required.
 */
function evaluateSemanticRetention(
  input: StrategyInput,
  output: StrategyOutput,
): SemanticRetentionSignals {
  const hasHandoff = output.messages.some((m) => {
    const content = extractTextContent(m);
    return HANDOFF_MARKERS.some((marker) => content.includes(marker));
  });

  const hasNonTrivialContent = output.messages.some((m) => {
    const text = extractTextContent(m);
    // Non-trivial means more than just whitespace, and longer than a minimal stub
    return text.trim().length > 20;
  });

  // Sane if output has at least 1 message and doesn't exceed input count
  const messageCountSane =
    output.messages.length >= 1 &&
    output.messages.length <= input.messages.length;

  const positiveTokenCount = output.tokensAfter > 0;

  return {
    hasHandoff,
    hasNonTrivialContent,
    messageCountSane,
    positiveTokenCount,
  };
}

/**
 * Scores the semantic retention dimension as a 0–1 value.
 *
 * Each signal contributes equally. Missing signals reduce the score.
 */
function scoreRetention(signals: SemanticRetentionSignals): number {
  const checks = [
    signals.hasHandoff,
    signals.hasNonTrivialContent,
    signals.messageCountSane,
    signals.positiveTokenCount,
  ];
  return checks.filter(Boolean).length / checks.length;
}

/**
 * Normalises a raw compression ratio to a 0–1 score.
 *
 * A ratio of 0 (no reduction) → score 0.
 * A ratio at MAX_COMPRESSION_RATIO (e.g. 80%) → score 1.
 * Values above MAX_COMPRESSION_RATIO are clamped at 1.
 * Negative ratios (output larger than input) are clamped at 0.
 */
function scoreCompression(ratio: number): number {
  if (ratio <= MIN_COMPRESSION_RATIO) return 0;
  const normalised = (ratio - MIN_COMPRESSION_RATIO) / (MAX_COMPRESSION_RATIO - MIN_COMPRESSION_RATIO);
  return Math.min(1, Math.max(0, normalised));
}

/**
 * Maps a composite score to a letter grade.
 */
function gradeScore(score: number): CompactionQualityGrade {
  if (score >= 0.85) return 'A';
  if (score >= 0.70) return 'B';
  if (score >= 0.55) return 'C';
  if (score >= LOW_QUALITY_THRESHOLD) return 'D';
  return 'F';
}

/**
 * Produces a human-readable diagnostic description for a quality score.
 */
export function describeScore(score: CompactionQualityScore): string {
  const parts: string[] = [
    `score=${score.score.toFixed(2)} (${score.grade})`,
    `compression=${(score.compressionRatio * 100).toFixed(1)}%`,
    `retention=${(score.retentionScore * 100).toFixed(0)}%`,
  ];
  if (score.isLowQuality) {
    parts.push('LOW_QUALITY — strategy switch triggered');
  }
  return parts.join(', ');
}

/**
 * Computes the quality score for a completed compaction strategy run.
 *
 * @param input  - The strategy input (pre-compaction state).
 * @param output - The strategy output (post-compaction state).
 * @returns A full CompactionQualityScore breakdown.
 */
function scoreCompactionOutput(
  input: StrategyInput,
  output: StrategyOutput,
): CompactionQualityScore {
  // Compression ratio: fraction of tokens removed
  const compressionRatio =
    input.tokensBefore > 0
      ? Math.max(0, (input.tokensBefore - output.tokensAfter) / input.tokensBefore)
      : 0;

  const compressionScore = scoreCompression(compressionRatio);

  const signals = evaluateSemanticRetention(input, output);
  const retentionScore = scoreRetention(signals);

  const score =
    COMPRESSION_WEIGHT * compressionScore + RETENTION_WEIGHT * retentionScore;

  const grade = gradeScore(score);
  const isLowQuality = score < LOW_QUALITY_THRESHOLD;

  return {
    compressionRatio,
    compressionScore,
    retentionScore,
    score,
    grade,
    signals,
    isLowQuality,
    description: '',  // filled below to avoid circular call
  };
}

/**
 * Computes the quality score with description filled in.
 *
 * Prefer this over `scoreCompactionOutput` for all public use.
 */
export function computeQualityScore(
  input: StrategyInput,
  output: StrategyOutput,
): CompactionQualityScore {
  const partial = scoreCompactionOutput(input, output);
  const full: CompactionQualityScore = { ...partial, description: '' };
  full.description = describeScore(full);
  return full;
}

// ---------------------------------------------------------------------------
// Strategy escalation
// ---------------------------------------------------------------------------

/**
 * Returns the next more-aggressive strategy for escalation when quality is low.
 *
 * Escalation path:
 *   microcompact → autocompact → collapse → collapse (ceiling)
 *   reactive     → reactive (already maximum)
 *
 * @param current - The strategy that produced the low-quality result.
 * @returns The escalated strategy to re-run with.
 */
export function escalateStrategy(current: CompactionStrategy): CompactionStrategy {
  switch (current) {
    case 'microcompact': return 'autocompact';
    case 'autocompact':  return 'collapse';
    case 'collapse':     return 'collapse'; // already most aggressive
    case 'reactive':     return 'reactive'; // emergency — cannot escalate further
    default: {
      const _exhaustive: never = current;
      throw new Error(`Unknown compaction strategy: ${_exhaustive}`);
    }
  }
}
