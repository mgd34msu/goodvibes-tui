/**
 * hosted-session-feed.ts — what this terminal knows about the daemon-hosted
 * session it is attached to.
 *
 * One place holds it because two surfaces read it: the `/hosted` command family
 * (which prints status and drives the verbs) and the Hosted Session panel
 * (which renders the conversation). The same shared-feed shape
 * notifications-feed.ts already uses in this repo — a module-level instance a
 * command writes and a panel subscribes to — rather than threading a service
 * through the command context and the panel deps for one feature.
 *
 * ── What is a fact here, and what is a rendering ──────────────────────────
 *
 * The RECORD is the daemon's, verbatim: status, attached clients, turn count,
 * and `effectiveDetachPolicy` — what leaving would do right now. This feed
 * never recomputes those; it stores the last record a verb or a lifecycle event
 * handed it.
 *
 * The ROWS are this terminal's rendering of the transcript: the history
 * `attach` backfilled, plus what the live `turn` and `tools` frames have said
 * since. A row that is still being streamed is marked `streaming` so the panel
 * can show it growing rather than waiting for the turn to end — the same thing
 * a local turn does.
 *
 * ── Bounded, because it is a live buffer ──────────────────────────────────
 *
 * Rows are capped and the oldest are dropped with an honest note saying how
 * many, rather than growing without limit for a session that runs for days. The
 * daemon keeps the authoritative transcript; a reattach backfills it again.
 */
import type {
  HostedSessionHistoryMessage,
  HostedSessionRecord,
} from '@pellux/goodvibes-sdk/platform/hosted-sessions';
import type { HostedSessionStreamEvent } from '../runtime/client/hosted-session-stream.ts';

/** How many transcript rows are kept before the oldest are dropped. */
export const MAX_HOSTED_ROWS = 400;

export type HostedRowKind = 'user' | 'assistant' | 'system' | 'tool' | 'error';

/** One rendered line-group of the hosted conversation. */
export interface HostedSessionRow {
  readonly kind: HostedRowKind;
  readonly text: string;
  readonly at: number;
  /** True while this row is still being appended to by a live stream. */
  readonly streaming: boolean;
  /** Set for tool rows: the call this row is about, so a cancel can name it. */
  readonly callId?: string | undefined;
}

/** A tool call the stream says is running right now. */
export interface HostedRunningToolCall {
  readonly callId: string;
  readonly tool: string;
  readonly startedAt: number;
}

/** Everything the panel renders and the command reports. */
export interface HostedSessionFeedState {
  readonly record: HostedSessionRecord | null;
  readonly rows: readonly HostedSessionRow[];
  readonly runningToolCalls: readonly HostedRunningToolCall[];
  /** True when a live event stream is open for this session. */
  readonly streaming: boolean;
  /** Why there is no live stream, when there is not one. Never a guess. */
  readonly streamNote: string | null;
  /** How many rows were dropped by the bound, for an honest header. */
  readonly droppedRows: number;
}

const EMPTY_STATE: HostedSessionFeedState = {
  record: null,
  rows: [],
  runningToolCalls: [],
  streaming: false,
  streamNote: null,
  droppedRows: 0,
};

