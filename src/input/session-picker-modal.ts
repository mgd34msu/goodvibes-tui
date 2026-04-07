/**
 * SessionPickerModal — state management for the /sessions picker modal.
 *
 * Lists sessions from SessionManager.list(), tracks selected index,
 * and handles load/delete actions.
 */

import { unlinkSync } from 'node:fs';
import { getSessionManager, type SessionInfo } from '../sessions/manager.ts';
import type { ConversationManager } from '../core/conversation.ts';

// ---------------------------------------------------------------------------
// SessionPickerModal
// ---------------------------------------------------------------------------

export class SessionPickerModal {
  public active = false;
  public sessions: SessionInfo[] = [];
  public selectedIndex = 0;
  public scrollOffset = 0;
  public visibleRows = 8;
  public deleteConfirmationTarget: string | null = null;

  /** Last status message to show in the modal (e.g. error or success). */
  public statusMessage = '';

  /**
   * Open the modal, loading sessions from SessionManager.
   */
  open(): void {
    const manager = getSessionManager();
    this.sessions = manager.list();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
  }

  moveUp(): void {
    if (this.sessions.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.sessions.length) % this.sessions.length;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }

  moveDown(): void {
    if (this.sessions.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.sessions.length;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }

  setVisibleRows(rows: number): void {
    this.visibleRows = Math.max(3, rows);
    this._clampScroll();
  }

  getSelected(): SessionInfo | null {
    return this.sessions[this.selectedIndex] ?? null;
  }

  /**
   * Load the currently selected session into the given ConversationManager.
   * Returns true on success, false on error.
   */
  loadSelected(conversationManager: ConversationManager): boolean {
    const session = this.getSelected();
    if (!session) return false;

    try {
      const manager = getSessionManager();
      const { meta, messages } = manager.load(session.name);
      conversationManager.resetAll();
      conversationManager.fromJSON({ messages: messages as never[] });
      if (meta.title) conversationManager.title = meta.title;
      conversationManager.rebuildHistory();
      this.statusMessage = `Loaded: ${session.name} (${messages.length} messages)`;
      return true;
    } catch (e) {
      this.statusMessage = `Error: ${(e as Error).message}`;
      return false;
    }
  }

  /**
   * Delete the currently selected session from disk.
   * Refreshes the list after deletion.
   */
  deleteSelected(): boolean {
    const session = this.getSelected();
    if (!session) return false;
    if (this.deleteConfirmationTarget !== session.name) {
      this.deleteConfirmationTarget = session.name;
      this.statusMessage = `Press d again to delete ${session.name}.`;
      return false;
    }

    try {
      // Delete directly via filePath so it works with any session directory
      unlinkSync(session.filePath);
      // Reload list from the global session manager (removes the deleted entry)
      const manager = getSessionManager();
      this.sessions = manager.list();
      // Adjust selection
      if (this.selectedIndex >= this.sessions.length) {
        this.selectedIndex = Math.max(0, this.sessions.length - 1);
      }
      this._clampScroll();
      this.deleteConfirmationTarget = null;
      this.statusMessage = `Deleted: ${session.name}`;
      return true;
    } catch (e) {
      this.deleteConfirmationTarget = null;
      this.statusMessage = `Error: ${(e as Error).message}`;
      return false;
    }
  }

  private _clampScroll(): void {
    const visRows = Math.max(3, this.visibleRows);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visRows) {
      this.scrollOffset = this.selectedIndex - visRows + 1;
    }
    const maxOffset = Math.max(0, this.sessions.length - visRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }
}
