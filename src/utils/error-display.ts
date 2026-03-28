import type { ProviderError } from '../types/errors.ts';

/** Human-readable messages for HTTP status codes. */
const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request — check model name and parameters',
  401: 'Authentication failed — check your API key',
  402: 'Credits depleted — purchase more or switch provider',
  403: 'Access denied — your plan may not include this model',
  404: 'Model not found — it may have been removed or renamed',
  429: 'Rate limited — request will retry automatically',
  500: 'Server error — the provider is having issues',
  502: 'Gateway error — try again in a moment',
  503: 'Service unavailable — the provider is temporarily down',
};

const MAX_ERROR_LENGTH = 200;

/**
 * stripJson - Remove raw JSON objects/arrays from an error message string.
 * Keeps human-readable text while stripping machine noise.
 */
function stripJson(msg: string): string {
  return msg
    .replace(/\{[^{}]{0,500}\}/g, '')
    .replace(/\[[^\[\]]{0,500}\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * truncateMessage - Truncate long error messages to MAX_ERROR_LENGTH characters.
 */
function truncateMessage(msg: string): string {
  if (msg.length <= MAX_ERROR_LENGTH) return msg;
  return msg.slice(0, MAX_ERROR_LENGTH) + '\u2026';
}

/**
 * formatProviderError - Format a ProviderError with structured guidance and retry info.
 * Returns a human-readable string suitable for display in the TUI.
 */
export function formatProviderError(error: ProviderError): string {
  // Prefer status-code-based message over raw error text
  const statusMessage =
    error.statusCode !== undefined ? STATUS_MESSAGES[error.statusCode] : undefined;

  let msg: string;
  if (statusMessage) {
    msg = statusMessage;
  } else {
    // Strip raw JSON and truncate the original message
    const stripped = stripJson(error.message);
    msg = truncateMessage(stripped || error.message);
  }

  // Append provider guidance (e.g. rate limit or auth hint from ProviderError constructor)
  if (error.guidance) {
    msg += `\n  Hint: ${error.guidance}`;
  }

  // Append cooldown info for rate limit errors
  if (error.retryAfterMs) {
    msg += `\n  Retry in ${Math.ceil(error.retryAfterMs / 1000)}s`;
  }

  return msg;
}
