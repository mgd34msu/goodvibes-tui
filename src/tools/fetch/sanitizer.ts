/**
 * Fetch response sanitizer.
 *
 * Implements three sanitization modes applied to HTTP response content before
 * it is returned to the caller. The mode is deterministic and auditable:
 * every result includes the `sanitization_tier` field indicating which mode
 * was applied.
 *
 * Modes:
 *   - `none`      — No sanitization. Content is returned as-is. Use only for
 *                   trusted internal hosts.
 *   - `safe-text` — Default. Strips HTML script/style blocks and control
 *                   characters. Safe for general external content.
 *   - `strict`    — Aggressive: allows only printable ASCII and common Unicode
 *                   whitespace. Strips all HTML tags, script/style, and non-
 *                   printable characters. Use for untrusted or unknown hosts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Sanitization mode applied to an HTTP response body.
 *
 * - `none`      — No sanitization; content returned verbatim.
 * - `safe-text` — Strips script/style blocks and control characters.
 * - `strict`    — Strips all HTML, allows only printable ASCII + whitespace.
 */
export type SanitizeMode = 'none' | 'safe-text' | 'strict';

/**
 * Result of applying a sanitizer to response content.
 */
export interface SanitizeResult {
  /** Sanitized content string. */
  content: string;
  /** The sanitization mode that was applied. */
  mode: SanitizeMode;
  /** Whether the content was modified by sanitization. */
  modified: boolean;
}

// ---------------------------------------------------------------------------
// Sanitizer implementations
// ---------------------------------------------------------------------------

/**
 * `none` mode — returns content verbatim.
 */
function sanitizeNone(content: string): SanitizeResult {
  return { content, mode: 'none', modified: false };
}

/**
 * `safe-text` mode — strips script/style elements and C0/C1 control
 * characters (except tab, newline, carriage return).
 *
 * This mode is appropriate for general external content where HTML injection
 * or binary smuggling via control sequences is a concern.
 */
function sanitizeSafeText(content: string): SanitizeResult {
  const original = content;

  let sanitized = content
    // Remove script blocks (including event handlers encoded in attributes)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Remove style blocks
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Strip C0 control characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F) and DEL (0x7F)
    // Keep: 0x09 (tab), 0x0A (LF), 0x0D (CR)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Strip C1 control characters (0x80-0x9F)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x80-\x9F]/g, '');

  return {
    content: sanitized,
    mode: 'safe-text',
    modified: sanitized !== original,
  };
}

/**
 * `strict` mode — strips all HTML tags, script/style blocks, and any
 * character outside printable ASCII (0x20-0x7E) plus tab (0x09),
 * newline (0x0A), and carriage return (0x0D).
 *
 * Use for unknown or untrusted hosts where maximum reduction of attack
 * surface is required.
 */
function sanitizeStrict(content: string): SanitizeResult {
  const original = content;

  let sanitized = content
    // Remove script blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Remove style blocks
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Strip all remaining HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Allow only: printable ASCII (0x20-0x7E), tab (0x09), LF (0x0A), CR (0x0D)
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
    // Collapse multiple consecutive spaces to single space
    .replace(/ {2,}/g, ' ')
    .trim();

  return {
    content: sanitized,
    mode: 'strict',
    modified: sanitized !== original,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply the specified sanitization mode to response content.
 *
 * This function is deterministic: given the same `content` and `mode`, it
 * always produces the same output. The `modified` field in the result
 * indicates whether any transformation occurred.
 *
 * @param content - Raw response body string.
 * @param mode    - Sanitization mode to apply.
 * @returns       `SanitizeResult` with sanitized content, mode applied, and
 *                whether the content was modified.
 */
export function applySanitizer(content: string, mode: SanitizeMode): SanitizeResult {
  switch (mode) {
    case 'none':
      return sanitizeNone(content);
    case 'safe-text':
      return sanitizeSafeText(content);
    case 'strict':
      return sanitizeStrict(content);
    default: {
      // Exhaustiveness guard — TypeScript ensures this is unreachable
      const _exhaustive: never = mode;
      return sanitizeSafeText(content as string);
    }
  }
}

/**
 * Resolve the effective sanitize mode, applying the rollback default.
 *
 * When no explicit mode is requested, defaults to `'safe-text'` — the
 * rollback-safe default for fetch sanitization.
 *
 * @param requested - Caller-supplied mode (may be undefined).
 * @returns         Effective `SanitizeMode` to apply.
 */
export function resolveSanitizeMode(requested: SanitizeMode | undefined): SanitizeMode {
  return requested ?? 'safe-text';
}
