/**
 * Summarize tool call arguments into a brief display string for progress labels.
 * Extracts the most informative single string arg (path, cmd, etc.) and
 * truncates to 30 characters.
 */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  // Extract the most informative single arg
  for (const key of ['path', 'file', 'cmd', 'pattern', 'url', 'query']) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const trimmed = val.length > 30 ? val.slice(0, 27) + '\u2026' : val;
      return ` \u2014 ${trimmed}`;
    }
  }
  // Fallback: first string value found
  for (const val of Object.values(args)) {
    if (typeof val === 'string' && val.length > 0) {
      const trimmed = val.length > 30 ? val.slice(0, 27) + '\u2026' : val;
      return ` \u2014 ${trimmed}`;
    }
  }
  return '';
}
