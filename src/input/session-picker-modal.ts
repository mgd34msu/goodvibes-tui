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

  /** Last status message to show in the modal (e.g. error or success). */
  public statusMessage = '';

  /**
   * Open the modal, loading sessions from SessionManager.
   */
  open(): void {
    const manager = getSessionManager();
    this.sessions = manager.list();
    this.selectedIndex = 0;
    this.statusMessage = '';
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.statusMessage = '';
  }

  moveUp(): void {
    if (this.sessions.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.sessions.length) % this.sessions.length;
  }

  moveDown(): void {
    if (this.sessions.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.sessions.length;
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

    try {
      unlinkSync(session.filePath);
      // Reload list
      const manager = getSessionManager();
      this.sessions = manager.list();
      // Adjust selection
      if (this.selectedIndex >= this.sessions.length) {
        this.selectedIndex = Math.max(0, this.sessions.length - 1);
      }
      this.statusMessage = `Deleted: ${session.name}`;
      return true;
    } catch (e) {
      this.statusMessage = `Error: ${(e as Error).message}`;
      return false;
    }
  }
}
