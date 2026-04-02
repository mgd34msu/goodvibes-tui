/**
 * Permissions v2 — Mode-based constraint policy rule evaluator.
 *
 * ModeConstraintRule activates only when a specific PermissionMode is active.
 * Primarily used by the mode evaluation layer (Layer 2) to enforce mode-level
 * restrictions, but can also be used in user/managed policy rules.
 * Independently testable.
 */

import type {
  ModeConstraintRule,
  PermissionMode,
  CommandClassification,
  EvaluationStep,
} from '../types.ts';

/** Result returned by evaluateModeConstraintRule. */
export interface ModeConstraintRuleResult {
  matched: boolean;
  step: EvaluationStep;
}

/**
 * toolMatchesModePattern — Returns true if `toolName` matches the rule's toolPattern.
 */
function toolMatchesModePattern(
  toolName: string,
  toolPattern: string | string[],
): boolean {
  if (Array.isArray(toolPattern)) {
    return toolPattern.some((p) => p === '*' || p === toolName);
  }
  return toolPattern === '*' || toolPattern === toolName;
}

/**
 * evaluateModeConstraintRule — Evaluates a single ModeConstraintRule.
 *
 * Returns `matched: true` when:
 *   1. The active mode is listed in `rule.activeModes`, AND
 *   2. The tool name matches `rule.toolPattern`, AND
 *   3. If `rule.classifications` is set, the tool classification is in that list.
 *
 * @param rule           — The ModeConstraintRule to evaluate.
 * @param toolName       — Name of the tool being called.
 * @param activeMode     — The currently active PermissionMode.
 * @param classification — The semantic classification of the tool call (may be undefined).
 */
export function evaluateModeConstraintRule(
  rule: ModeConstraintRule,
  toolName: string,
  activeMode: PermissionMode,
  classification: CommandClassification | undefined,
): ModeConstraintRuleResult {
  // Check mode match
  if (!rule.activeModes.includes(activeMode)) {
    return {
      matched: false,
      step: {
        layer: 'mode',
        check: `mode-constraint-rule:${rule.id}`,
        matched: false,
        detail: `mode "${activeMode}" not in activeModes [${rule.activeModes.join(', ')}]`,
      },
    };
  }

  // Check tool name match
  const toolMatches = toolMatchesModePattern(toolName, rule.toolPattern);
  if (!toolMatches) {
    return {
      matched: false,
      step: {
        layer: 'mode',
        check: `mode-constraint-rule:${rule.id}`,
        matched: false,
        detail: `tool "${toolName}" does not match pattern "${rule.toolPattern}"`,
      },
    };
  }

  // Check classification constraint (optional)
  if (rule.classifications !== undefined && rule.classifications.length > 0) {
    if (classification === undefined || !rule.classifications.includes(classification)) {
      return {
        matched: false,
        step: {
          layer: 'mode',
          check: `mode-constraint-rule:${rule.id}`,
          matched: false,
          detail: `classification "${classification ?? 'unknown'}" not in [${rule.classifications.join(', ')}]`,
        },
      };
    }
  }

  return {
    matched: true,
    step: {
      layer: 'mode',
      check: `mode-constraint-rule:${rule.id}`,
      matched: true,
      detail: `mode "${activeMode}" + tool "${toolName}" matched rule`,
    },
  };
}
