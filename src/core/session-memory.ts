/**
 * SessionMemoryStore manages pinned in-memory notes for the current session.
 *
 * - Session-scoped: all memories are lost when the process exits.
 * - In-memory only: no persistence, no token cap enforced here.
 * - IDs are monotonically incrementing (mem-1, mem-2, ...) and persist through
 *   clear() calls to ensure uniqueness across the lifetime of the store.
 */
export interface SessionMemory {
  id: string;      // "mem-1", "mem-2", etc.
  text: string;    // the pinned content
  createdAt: number;
}

export class SessionMemoryStore {
  private memories: SessionMemory[] = [];
  private counter = 0;

  /** Add a memory, returns the assigned ID. Returns empty string if text is blank. */
  add(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    this.counter++;
    const id = `mem-${this.counter}`;
    this.memories.push({ id, text: trimmed, createdAt: Date.now() });
    return id;
  }

  /** Remove a memory by ID, returns true if found */
  remove(id: string): boolean {
    const idx = this.memories.findIndex(m => m.id === id);
    if (idx === -1) return false;
    this.memories.splice(idx, 1);
    return true;
  }

  /** List all memories */
  list(): readonly SessionMemory[] {
    return this.memories;
  }

  /** Format memories for compaction output. Returns null if no memories. */
  format(): string | null {
    if (this.memories.length === 0) return null;
    const lines = this.memories.map(m => `- [${m.id}] ${m.text}`);
    return `## Session Memories (pinned)\n${lines.join('\n')}`;
  }

  /** Get total estimated tokens across all memories (rough: chars / 4) */
  estimateTokens(): number {
    return Math.ceil(
      this.memories.reduce((sum, m) => sum + m.text.length, 0) / 4
    );
  }

  /** Clear all memories. NOTE: counter is intentionally NOT reset — IDs must remain unique
   *  across the lifetime of the store even after a clear(). */
  clear(): void {
    this.memories = [];
  }
}
