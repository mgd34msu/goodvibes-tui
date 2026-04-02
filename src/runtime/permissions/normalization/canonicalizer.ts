/**
 * Canonicalizer — resolves raw command tokens to their canonical command names.
 *
 * Strips:
 *  - Absolute and relative path prefixes (e.g. /usr/bin/rm → rm)
 *  - Environment variable assignments that prefix the command
 *    (e.g. FOO=bar git → git)
 *  - Quoted wrappers around the command name
 *
 * Returns the lowercase bare command name, or an empty string if the
 * input cannot be resolved.
 */

/** Pattern for an environment variable assignment (KEY=value). */
const ENV_VAR_PREFIX = /^[A-Z_][A-Z0-9_]*=/i;

/**
 * Strips shell quoting (single or double) from a string.
 *
 * @param value - The raw token value, potentially quoted.
 * @returns The unquoted string value.
 */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Resolves a raw command token to its canonical bare command name.
 *
 * Processing order:
 *  1. Strip quotes.
 *  2. Strip leading environment variable assignments.
 *  3. Extract the basename (strip directory path).
 *  4. Lowercase the result.
 *
 * @param raw - The raw command token value.
 * @returns The canonical command name (e.g. "rm", "git", "npm").
 */
export function canonicalize(raw: string): string {
  if (!raw) return '';

  let value = stripQuotes(raw);

  // Strip env var prefixes (e.g. "FOO=bar command" — take the last space-separated part)
  const parts = value.split(/\s+/);
  // Walk forward past any KEY=value segments
  let commandPart = parts[0] ?? '';
  for (const part of parts) {
    if (!ENV_VAR_PREFIX.test(part)) {
      commandPart = part;
      break;
    }
  }

  // Extract basename from path (e.g. /usr/bin/git → git, ./scripts/deploy.sh → deploy.sh)
  const lastSlash = commandPart.lastIndexOf('/');
  if (lastSlash !== -1) {
    commandPart = commandPart.slice(lastSlash + 1);
  }

  return commandPart.toLowerCase();
}
