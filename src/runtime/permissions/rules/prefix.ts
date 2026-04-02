/**
 * Permissions v2 — Prefix matching policy rule evaluator.
 *
 * PrefixRule matches tool calls by tool name and optionally the command prefix
 * of the first string argument. Independently testable — no external dependencies.
 */

import type {
  PrefixRule,
  EvaluationStep,
} from '../types.ts';

/** Result returned by evaluatePrefixRule. */
export interface PrefixRuleResult {
  matched: boolean;
  step: EvaluationStep;
}

/**
 * toolMatchesPrefixPattern — Returns true if `toolName` is matched by the rule's
 * `toolPattern` field (which may be a single string, `'*'`, or an array).
 */
function toolMatchesPrefixPattern(
  toolName: string,
  toolPattern: string | string[],
): boolean {
  if (Array.isArray(toolPattern)) {
    return toolPattern.some((p) => p === '*' || p === toolName);
  }
  return toolPattern === '*' || toolPattern === toolName;
}

/**
 * extractCommandArg — Extracts the primary command string from args.
 * Checks `command`, `cmd`, then the first string value.
 */
function extractCommandArg(args: Record<string, unknown>): string | null {
  if (typeof args['command'] === 'string') return args['command'];
  if (typeof args['cmd'] === 'string') return args['cmd'];
  for (const v of Object.values(args)) {
    if (typeof v === 'string') return v;
  }
  return null;
}

/**
 * evaluatePrefixRule — Evaluates a single PrefixRule against a tool call.
 *
 * Returns `matched: true` only when:
 *   1. The tool name matches the rule's `toolPattern`, AND
 *   2. Either no `commandPrefixes` are specified, OR the primary command arg
 *      starts with at least one of the specified prefixes (case-insensitive).
 *
 * @param rule     — The PrefixRule to evaluate.
 * @param toolName — Name of the tool being called.
 * @param args     — Arguments passed to the tool.
 */
export function evaluatePrefixRule(
  rule: PrefixRule,
  toolName: string,
  args: Record<string, unknown>,
): PrefixRuleResult {
  const toolMatches = toolMatchesPrefixPattern(toolName, rule.toolPattern);

  if (!toolMatches) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: false,
        detail: `tool "${toolName}" does not match pattern "${rule.toolPattern}"`,
      },
    };
  }

  // No prefix constraint — tool name match alone is sufficient
  if (!rule.commandPrefixes || rule.commandPrefixes.length === 0) {
    return {
      matched: true,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: true,
        detail: `tool "${toolName}" matched (no prefix constraint)`,
      },
    };
  }

  const commandArg = extractCommandArg(args);
  if (commandArg === null) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: false,
        detail: 'no string argument found to match prefix against',
      },
    };
  }

  const normalized = commandArg.trim().toLowerCase();
  const matchedPrefix = rule.commandPrefixes.find((prefix) =>
    normalized.startsWith(prefix.toLowerCase()),
  );

  if (matchedPrefix !== undefined) {
    return {
      matched: true,
      step: {
        layer: 'policy',
        check: `prefix-rule:${rule.id}`,
        matched: true,
        detail: `command starts with prefix "${matchedPrefix}"`,
      },
    };
  }

  return {
    matched: false,
    step: {
      layer: 'policy',
      check: `prefix-rule:${rule.id}`,
      matched: false,
      detail: `command does not start with any of [${rule.commandPrefixes.join(', ')}]`,
    },
  };
}
