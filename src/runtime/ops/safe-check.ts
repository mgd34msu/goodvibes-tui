/**
 * Shared diagnostic check safety wrapper.
 *
 * Runs a diagnostic check function and catches any unexpected errors,
 * returning a structured failure result instead of throwing.
 */
import type { DiagnosticCheckResult } from './types.ts';

/** @internal Run a check safely — never throws. */
export async function safeCheck(
  fn: () => Promise<DiagnosticCheckResult>,
): Promise<DiagnosticCheckResult> {
  try {
    return await fn();
  } catch (err) {
    return {
      passed: false,
      summary: `Check threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      severity: 'error',
    };
  }
}
