/**
 * ForensicsClassifier — auto-classifies failures from event context.
 *
 * Maps combinations of stop reasons, error messages, event sequences,
 * and cascade presence to a FailureClass without requiring manual log
 * spelunking. Classification is heuristic and best-effort.
 */
import type { FailureClass } from './types.ts';

/** Inputs available to the classifier at report generation time. */
interface ClassifierInput {
  /** Stop reason from the LLM provider (if any). */
  readonly stopReason?: string;
  /** Error message from the terminal event. */
  readonly errorMessage?: string;
  /** Whether this entity was explicitly cancelled by the operator. */
  readonly wasCancelled?: boolean;
  /** Whether any cascade events were present in the causal context. */
  readonly hasCascadeEvents?: boolean;
  /** Whether any tool calls failed in this turn/task. */
  readonly hasToolFailure?: boolean;
  /** Whether any permission check was denied. */
  readonly hasPermissionDenial?: boolean;
  /** Whether a compaction error was recorded. */
  readonly hasCompactionError?: boolean;
}

/**
 * Classify a failure based on available event context.
 * Rules are evaluated in priority order — first match wins.
 *
 * @returns The classified FailureClass.
 */
export function classifyFailure(input: ClassifierInput): FailureClass {
  // Explicit cancellation takes precedence
  if (input.wasCancelled) {
    return 'cancelled';
  }

  // LLM stop reason: max_tokens
  if (
    input.stopReason === 'max_tokens'
    || input.stopReason === 'length'
    || input.stopReason === 'context_overflow'
  ) {
    return 'max_tokens';
  }

  // Compaction failure
  if (input.hasCompactionError) {
    return 'compaction_error';
  }

  // Permission denial
  if (input.hasPermissionDenial || input.stopReason === 'hook_denied') {
    return 'permission_denied';
  }

  // Tool failure
  if (input.hasToolFailure || input.stopReason === 'tool_loop_circuit_breaker') {
    return 'tool_failure';
  }

  // Cascade-induced failure
  if (input.hasCascadeEvents) {
    return 'cascade_failure';
  }

  // LLM error patterns from error message
  if (input.errorMessage) {
    const msg = input.errorMessage.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return 'turn_timeout';
    }
    if (
      msg.includes('api error') ||
      msg.includes('overloaded') ||
      msg.includes('rate limit') ||
      msg.includes('quota') ||
      msg.includes('503') ||
      msg.includes('500') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('fetch failed')
    ) {
      return 'llm_error';
    }
  }

  // LLM stop reason hinting at an error
  if (
    input.stopReason === 'provider_exhausted' ||
    input.stopReason === 'provider_error' ||
    input.stopReason === 'error' ||
    input.stopReason === 'stop_sequence' ||
    input.stopReason === 'content_filter'
  ) {
    return 'llm_error';
  }

  return 'unknown';
}

/**
 * Human-readable summary string for a classified failure.
 * Used as the FailureReport.summary.
 */
export function summariseFailure(
  classification: FailureClass,
  errorMessage?: string,
  stopReason?: string,
): string {
  switch (classification) {
    case 'llm_error':
      return errorMessage
        ? `LLM API error: ${errorMessage.slice(0, 120)}`
        : 'LLM API call failed';
    case 'tool_failure':
      return errorMessage
        ? `Tool execution failed: ${errorMessage.slice(0, 120)}`
        : 'Tool execution failed';
    case 'permission_denied':
      return 'Tool call denied by permission policy';
    case 'cascade_failure':
      return 'Failure propagated via health cascade';
    case 'turn_timeout':
      return 'Turn exceeded configured timeout';
    case 'cancelled':
      return 'Entity was explicitly cancelled';
    case 'max_tokens':
      return stopReason === 'length'
        ? 'Response truncated at max_tokens (length stop)'
        : 'Model stopped due to token limit (max_tokens)';
    case 'compaction_error':
      return 'Context compaction failed';
    case 'unknown':
      return errorMessage
        ? `Failure (unclassified): ${errorMessage.slice(0, 120)}`
        : 'Failure (unclassified — inspect causal chain)';
  }
}
