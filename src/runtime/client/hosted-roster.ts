/**
 * hosted-roster.ts — the last answer the daemon gave about what it is hosting.
 *
 * The session picker is where a person goes to ask "what sessions are there?",
 * and the honest answer includes conversations running inside the
 * daemon — not only this terminal's saved transcripts and the cross-surface
 * union. The picker is a synchronous render over modal state, though, and
 * `sessions.hosted.list` is a round trip. This roster is the seam between them:
 * it holds the last list the daemon answered with, refreshes on demand, and
 * says plainly when it has never been able to ask.
 *
 * ── Never a fabricated empty list ─────────────────────────────────────────
 *
 * `capturedAt === null` means nobody has successfully read the roster yet,
 * which is a different fact from "the daemon hosts nothing" and renders
 * differently. A refresh that fails keeps the LAST known rows and records the
 * reason, on the same reasoning the fleet poller keeps its rows through a blip:
 * a momentary refusal should not make half the picker blink out.
 *
 * ── Why the client is bound rather than passed ────────────────────────────
 *
 * The picker is constructed in the input layer, which has no config manager and
 * no home directory to resolve a daemon from. The composition root
 * (runtime/services.ts) has both and already builds the verb caller, so it binds
 * the client here once — the same shape the shared notification feed uses for a
 * surface that two unrelated layers read.
 */
import type { HostedSessionRecord, HostedSessionsClient } from './hosted-sessions.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export interface HostedRosterSnapshot {
  readonly sessions: readonly HostedSessionRecord[];
  /** When the daemon last answered, or null when it never has. */
  readonly capturedAt: number | null;
  /** Why the roster is not current. Null when the last read succeeded. */
  readonly note: string | null;
}

const NEVER_READ: HostedRosterSnapshot = { sessions: [], capturedAt: null, note: null };

export class HostedSessionRoster {
  private state: HostedRosterSnapshot = NEVER_READ;
  private client: HostedSessionsClient | null = null;
  private readonly listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;

  bindClient(client: HostedSessionsClient | null): void {
    this.client = client;
  }

  snapshot(): HostedRosterSnapshot {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Record a list a caller already has in hand (the `/hosted list` path). */
  accept(sessions: readonly HostedSessionRecord[]): void {
    this.state = { sessions, capturedAt: Date.now(), note: null };
    this.emit();
  }

  /**
   * Ask the daemon again. Never throws and never runs twice at once — a picker
   * opened repeatedly must not stack round trips.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return await this.inFlight;
    const client = this.client;
    if (!client) {
      this.state = {
        ...this.state,
        note: 'no daemon client is wired in this terminal, so hosted sessions cannot be listed',
      };
      this.emit();
      return;
    }
    this.inFlight = (async () => {
      try {
        this.accept(await client.list());
      } catch (error) {
        this.state = { ...this.state, note: `the daemon did not answer: ${summarizeError(error)}` };
        this.emit();
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

let sharedRoster: HostedSessionRoster | null = null;

/** The one roster the session picker reads and the composition root feeds. */
export function getSharedHostedSessionRoster(): HostedSessionRoster {
  sharedRoster ??= new HostedSessionRoster();
  return sharedRoster;
}

/** Tests build their own roster; this resets the shared one between them. */
export function resetSharedHostedSessionRoster(): void {
  sharedRoster = null;
}
