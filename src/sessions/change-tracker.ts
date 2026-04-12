// ---------------------------------------------------------------------------
// SessionChangeTracker — tracks files written/edited during the current session
// ---------------------------------------------------------------------------

/**
 * Tracks files written or edited during the current runtime session.
 *
 * Ownership is explicit: the runtime creates one tracker and shares it with
 * write/edit tools plus diff-oriented command surfaces that need to inspect it.
 */
export class SessionChangeTracker {
  private readonly changed = new Set<string>();

  recordChange(filePath: string): void {
    this.changed.add(filePath);
  }

  getChangedFiles(): string[] {
    return Array.from(this.changed);
  }

  clear(): void {
    this.changed.clear();
  }

  count(): number {
    return this.changed.size;
  }
}
