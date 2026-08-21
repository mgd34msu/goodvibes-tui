/**
 * conversation-user-receipts.ts, tracks which system-role message indices
 * are a direct receipt for an explicit user action (e.g. answering the
 * startup recovery modal's Resume/Keep/Remove choice), as opposed to ambient
 * boot chatter (provider registration, the resume notice, etc.). Kept in its
 * own file so ConversationManager (core/conversation.ts), already near its
 * line-count gate, doesn't have to carry the bookkeeping inline.
 *
 * ConversationManager.rebuildHistory()'s splash-vs-transcript check consults
 * this via ConversationManager.addUserActionReceipt(): a receipt the user is
 * actively waiting on must displace the splash the way a user message does,
 * while quiet startup plumbing keeps rendering underneath it. Indices mirror
 * messageKindRegistry's own lifecycle, cleared on resetAll(), purged for
 * indices an undo() frees for reuse, deleted when a later add overwrites the
 * same recycled index with a non-receipt message.
 */
export class UserReceiptIndices {
  private readonly indices = new Set<number>();

  add(index: number): void {
    this.indices.add(index);
  }

  delete(index: number): void {
    this.indices.delete(index);
  }

  has(index: number): boolean {
    return this.indices.has(index);
  }

  clear(): void {
    this.indices.clear();
  }

  /** Drop every tracked index >= minIndex, mirrors undo()'s tail-splice. */
  purgeFrom(minIndex: number): void {
    for (const key of this.indices) {
      if (key >= minIndex) this.indices.delete(key);
    }
  }
}
