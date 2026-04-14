import type { ToolDefinition } from '../types/tools.ts';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

/** Result of a tool call repair attempt. */
export interface RepairResult {
  repaired: boolean;
  original: Record<string, unknown>;
  fixed: Record<string, unknown>;
  /** Human-readable list of what was fixed. */
  repairs: string[];
}

/**
 * Attempt to repair a malformed tool call by inferring missing/wrong params.
 *
 * Returns repaired arguments and a log of what was fixed.
 * If no repairs are needed (or repair is impossible), returns the original unchanged
 * with repaired=false.
 *
 * Design: never throws — always returns a result. Premium models that send
 * correct calls pass through unchanged (zero overhead).
 */
export function repairToolCall(
  toolName: string,
  args: Record<string, unknown>,
  schema: ToolDefinition,
): RepairResult {
  const fixed: Record<string, unknown> = structuredClone(args);
  const repairs: string[] = [];

  try {
    const params = schema.parameters as Record<string, unknown> | undefined;
    const properties = (params?.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (params?.required ?? []) as string[];

    // --- Rule 1: Missing `mode` on agent tool ---
    if (toolName === 'agent' && fixed['mode'] === undefined) {
      const inferred = _inferAgentMode(fixed);
      if (inferred !== null) {
        fixed['mode'] = inferred;
        repairs.push(`inferred missing mode='${inferred}' for agent tool`);
      }
    }

    // --- Rule 3 & 4 & 5: Per-property coercions ---
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in fixed)) {
        // Property missing — handle in Rule 2 below
        continue;
      }

      const value = fixed[key];
      const expectedType = propSchema['type'] as string | undefined;
      const enumValues = propSchema['enum'] as unknown[] | undefined;

      // Rule 3: String → number coercion
      if (expectedType === 'number' && typeof value === 'string') {
        const coerced = Number(value);
        if (value.trim().length > 0 && !Number.isNaN(coerced)) {
          fixed[key] = coerced;
          repairs.push(`coerced ${key} from string '${value}' to number ${coerced}`);
        }
        continue;
      }

      // Rule 4: Boolean coercion
      if (expectedType === 'boolean' && typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true' || lower === 'yes') {
          fixed[key] = true;
          repairs.push(`coerced ${key} from '${value}' to boolean true`);
          continue;
        }
        if (lower === 'false' || lower === 'no') {
          fixed[key] = false;
          repairs.push(`coerced ${key} from '${value}' to boolean false`);
          continue;
        }
      }

      // Rule 5: Enum normalization (case-insensitive match)
      if (enumValues && typeof value === 'string') {
        const exactMatch = enumValues.includes(value);
        if (!exactMatch) {
          const lower = value.toLowerCase();
          const normalized = enumValues.find(
            (e) => typeof e === 'string' && e.toLowerCase() === lower,
          );
          if (normalized !== undefined) {
            fixed[key] = normalized;
            repairs.push(`normalized ${key} from '${value}' to enum value '${normalized}'`);
          }
        }
      }
    }

    // --- Rule 2: Missing required string params — attempt to fill from present params ---
    for (const requiredKey of required) {
      if (requiredKey in fixed) {
        continue; // already present
      }

      const targetSchema = properties[requiredKey];
      if (!targetSchema) continue;

      const targetType = targetSchema['type'] as string | undefined;
      if (targetType !== 'string') {
        continue; // only attempt string params
      }

      // Look for a non-required param with the same value type whose value could fill it
      const candidate = _findStringCandidate(requiredKey, fixed, properties, required);
      if (candidate !== null) {
        fixed[requiredKey] = candidate.value;
        delete fixed[candidate.sourceKey];
        repairs.push(
          `filled missing required param '${requiredKey}' from non-required param '${candidate.sourceKey}'`,
        );
      }
    }
  } catch (err) {
    // Never let repair logic crash the caller
    logger.debug('repairToolCall: unexpected error (non-fatal)', {
      toolName,
      error: summarizeError(err),
    });
    return { repaired: false, original: args, fixed: args, repairs: [] };
  }

  const repaired = repairs.length > 0;

  if (repaired) {
    logger.debug('repairToolCall: repaired malformed tool call', {
      toolName,
      repairs,
    });
  }

  return { repaired, original: args, fixed, repairs };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Rule 1: Infer the `mode` value for the agent tool from the supplied args.
 */
function _inferAgentMode(args: Record<string, unknown>): string | null {
  const hasTask = typeof args['task'] === 'string' && args['task'].length > 0;
  const hasTemplate = typeof args['template'] === 'string';
  const hasAgentId = typeof args['agentId'] === 'string' && args['agentId'].length > 0;
  const isEmpty =
    Object.keys(args).length === 0 ||
    Object.values(args).every((v) => v === undefined || v === null || v === '');

  if (isEmpty) {
    return 'list';
  }
  if (hasTask || hasTemplate) {
    return 'spawn';
  }
  if (hasAgentId) {
    return 'status';
  }

  return null;
}

/**
 * Rule 2: Find a non-required string-typed param present in `args` whose
 * value could serve as the value for the missing `targetKey`.
 *
 * Prefers params whose name is semantically related to the target.
 */
function _findStringCandidate(
  targetKey: string,
  args: Record<string, unknown>,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): { sourceKey: string; value: string } | null {
  const nonRequiredStringArgs = Object.entries(args).filter(([key, value]) => {
    if (required.includes(key)) return false; // skip required params
    if (typeof value !== 'string' || value.length === 0) return false;
    const propType = properties[key]?.['type'];
    // Accept if property schema says 'string' or schema doesn't define the key
    return propType === 'string' || propType === undefined;
  }) as [string, string][];

  if (nonRequiredStringArgs.length === 0) return null;

  // Prefer a candidate whose key name overlaps with the target key
  const targetLower = targetKey.toLowerCase();
  const preferred = nonRequiredStringArgs.find(
    ([key]) =>
      key.toLowerCase().includes(targetLower) || targetLower.includes(key.toLowerCase()),
  );

  if (preferred) {
    return { sourceKey: preferred[0], value: preferred[1] };
  }

  // No name match found — do not guess; let the call fail normally
  return null;
}
