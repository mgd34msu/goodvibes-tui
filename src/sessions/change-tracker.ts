// ---------------------------------------------------------------------------
// SessionChangeTracker — tracks files written/edited during the current session
// ---------------------------------------------------------------------------
//
// This is a lightweight in-memory singleton. Tools that write files call
// `recordChange(filePath)` to register the path. The /diff command queries
// `getChangedFiles()` to enumerate all paths touched in this session.
//
// No persistence — the tracker resets when the process exits.
// ---------------------------------------------------------------------------

/** Absolute or cwd-relative paths of files written/edited this session. */
const _changed = new Set<string>();

/** Record that a file was created or modified during this session. */
export function recordChange(filePath: string): void {
  _changed.add(filePath);
}

/** Return all file paths changed this session, in insertion order. */
export function getChangedFiles(): string[] {
  return Array.from(_changed);
}

/** Clear the tracker (e.g. on session reset). */
export function clearChanges(): void {
  _changed.clear();
}

/** Number of changed files. */
export function changeCount(): number {
  return _changed.size;
}
