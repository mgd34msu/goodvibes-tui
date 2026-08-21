/**
 * formatUserFacingError, classifies provider/network errors into plain-language
 * one-liners with a suggested action.
 *
 * Classification order (most-specific first):
 *   auth           → 401, 'invalid' + 'key'/'token', 'Unauthorized', 'forbidden'
 *   rate-limit     → 429, 'rate limit', 'rate_limit', 'too many requests', 'quota'
 *   context-overflow → 'context length', 'maximum context', 'too many tokens',
 *                     'context window'
 *   network        → ECONNREFUSED, ETIMEDOUT, 'fetch failed', 'socket hang up',
 *                     'network', ENOTFOUND
 *   generic        → summarizeError fallback
 *
 * @module
 */

import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorClass =
  | 'auth'
  | 'rate-limit'
  | 'context-overflow'
  | 'network'
  | 'generic';

export interface UserFacingError {
  /** Short, plain-language description of what went wrong. */
  message: string;
  /** Suggested recovery action (slash-command or brief instruction). */
  action: string;
  /** Which classifier matched. */
  kind: ErrorClass;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Extract a canonical string probe from an unknown error value.
 * Concatenates status code (if present), error name, and message so that a
 * single regex can match across all shapes.
 */
function probeString(err: unknown): string {
  if (err == null) return '';
  const parts: string[] = [];

  if (typeof err === 'object') {
    // HTTP-style status fields
    const asRecord = err as Record<string, unknown>;
    const status = asRecord['status'] ?? asRecord['statusCode'] ?? asRecord['code'];
    if (status != null) parts.push(String(status));

    // name and message
    if ('name' in asRecord && typeof asRecord['name'] === 'string') parts.push(asRecord['name']);
    if ('message' in asRecord && typeof asRecord['message'] === 'string') parts.push(asRecord['message']);

    // cause chain (one level)
    if ('cause' in asRecord && asRecord['cause'] != null) {
      const cause = asRecord['cause'] as Record<string, unknown>;
      if (typeof cause['message'] === 'string') parts.push(cause['message']);
      if (typeof cause['code'] === 'string') parts.push(cause['code']);
    }
  } else if (typeof err === 'string') {
    parts.push(err);
  } else {
    parts.push(String(err));
  }

  return parts.join(' ').toLowerCase();
}

export function classifyError(err: unknown): ErrorClass {
  const probe = probeString(err);

  // Auth: 401 status, key/token invalidity, Unauthorized
  if (
    /\b401\b/.test(probe) ||
    /invalid.{0,10}(api.?key|key|token)/i.test(probe) ||
    /unauthorized/i.test(probe) ||
    /authentication/i.test(probe) ||
    /api.?key.{0,20}(missing|not.?set|required|invalid)/i.test(probe)
  ) {
    return 'auth';
  }

  // Rate-limit: 429 status, quota exceeded
  if (
    /\b429\b/.test(probe) ||
    /rate.?limit/i.test(probe) ||
    /too many requests/i.test(probe) ||
    /quota.{0,20}exceeded/i.test(probe) ||
    /request.{0,20}limit/i.test(probe)
  ) {
    return 'rate-limit';
  }

  // Context overflow: provider context-window exceeded messages
  if (
    /context.{0,10}(length|window|limit)/i.test(probe) ||
    /maximum context/i.test(probe) ||
    /too many tokens/i.test(probe) ||
    /token.{0,10}limit/i.test(probe) ||
    /context.{0,20}exceeded/i.test(probe) ||
    /input.{0,10}too.{0,10}long/i.test(probe)
  ) {
    return 'context-overflow';
  }

  // Network: connection/transport errors
  if (
    /econnrefused/i.test(probe) ||
    /etimedout/i.test(probe) ||
    /enotfound/i.test(probe) ||
    /fetch failed/i.test(probe) ||
    /socket hang up/i.test(probe) ||
    /network.{0,20}(error|failure|timeout)/i.test(probe) ||
    /connection.{0,20}(refused|reset|timeout|closed)/i.test(probe) ||
    /timeout/i.test(probe)
  ) {
    return 'network';
  }

  return 'generic';
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Classifies `err` and returns a plain-language one-liner with a suggested
 * recovery action.
 *
 * Uses `summarizeError` from the SDK as the detail fallback for generic errors
 * so stack traces never leak into the UI.
 */
export function formatUserFacingError(err: unknown): UserFacingError {
  const kind = classifyError(err);

  switch (kind) {
    case 'auth':
      return {
        kind,
        message: 'Authentication failed: the provider rejected your API key.',
        action: 'Run /login to re-authenticate or check your API key.',
      };

    case 'rate-limit':
      return {
        kind,
        message: 'Rate limit reached: the provider is throttling requests.',
        action: 'Wait a moment and retry, or switch models with /model.',
      };

    case 'context-overflow':
      return {
        kind,
        message: 'Context window exceeded: the conversation is too long for this model.',
        action: 'Run /compact to summarise the conversation and free context.',
      };

    case 'network':
      return {
        kind,
        message: 'Network error: could not reach the provider.',
        action: 'Check your connection and retry, or switch models with /model.',
      };

    default: {
      const detail = summarizeError(err);
      return {
        kind: 'generic',
        message: `Provider error: ${detail}`,
        action: 'Retry your last message, or switch models with /model.',
      };
    }
  }
}

/**
 * Convenience helper: returns the full formatted string for use in a single
 * system message. Formats as "<message> <action>"
 */
export function formatUserFacingErrorLine(err: unknown): string {
  const { message, action } = formatUserFacingError(err);
  return `${message} ${action}`;
}
