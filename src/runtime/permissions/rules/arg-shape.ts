/**
 * Argument shape/content policy rule evaluator.
 *
 * ArgShapeRule matches tool calls by testing that all specified key/value pairs
 * are present in the tool's arguments. Values may be literal matches or regex
 * patterns (strings prefixed with `/`). Independently testable.
 */

import type {
  ArgShapeRule,
  EvaluationStep,
} from '../types.ts';

/** Result returned by evaluateArgShapeRule. */
export interface ArgShapeRuleResult {
  matched: boolean;
  step: EvaluationStep;
}

/**
 * toolMatchesArgPattern — Returns true if `toolName` is matched by the rule's
 * `toolPattern` field (which may be a single string, `'*'`, or an array).
 */
function toolMatchesArgPattern(
  toolName: string,
  toolPattern: string | string[],
): boolean {
  if (Array.isArray(toolPattern)) {
    return toolPattern.some((p) => p === '*' || p === toolName);
  }
  return toolPattern === '*' || toolPattern === toolName;
}

/**
 * matchArgValue — Tests a single argument value against an expected matcher.
 *
 * - If `expected` is a string starting with `/`, it is treated as a regex
 *   pattern (the trailing `/` and flags are parsed out if present).
 * - Otherwise, strict equality is used.
 *
 * @param actual   — The actual argument value.
 * @param expected — The expected matcher value from the rule.
 */
function matchArgValue(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'string' && expected.startsWith('/')) {
    // Regex pattern: /pattern/ or /pattern/flags
    const lastSlash = expected.lastIndexOf('/');
    const flags = lastSlash > 0 ? expected.slice(lastSlash + 1) : '';
    const source = expected.slice(1, lastSlash > 0 ? lastSlash : undefined);
    try {
      const re = new RegExp(source, flags);
      return re.test(String(actual));
    } catch {
      // Invalid regex — treat as literal string match
      return actual === expected;
    }
  }
  return actual === expected;
}

/**
 * evaluateArgShapeRule — Evaluates a single ArgShapeRule against a tool call.
 *
 * Returns `matched: true` only when:
 *   1. The tool name matches the rule's `toolPattern`, AND
 *   2. ALL key/value matchers in `argMatchers` match the corresponding arg values.
 *
 * @param rule     — The ArgShapeRule to evaluate.
 * @param toolName — Name of the tool being called.
 * @param args     — Arguments passed to the tool.
 */
export function evaluateArgShapeRule(
  rule: ArgShapeRule,
  toolName: string,
  args: Record<string, unknown>,
): ArgShapeRuleResult {
  const toolMatches = toolMatchesArgPattern(toolName, rule.toolPattern);

  if (!toolMatches) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `arg-shape-rule:${rule.id}`,
        matched: false,
        detail: `tool "${toolName}" does not match pattern "${rule.toolPattern}"`,
      },
    };
  }

  const matchers = Object.entries(rule.argMatchers);
  if (matchers.length === 0) {
    // Empty matchers — matches any args for the tool
    return {
      matched: true,
      step: {
        layer: 'policy',
        check: `arg-shape-rule:${rule.id}`,
        matched: true,
        detail: 'tool matched with empty arg matchers (wildcard)',
      },
    };
  }

  const failedMatchers: string[] = [];
  for (const [key, expected] of matchers) {
    const actual = args[key];
    if (!matchArgValue(actual, expected)) {
      failedMatchers.push(key);
    }
  }

  if (failedMatchers.length === 0) {
    return {
      matched: true,
      step: {
        layer: 'policy',
        check: `arg-shape-rule:${rule.id}`,
        matched: true,
        detail: `all ${matchers.length} arg matcher(s) satisfied`,
      },
    };
  }

  return {
    matched: false,
    step: {
      layer: 'policy',
      check: `arg-shape-rule:${rule.id}`,
      matched: false,
      detail: `arg matchers failed for keys: [${failedMatchers.join(', ')}]`,
    },
  };
}