function historyRow(message: HostedSessionHistoryMessage): HostedSessionRow {
  const kind: HostedRowKind = message.role === 'assistant'
    ? 'assistant'
    : message.role === 'user' ? 'user' : message.role === 'tool' ? 'tool' : 'system';
  return { kind, text: message.content, at: message.at ?? 0, streaming: false };
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/**
 * The attached hosted session, as this terminal sees it.
 *
 * Deliberately a plain observable object rather than a store domain: nothing
 * about a hosted session participates in the local conversation's state
 * machine, and putting it there would make the local reducers answer for a
 * conversation running in another process.
 */
export class HostedSessionFeed {
  private state: HostedSessionFeedState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  /** The assistant row currently being streamed, by index into `rows`. */
  private streamingRowIndex: number | null = null;

  getState(): HostedSessionFeedState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** True when this terminal is attached to a hosted session that has not ended. */
  isAttached(): boolean {
    return this.state.record !== null && this.state.record.status !== 'terminated';
  }

  /** Start rendering a session: the record the verb returned and its backfilled history. */
  attach(record: HostedSessionRecord, history: readonly HostedSessionHistoryMessage[]): void {
    this.streamingRowIndex = null;
    this.state = {
      record,
      rows: history.map(historyRow).slice(-MAX_HOSTED_ROWS),
      runningToolCalls: [],
      streaming: false,
      streamNote: null,
      droppedRows: Math.max(0, history.length - MAX_HOSTED_ROWS),
    };
    this.emit();
  }

  /** Replace the record — every verb answer and every lifecycle notice lands here. */
  setRecord(record: HostedSessionRecord): void {
    if (this.state.record && this.state.record.id !== record.id) return;
    this.state = { ...this.state, record };
    this.emit();
  }

  /** Say whether a live stream is open, and why not when it is not. */
  setStreaming(streaming: boolean, note: string | null = null): void {
    this.state = { ...this.state, streaming, streamNote: note };
    this.emit();
  }

  /** Append a note of this terminal's own — a detach, a refusal, a stream drop. */
  note(text: string, kind: HostedRowKind = 'system'): void {
    this.appendRow({ kind, text, at: Date.now(), streaming: false });
  }

  /** Forget the session entirely (detached, killed, or replaced). */
  clear(): void {
    this.streamingRowIndex = null;
    this.state = EMPTY_STATE;
    this.emit();
  }

  /**
   * Fold one live frame into the transcript.
   *
   * Frames for another session never reach here (the stream filters on the id),
   * but the guard stays because a feed that rendered another conversation's
   * tokens would be indistinguishable from this one working.
   */
  apply(event: HostedSessionStreamEvent): void {
    if (!this.state.record || event.sessionId !== this.state.record.id) return;
    if (event.domain === 'turn') { this.applyTurnEvent(event); return; }
    this.applyToolEvent(event);
  }

  private applyTurnEvent(event: HostedSessionStreamEvent): void {
    switch (event.type) {
      case 'TURN_SUBMITTED': {
        const prompt = readString(event.payload, 'prompt');
        if (prompt) this.appendRow({ kind: 'user', text: prompt, at: event.at, streaming: false });
        return;
      }
      case 'STREAM_DELTA': {
        // `accumulated` is the whole response so far, which is exactly what a
        // row wants: a client that joined mid-turn renders the full text rather
        // than the tail it happened to catch.
        const accumulated = readString(event.payload, 'accumulated')
          || readString(event.payload, 'content');
        if (!accumulated) return;
        this.updateStreamingRow(accumulated, event.at);
        return;
      }
      case 'TURN_COMPLETED': {
        const response = readString(event.payload, 'response');
        if (response) this.updateStreamingRow(response, event.at);
        this.settleStreamingRow();
        return;
      }
      case 'TURN_ERROR': {
        this.settleStreamingRow();
        this.appendRow({
          kind: 'error',
          text: readString(event.payload, 'error') || 'the hosted turn ended with an error',
          at: event.at,
          streaming: false,
        });
        return;
      }
      case 'TURN_CANCEL': {
        this.settleStreamingRow();
        const reason = readString(event.payload, 'reason');
        this.appendRow({
          kind: 'system',
          text: reason ? `turn cancelled — ${reason}` : 'turn cancelled',
          at: event.at,
          streaming: false,
        });
        return;
      }
      default:
        return;
    }
  }

  private applyToolEvent(event: HostedSessionStreamEvent): void {
    const callId = readString(event.payload, 'callId');
    const tool = readString(event.payload, 'tool');
    if (!callId || !tool) return;
    switch (event.type) {
      case 'TOOL_EXECUTING': {
        this.settleStreamingRow();
        this.state = {
          ...this.state,
          runningToolCalls: [
            ...this.state.runningToolCalls.filter((call) => call.callId !== callId),
            { callId, tool, startedAt: event.at },
          ],
        };
        this.appendRow({ kind: 'tool', text: `${tool} — running`, at: event.at, streaming: true, callId });
        return;
      }
      case 'TOOL_SUCCEEDED':
      case 'TOOL_FAILED':
      case 'TOOL_CANCELLED': {
        const outcome = event.type === 'TOOL_SUCCEEDED'
          ? 'done'
          : event.type === 'TOOL_FAILED'
            ? `failed — ${readString(event.payload, 'error') || 'no reason reported'}`
            : `cancelled${readString(event.payload, 'reason') ? ` — ${readString(event.payload, 'reason')}` : ''}`;
        this.state = {
          ...this.state,
          runningToolCalls: this.state.runningToolCalls.filter((call) => call.callId !== callId),
          rows: this.state.rows.map((row) => (
            row.callId === callId && row.streaming
              ? { ...row, text: `${tool} — ${outcome}`, streaming: false }
              : row
          )),
        };
        this.emit();
        return;
      }
      default:
        return;
    }
  }

  /** Fold a hosted lifecycle transition in: the record, plus a line when it matters. */
  applyLifecycle(update: { readonly event: string; readonly session: HostedSessionRecord; readonly detail?: string | undefined }): void {
    this.setRecord(update.session);
    if (update.event === 'hosted-session-terminated') {
      this.settleStreamingRow();
      const reason = update.session.terminatedReason ?? 'no reason recorded';
      this.note(`this hosted session ended — ${reason}${update.detail ? ` (${update.detail})` : ''}`);
    }
  }

  private updateStreamingRow(text: string, at: number): void {
    if (this.streamingRowIndex === null) {
      this.appendRow({ kind: 'assistant', text, at, streaming: true });
      this.streamingRowIndex = this.state.rows.length - 1;
      return;
    }
    const rows = [...this.state.rows];
    const existing = rows[this.streamingRowIndex];
    if (!existing) { this.streamingRowIndex = null; return; }
    rows[this.streamingRowIndex] = { ...existing, text, at };
    this.state = { ...this.state, rows };
    this.emit();
  }

  private settleStreamingRow(): void {
    if (this.streamingRowIndex === null) return;
    const rows = [...this.state.rows];
    const existing = rows[this.streamingRowIndex];
    if (existing) rows[this.streamingRowIndex] = { ...existing, streaming: false };
    this.streamingRowIndex = null;
    this.state = { ...this.state, rows };
    this.emit();
  }

  private appendRow(row: HostedSessionRow): void {
    const rows = [...this.state.rows, row];
    let dropped = this.state.droppedRows;
    while (rows.length > MAX_HOSTED_ROWS) {
      rows.shift();
      dropped += 1;
      if (this.streamingRowIndex !== null) this.streamingRowIndex -= 1;
    }
    if (this.streamingRowIndex !== null && this.streamingRowIndex < 0) this.streamingRowIndex = null;
    this.state = { ...this.state, rows, droppedRows: dropped };
    this.emit();
  }

  private emit(): void {
    // Snapshot before iterating: a listener that unsubscribes during dispatch
    // must not make the next listener be skipped.
    for (const listener of [...this.listeners]) listener();
  }
}

let sharedFeed: HostedSessionFeed | null = null;

/** The one feed the `/hosted` command writes and the Hosted Session panel reads. */
export function getSharedHostedSessionFeed(): HostedSessionFeed {
  sharedFeed ??= new HostedSessionFeed();
  return sharedFeed;
}

/** Tests build their own feed; this resets the shared one between them. */
export function resetSharedHostedSessionFeed(): void {
  sharedFeed = null;
}
