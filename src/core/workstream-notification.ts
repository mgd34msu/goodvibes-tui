/**
 * workstream-notification.ts, the desktop notification a finished workstream
 * pushes, in words rather than identifiers.
 *
 * These three notifications used to read:
 *
 *     GoodVibes, WRFC chain failed
 *     chain 7f3a91c02b4e failed: review rejected
 *
 * A desktop notification is a message TO a person, so the standing rule applies
 * to it the same way it applies to a chat message: no internal name for the
 * machinery, and no register id. `WRFC` is the first; `7f3a91c02b4e` is the
 * second, and it is not something the reader can do anything with, it is not
 * the commit, not the branch, not the session.
 *
 * What the reader can act on is why the work stopped, so that is what the body
 * now leads with. Two workstreams that end at the same moment are told apart by
 * their reasons, which is the same principle the channel renderer follows: in
 * plain words, never by an opaque identifier.
 *
 * Split out of turn-event-wiring.ts as a pure function so the text is testable
 * on its own, the wiring itself cannot be asserted against without mocking a
 * process-global notifier.
 */
import { formatTurnBudgetOutcome } from './turn-budget-outcome.ts';

/** The fields of WORKFLOW_CHAIN_FAILED this narration reads. */
export interface WorkstreamFailureNarrationInput {
  readonly reason: string;
  readonly failureKind?: 'transport' | 'other' | 'cancelled' | 'max_turns' | undefined;
  readonly turnLimit?: number | undefined;
  readonly turnLimitSource?: 'default' | 'spawn-override' | 'policy-bound' | undefined;
}

export interface WorkstreamNotification {
  readonly title: string;
  readonly body: string;
}

/**
 * Title and body for a workstream that reached a terminal state.
 *
 * An operator cancellation is an intended stop, not a failure, it is narrated
 * as cancelled (the reason already carries the landed-work count from the
 * workstream's edit ledger) so the notification never contradicts the cancelled
 * workstream/owner/cohort surfaces. A turn-budget exhaustion is a spent ceiling
 * rather than an infrastructure error, and its limit and source are read from
 * the typed event fields, never from a regex of the prose reason.
 */
export function workstreamFailureNotification(
  payload: WorkstreamFailureNarrationInput,
): WorkstreamNotification {
  if (payload.failureKind === 'cancelled') {
    return {
      title: 'GoodVibes: workstream cancelled',
      body: `Cancelled: ${payload.reason}`,
    };
  }
  if (payload.failureKind === 'max_turns') {
    return {
      title: 'GoodVibes: workstream hit its turn budget',
      body: `The workstream ${formatTurnBudgetOutcome({ limit: payload.turnLimit, source: payload.turnLimitSource })}`,
    };
  }
  return {
    title: 'GoodVibes: workstream failed',
    body: `Failed: ${payload.failureKind === 'transport' ? 'transient transport error' : payload.reason}`,
  };
}
