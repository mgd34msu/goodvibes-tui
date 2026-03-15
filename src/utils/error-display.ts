import type { ProviderError } from '../types/errors.ts';

/**
 * formatProviderError - Format a ProviderError with structured guidance and retry info.
 * Returns a human-readable string suitable for display in the TUI.
 */
export function formatProviderError(error: ProviderError): string {
  let msg = error.message;
  if (error.guidance) {
    msg += `\n  Hint: ${error.guidance}`;
  }
  if (error.retryAfterMs) {
    msg += `\n  Retry in ${Math.ceil(error.retryAfterMs / 1000)}s`;
  }
  return msg;
}
