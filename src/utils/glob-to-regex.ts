/**
 * Shared glob-to-regex conversion utility.
 * Handles **, *, and ? wildcards correctly for file path matching.
 */
export function buildGlobMatcher(glob: string): (path: string) => boolean {
  const regex = globToRegex(glob);
  return (path: string) => regex.test(path.replace(/\\/g, '/'));
}

export function globToRegex(glob: string): RegExp {
  // Escape regex special chars character-by-character to avoid TS regex literal
  // parsing issues with character classes.
  const specials = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
  let escaped = '';
  for (const ch of glob) {
    if (specials.has(ch)) {
      escaped += '\\' + ch;
    } else {
      escaped += ch;
    }
  }
  // Handle glob wildcards (order matters: ** before *)
  escaped = escaped
    .replace(/\*/g, '__STAR__')
    .replace(/__STAR____STAR__\//g, '(?:.+/)?') // **/ => any path prefix
    .replace(/__STAR____STAR__/g, '.+')          // **  => any chars
    .replace(/__STAR__/g, '[^/]*')               // *   => filename chars only
    .replace(/\?/g, '[^/]');                     // ?   => single non-slash char
  return new RegExp(`(^|/)${escaped}$`);
}
