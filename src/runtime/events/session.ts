/**
 * SessionEvent — discriminated union covering all session lifecycle events.
 *
 * Covers session lifecycle events for the runtime event bus.
 */

export type SessionEvent =
  /** A new session has been created and is initialising. */
  | { type: 'SESSION_STARTED'; sessionId: string; profileId: string; workingDir: string }
  /** An existing session is being loaded from disk. */
  | { type: 'SESSION_LOADING'; sessionId: string; path: string }
  /** A previously saved session is being resumed. */
  | { type: 'SESSION_RESUMED'; sessionId: string; turnCount: number }
  /** Session state is being repaired after a detected inconsistency. */
  | { type: 'SESSION_REPAIRING'; sessionId: string; reason: string }
  /** Context messages are being reconciled with stored state. */
  | { type: 'SESSION_RECONCILING'; sessionId: string; messageCount: number }
  /** Session is fully loaded and ready for input. */
  | { type: 'SESSION_READY'; sessionId: string }
  /** Session recovery has failed unrecoverably. */
  | { type: 'SESSION_RECOVERY_FAILED'; sessionId: string; error: string };

/** All session event type literals as a union. */
export type SessionEventType = SessionEvent['type'];
