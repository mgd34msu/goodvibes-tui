/**
 * Match a hook's match pattern against a concrete event path.
 * Supports wildcards: "Pre:tool:*" matches "Pre:tool:read", "Pre:tool:exec", etc.
 * "Pre:*:*" matches all Pre hooks. "*:git:commit" matches all phases for git commit.
 */
export function matchesEventPath(pattern: string, eventPath: string): boolean {
  const patternParts = pattern.split(':');
  const eventParts = eventPath.split(':');

  // Patterns must have exactly 3 parts; event paths must have at least 3
  if (patternParts.length !== 3) return false;
  if (eventParts.length < 3) return false;

  // The specific segment may contain colons (e.g. Pre:tool:read:sub)
  // Join remaining event parts back for the third segment
  const eventSpecific = eventParts.slice(2).join(':');
  const toMatch = [eventParts[0], eventParts[1], eventSpecific];

  for (let i = 0; i < 3; i++) {
    if (patternParts[i] === '*') continue;
    if (patternParts[i] !== toMatch[i]) return false;
  }

  return true;
}

/**
 * Match a hook's optional matcher field against a specific value.
 * Used for tool name matching within Pre:tool:* hooks.
 * If matcher is undefined, always returns true (no filter).
 */
export function matchesMatcher(matcher: string | undefined, value: string): boolean {
  if (matcher === undefined) return true;
  return matcher === value;
}
