/**
 * Session Lineage Tracker
 *
 * Append-only micro-log that records the original task and a one-line entry
 * per compaction. Entries are never modified or removed. The section is
 * omitted entirely from compacted output when no task has been set.
 *
 * Lifecycle:
 *   - Owned instance: wire a `SessionLineageTracker` through bootstrap/services.
 *   - Session-scoped: call `reset()` when starting a new session.
 *   - Append-only: entries are never modified or removed after being added.
 *   - `setOriginalTask()` is idempotent — subsequent calls are silently ignored
 *     to support multiple init paths that may each attempt to set the task.
 */
export class SessionLineageTracker {
  private originalTask: string | null = null;
  private entries: string[] = [];

  /**
   * Set the original task for this session.
   * Idempotent — if called more than once only the first call takes effect.
   * Safe to call from multiple init paths.
   */
  setOriginalTask(task: string): void {
    if (this.originalTask !== null) return;
    this.originalTask = task;
  }

  /**
   * Add a compaction entry. Called after each successful compaction.
   * Increments the internal counter and appends one line: `- #N: {summary}`
   * Empty or whitespace-only summaries are silently ignored.
   */
  addCompactionEntry(summary: string): void {
    const trimmed = summary.trim();
    if (!trimmed) return;
    this.entries.push(`- #${this.entries.length + 1}: ${trimmed}`);
  }

  /** Reset to initial state. Use when starting a new session. */
  reset(): void {
    this.originalTask = null;
    this.entries = [];
  }

  /** Get the number of compactions performed. */
  getCompactionCount(): number {
    return this.entries.length;
  }

  /** Get a copy of the lineage entries (read-only snapshot). */
  getEntries(): string[] {
    return [...this.entries];
  }

  /**
   * Format the lineage for compaction output.
   * Returns null if originalTask was never set (section is omitted).
   */
  format(): string | null {
    if (this.originalTask === null) {
      return null;
    }

    const lines: string[] = [
      `## Session Lineage`,
      `Original task: "${this.originalTask}"`,
      `Compactions: ${this.entries.length}`,
      ...this.entries,
    ];

    return lines.join('\n');
  }
}
