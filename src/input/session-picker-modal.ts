/**
 * SessionPickerModal — state management for the /sessions picker modal.
 *
 * Lists LOCAL saved transcript files from SessionManager.list() (load/delete
 * operate on these — a saved JSONL session is a different thing from a live
 * control-plane session, see below), tracks selected index, and handles
 * load/delete actions.
 *
 * Union-sessions surface: additionally surfaces the cross-surface
 * session union from `sessionBroker` (a SessionReadFacade — normally
 * `uiServices.sessions.sessionBroker`, the SessionUnionCache) so a user can
 * SEE what sessions are live/closed across every surface sharing this
 * daemon (TUI, webui, companion, automation), not just this process's own
 * saved files. This is deliberately READ-ONLY: a SharedSessionRecord has no
 * on-disk transcript this process can load()/delete() the way a local
 * SessionInfo does, so cross-surface rows are visible + badged, not
 * selectable for load/delete. `sessionBroker` is optional so every existing
 * caller/test that only cares about local saved-session management keeps
 * working unchanged.
 */

import { unlinkSync } from 'node:fs';
import type { SessionInfo, SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import type { SharedSessionRecord } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { CrossSurfaceView, SessionReadFacade } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import type { ConversationManager } from '../core/conversation';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ---------------------------------------------------------------------------
// SessionPickerModal
// ---------------------------------------------------------------------------

/** Honest default posture when no `sessionBroker` was wired: no cross-surface claim. */
const DORMANT_CROSS_SURFACE_VIEW: CrossSurfaceView = {
  mode: 'local',
  online: false,
  stale: false,
  lastSyncAt: null,
  offlineNote: null,
};

export class SessionPickerModal {
  public active = false;
  public sessions: SessionInfo[] = [];
  /** Cross-surface session union (view-only) — see class doc. Empty until open(). */
  public crossSurfaceSessions: readonly SharedSessionRecord[] = [];
  /** Honest posture for crossSurfaceSessions: mode/online/stale/offlineNote. */
  public crossSurfaceView: CrossSurfaceView = DORMANT_CROSS_SURFACE_VIEW;
  public selectedIndex = 0;
  public scrollOffset = 0;
  public visibleRows = 8;
  public deleteConfirmationTarget: string | null = null;

  /** Last status message to show in the modal (e.g. error or success). */
  public statusMessage = '';

  public constructor(
    private readonly sessionManager: SessionManager,
    private readonly sessionBroker?: SessionReadFacade,
  ) {}

  /**
   * Open the modal, loading local saved sessions from SessionManager and (when
   * a sessionBroker was wired) the cross-surface session union, honestly.
   */
  open(): void {
    this.sessions = this.sessionManager.list();
    if (this.sessionBroker) {
      this.crossSurfaceSessions = this.sessionBroker.listSessions();
      this.crossSurfaceView = this.sessionBroker.crossSurfaceView;
    } else {
      this.crossSurfaceSessions = [];
      this.crossSurfaceView = DORMANT_CROSS_SURFACE_VIEW;
    }
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
      const { meta, messages } = this.sessionManager.load(session.name);
      conversationManager.resetAll();
      conversationManager.fromJSON({ messages: messages as never[] });
      if (meta.title) conversationManager.title = meta.title;
      conversationManager.rebuildHistory();
      this.statusMessage = `Loaded: ${session.name} (${messages.length} messages)`;
      return true;
    } catch (e) {
      this.statusMessage = `Error: ${summarizeError(e)}`;
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
      this.sessions = this.sessionManager.list();
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
      this.statusMessage = `Error: ${summarizeError(e)}`;
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
