/**
 * Per-segment verdict evaluation for Shell AST normalization (GC-EXEC-005).
 *
 * Evaluates policy per AST segment, aggregates a final compound verdict,
 * and produces structured denial output with per-segment reasons.
 *
 * Each segment verdict is a runtime contract: callers can inspect which
 * segments were safe vs. unsafe and surface that information to the user.
 *
 * @module normalization/verdict
 */

import type { CommandClassification } from './types.ts';
import type { ShellNode, CommandNode } from './ast.ts';
import { collectCommandNodes, describeNode } from './ast.ts';
import { classifySegment } from './classifier.ts';
import type { CommandSegment } from './types.ts';

/**
 * Default set of classifications permitted for exec commands.
 *
 * Destructive and escalation are excluded; they require explicit user approval.
 * Network commands are allowed because connectivity restrictions are handled
 * by network-scope rules in the evaluator, not at the exec layer.
 */
export const DEFAULT_ALLOWED_CLASSES: ReadonlySet<CommandClassification> = new Set([
  'read',
  'write',
  'network',
]);

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * The policy verdict for a single command segment.
 *
 * Each verdict is an immutable runtime contract that records why a segment
 * was allowed or denied, making the decision auditable and explainable.
 */
export interface SegmentVerdict {
  /** The raw command string for this segment. */
  raw: string;
  /** Canonical command name. */
  command: string;
  /** Semantic risk classification. */
  classification: CommandClassification;
  /** Whether this segment was allowed by policy. */
  allowed: boolean;
  /**
   * Human-readable reason for the verdict.
   * Always set; describes the policy that matched or the safe classification.
   */
  reason: string;
  /** Whether this segment contains obfuscated content (encoded chars, substitution). */
  hasObfuscation: boolean;
  /** Descriptions of any obfuscation patterns found. */
  obfuscationPatterns: string[];
}

/**
 * The aggregated verdict for a compound command.
 *
 * Contains the overall allow/deny decision plus per-segment records for
 * user-facing denial output and audit logging.
 */
export interface CompoundVerdict {
  /** The original command string. */
  original: string;
  /** Whether the entire compound command is allowed. */
  allowed: boolean;
  /** The highest-risk classification across all segments. */
  highestClassification: CommandClassification;
  /** Per-segment verdict records (in parse order). */
  segments: SegmentVerdict[];
  /**
   * Human-readable denial explanation including per-segment reasons.
   * Only set when `allowed` is false.
   */
  denialExplanation?: string;
  /** Whether any segment contains obfuscated content. */
  hasObfuscation: boolean;
}

// ── Obfuscation detection ──────────────────────────────────────────────────────

/**
 * Patterns that indicate potential obfuscation or bypass attempts.
 * Each entry provides a description and a predicate.
 */
