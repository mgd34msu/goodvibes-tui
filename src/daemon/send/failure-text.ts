/**
 * failure-text.ts — what the operator is told when a send does not happen.
 *
 * ## Why this is not `summarizeError`
 *
 * The SDK's `summarizeError` is the right tool nearly everywhere: it classifies
 * an error, adds a hint, and deliberately drops detail so a transcript stays
 * readable. That is the wrong trade here, and measurably so. Given the real
 * Telegram failure
 *
 *     Telegram delivery failed HTTP 401: {"ok":false,"description":"Unauthorized"}
 *
 * it returns `Telegram delivery failed HTTP 401` — its `stripJson` pass removes
 * the `{...}`, which is exactly the part naming what went wrong. Given
 * `connect ECONNREFUSED 149.154.167.220:443` it returns "Cannot connect to the
 * provider. Check whether the service is reachable." — advice in place of the
 * address that was refused.
 *
 * A person debugging a message that did not arrive needs the provider's own
 * words: "Unauthorized", "chat not found", and "Bad Request: message is too
 * long" have three different fixes, and all three flatten to the same summary.
 *
 * ## What is removed, and why that is not the same thing
 *
 * Detail is kept; CREDENTIALS are not. This matters more here than in most
 * places because Telegram puts the bot token in the URL PATH
 * (`api.telegram.org/bot<token>/sendMessage`), so a transport error that echoes
 * the request URL would print the owner's bot token to a terminal and into
 * whatever log or pasted report that terminal output ends up in.
 *
 * `redactSensitiveData` from the SDK covers the shapes it knows (bearer tokens,
 * `sk-`/`xoxb-`/`ghp_` keys, home directories). It has NO pattern for a
 * URL-embedded credential, so the two passes below add them. They run BEFORE
 * the SDK pass, because a redacted string must not then be re-scanned in a way
 * that could reveal structure.
 */

import { redactSensitiveData } from '@pellux/goodvibes-sdk/platform/utils';

/**
 * A generous cap. The point of this text is diagnosis, so it is far larger than
 * the 240 characters `summarizeError` allows — but an HTML error page or a
 * multi-megabyte body still must not flood the terminal.
 */
const MAX_FAILURE_TEXT = 2_000;

const URL_CREDENTIAL_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  // Telegram: the bot token IS the path segment.
  { pattern: /\/bot\d{5,}:[A-Za-z0-9_-]{10,}/g, replacement: '/bot[REDACTED_BOT_TOKEN]' },
  // Any URL carrying `user:password@host` — BlueBubbles, Mattermost and Matrix
  // base URLs are all operator-supplied and can be written this way.
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replacement: '$1[REDACTED_CREDENTIALS]@' },
  // A credential passed as a query parameter — BlueBubbles sends `?password=`.
  {
    pattern: /([?&](?:password|token|secret|access_token|api_?key|auth)=)[^&\s"']+/gi,
    replacement: '$1[REDACTED]',
  },
];

/** Strip credentials this command can put on the wire but the SDK pass does not know. */
export function redactUrlCredentials(text: string): string {
  let result = text;
  for (const { pattern, replacement } of URL_CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * The provider's own failure text, with credentials removed and nothing else
 * rewritten.
 *
 * Never returns an empty string: an error whose message is blank still has to
 * produce something an operator can act on, because the alternative is an exit
 * code with no explanation beside it.
 */
export function describeSendFailure(error: unknown): string {
  const raw = error instanceof Error
    ? (error.message.trim().length > 0 ? error.message : error.name)
    : typeof error === 'string'
      ? error
      : (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
  const message = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'the provider failed without saying why';
  // `cause` is where Node and Bun put the real reason for `fetch failed`, and
  // dropping it is how a genuinely diagnosable DNS or TLS failure becomes two
  // useless words.
  const cause = error instanceof Error && error.cause instanceof Error && error.cause.message.trim().length > 0
    ? ` (${error.cause.message.trim()})`
    : '';
  const full = `${message}${cause}`;
  const redacted = redactSensitiveData(redactUrlCredentials(full));
  return redacted.length <= MAX_FAILURE_TEXT ? redacted : `${redacted.slice(0, MAX_FAILURE_TEXT)}…`;
}