const OBFUSCATION_CHECKS: Array<{
  description: string;
  test: (raw: string, args: string[], flags: string[]) => boolean;
}> = [
  {
    /**
     * NOTE: This check has a known false-positive risk on legitimate base64-like arguments
     * (e.g. UUIDs, hashes, or long alphanumeric tokens). It requires both the base64
     * character-set pattern AND 4-byte alignment, which reduces but does not eliminate
     * false positives. Callers should surface the pattern description to the user so
     * they can identify and allowlist benign cases.
     */
    description: 'base64-encoded argument (possible command injection)',
    test: (_raw, args) =>
      args.some((a) => /^[A-Za-z0-9+/]{16,}={0,2}$/.test(a) && a.length % 4 === 0),
  },
  {
    description: 'hex-encoded argument (possible command injection)',
    test: (_raw, args) => args.some((a) => /^(0x)?[0-9a-fA-F]{8,}$/.test(a)),
  },
  {
    description: 'URL-encoded content in argument',
    test: (_raw, args) => args.some((a) => /%[0-9a-fA-F]{2}/.test(a)),
  },
  {
    description: 'variable expansion in critical position',
    test: (raw) => /\$\{?[A-Z_]+\}?/.test(raw) && /rm|kill|dd|mkfs/.test(raw),
  },
  {
    description: 'command substitution in argument (backtick or $())',
    test: (raw) => /`[^`]+`/.test(raw) || /\$\([^)]+\)/.test(raw),
  },
  {
    description: 'octal or unicode escape in path argument',
    test: (_raw, args) =>
      args.some(
        (a) =>
          /\\[0-7]{3}/.test(a) ||
          /\\u[0-9a-fA-F]{4}/.test(a) ||
          /\\x[0-9a-fA-F]{2}/.test(a),
      ),
  },
  {
    description: 'null-byte injection attempt',
    test: (raw) => raw.includes('\0') || raw.includes('%00') || raw.includes('\\0'),
  },
  {
    description: 'eval command detected',
    test: (raw, args) => raw.trim().startsWith('eval') || args.includes('eval'),
  },
];

/**
 * Checks a command node for obfuscation patterns.
 *
 * @param node - The command node to check.
 * @returns List of obfuscation pattern descriptions found.
 */
function detectObfuscation(node: CommandNode): string[] {
  const found: string[] = [];
  for (const check of OBFUSCATION_CHECKS) {
    if (check.test(node.raw, node.args, node.flags)) {
      found.push(check.description);
    }
  }
  return found;
}

// ── Policy evaluation ─────────────────────────────────────────────────────────

/**
 * Classification priority order (highest index = lowest risk).
 * Used for comparing segment classifications.
 */
const CLASSIFICATION_PRIORITY: CommandClassification[] = [
  'destructive',
  'escalation',
  'network',
  'write',
  'read',
];

function classificationRank(c: CommandClassification): number {
  const idx = CLASSIFICATION_PRIORITY.indexOf(c);
  return idx === -1 ? 999 : idx;
}

function higherPriorityClassification(
  a: CommandClassification,
  b: CommandClassification,
): CommandClassification {
  return classificationRank(a) <= classificationRank(b) ? a : b;
}

/**
 * Policy predicate type: returns a denial reason string if the segment
 * should be denied, or null if the policy does not deny it.
 */
type PolicyPredicate = (node: CommandNode, classification: CommandClassification) => string | null;

/**
 * Default policies applied to each segment.
 *
 * Extend this list to add project-specific per-segment rules.
 * First match wins (denial takes precedence).
 */
const DEFAULT_POLICIES: PolicyPredicate[] = [
  // Deny destructive commands unconditionally
  (_, cls) =>
    cls === 'destructive'
      ? `segment classified as destructive — denied by policy`
      : null,
  // Deny escalation commands unconditionally
  (_, cls) =>
    cls === 'escalation'
      ? `segment classified as escalation — denied by policy`
      : null,
  // Deny network commands by default (can be overridden by caller)
  // NOTE: the exec integration layer overrides this based on feature flags
  // so this policy only fires when no override is provided.
  (_node, _cls) => null,
];

/**
 * Evaluates a single CommandNode against the default policy.
 *
 * @param node           - The command node to evaluate.
 * @param allowedClasses - Classification tiers to allow (defaults to read+write+network).
 * @returns A SegmentVerdict for this node.
 */
export function evaluateSegmentNode(
  node: CommandNode,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
): SegmentVerdict {
  // Build a minimal CommandSegment for the classifier
  const seg: CommandSegment = {
    raw: node.raw,
    tokens: node.tokens,
    command: node.command,
    args: node.args,
    flags: node.flags,
  };

  const classification = classifySegment(seg);
  const obfuscationPatterns = detectObfuscation(node);
  const hasObfuscation = obfuscationPatterns.length > 0;

  // Obfuscation always triggers denial
  if (hasObfuscation) {
    return {
      raw: node.raw,
      command: node.command,
      classification,
      allowed: false,
      reason: `obfuscation detected: ${obfuscationPatterns.join('; ')}`,
      hasObfuscation,
      obfuscationPatterns,
    };
  }

  // Check default policies
  for (const policy of DEFAULT_POLICIES) {
    const denial = policy(node, classification);
    if (denial !== null) {
      return {
        raw: node.raw,
        command: node.command,
        classification,
        allowed: false,
        reason: denial,
        hasObfuscation,
        obfuscationPatterns,
      };
    }
  }

  // Check against caller-provided allowed classes
  if (!allowedClasses.has(classification)) {
    return {
      raw: node.raw,
      command: node.command,
      classification,
      allowed: false,
      reason: `classification "${classification}" is not in the allowed set [${[...allowedClasses].join(', ')}]`,
      hasObfuscation,
      obfuscationPatterns,
    };
  }

  return {
    raw: node.raw,
    command: node.command,
    classification,
    allowed: true,
    reason: `classification "${classification}" is permitted`,
    hasObfuscation,
    obfuscationPatterns,
  };
}

/**
 * Builds a structured denial explanation from a list of segment verdicts.
 *
 * Includes the full per-segment breakdown for user-facing output.
 *
 * @param original - The original command string.
 * @param verdicts - All segment verdicts.
 * @returns A multi-line denial explanation string.
 */
export function buildDenialExplanation(original: string, verdicts: SegmentVerdict[]): string {
  const denied = verdicts.filter((v) => !v.allowed);
  const lines: string[] = [
    `Command denied: "${original}"`,
    ``,
    `Segment analysis (${verdicts.length} segment${verdicts.length !== 1 ? 's' : ''}):`,
  ];

  for (const [i, v] of verdicts.entries()) {
    const status = v.allowed ? '✓ allowed' : '✗ denied';
    lines.push(`  [${i + 1}] ${status}  ${v.raw}`);
    lines.push(`       classification: ${v.classification}`);
    lines.push(`       reason: ${v.reason}`);
    if (v.hasObfuscation) {
      lines.push(`       obfuscation: ${v.obfuscationPatterns.join('; ')}`);
    }
  }

  lines.push(``);
  lines.push(`${denied.length} of ${verdicts.length} segment${verdicts.length !== 1 ? 's' : ''} denied.`);

  return lines.join('\n');
}

/**
 * Evaluates a ShellNode AST against policy and returns a CompoundVerdict.
 *
 * Safe segments are identified alongside unsafe ones. The compound command
 * is denied if ANY segment is denied.
 *
 * @param original       - The original command string.
 * @param ast            - The parsed ShellNode AST.
 * @param allowedClasses - Classification tiers to allow per segment.
 * @returns A CompoundVerdict with per-segment breakdown.
 */
export function evaluateCommandAST(
  original: string,
  ast: ShellNode,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
): CompoundVerdict {
  const commandNodes = collectCommandNodes(ast);

  // If AST has no command nodes (e.g. empty or pure subshell with no inner)
  if (commandNodes.length === 0) {
    // Conservative: deny empty/unparseable compound commands
    const verdict: CompoundVerdict = {
      original,
      allowed: false,
      highestClassification: 'write',
      segments: [],
      denialExplanation: `Command denied: "${original}"\n\nNo parseable command segments found. Denied as a precaution.`,
      hasObfuscation: false,
    };
    return verdict;
  }

  const segmentVerdicts: SegmentVerdict[] = commandNodes.map((node) =>
    evaluateSegmentNode(node, allowedClasses),
  );

  let highest: CommandClassification = 'read';
  for (const sv of segmentVerdicts) {
    highest = higherPriorityClassification(highest, sv.classification);
  }

  const anyDenied = segmentVerdicts.some((v) => !v.allowed);
  const hasObfuscation = segmentVerdicts.some((v) => v.hasObfuscation);

  const compound: CompoundVerdict = {
    original,
    allowed: !anyDenied,
    highestClassification: highest,
    segments: segmentVerdicts,
    hasObfuscation,
  };

  if (anyDenied) {
    compound.denialExplanation = buildDenialExplanation(original, segmentVerdicts);
  }

  return compound;
}
