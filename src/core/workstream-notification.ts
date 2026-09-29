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
 * The title names the work (owner ruling 2026-09-29): the workstream's task,
 * trimmed at a word boundary, and the body adds the last review score when
 * one was reached. behavior.notificationsMetadataOnly (default off) drops the
 * task, the reason and the score, leaving what kind of stop it was.
 *
 * Split out of turn-event-wiring.ts as a pure function so the text is testable
 * on its own, the wiring itself cannot be asserted against without mocking a
 * process-global notifier.
 */
import { formatTurnBudgetOutcome } from './turn-budget-outcome.ts';
import { NOTIFICATION_TEXT_LIMITS, trimAtWordBoundary } from '@pellux/goodvibes-sdk/platform/runtime/operations';

/** The fields of WORKFLOW_CHAIN_FAILED this narration reads. */
export interface WorkstreamFailureNarrationInput {
  readonly reason: string;
  readonly failureKind?: 'transport' | 'other' | 'cancelled' | 'max_turns' | undefined;
  readonly turnLimit?: number | undefined;
  readonly turnLimitSource?: 'default' | 'spawn-override' | 'policy-bound' | undefined;
}

/** What the host remembers about the workstream, and the privacy setting. */
export interface WorkstreamNotificationContext {
  /** The workstream's task, from WORKFLOW_CHAIN_CREATED. */
  readonly task?: string | null | undefined;
  /** The last review score (out of 10), from WORKFLOW_REVIEW_COMPLETED. */
  readonly reviewScore?: number | null | undefined;
  /** behavior.notificationsMetadataOnly */
  readonly metadataOnly?: boolean | undefined;
}

export interface WorkstreamNotification {
  readonly title: string;
  readonly body: string;
}

function titled(outcome: string, context: WorkstreamNotificationContext): string {
  const prefix = `Workstream ${outcome}: `;
  const task = context.metadataOnly ? '' : trimAtWordBoundary(context.task ?? '', NOTIFICATION_TEXT_LIMITS.desktopTitle - prefix.length);
  return task ? `${prefix}${task}` : `GoodVibes: workstream ${outcome}`;
}

function withScore(body: string, context: WorkstreamNotificationContext): string {
  if (context.metadataOnly || typeof context.reviewScore !== 'number' || !Number.isFinite(context.reviewScore)) return body;
  return `${body} (last review ${Math.round(context.reviewScore * 10) / 10}/10)`;
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
  context: WorkstreamNotificationContext = {},
): WorkstreamNotification {
  const metadataOnly = context.metadataOnly === true;
  if (payload.failureKind === 'cancelled') {
    return {
      title: titled('cancelled', context),
      body: metadataOnly ? 'Cancelled' : withScore(`Cancelled: ${payload.reason}`, context),
    };
  }
  if (payload.failureKind === 'max_turns') {
    return {
      title: titled('hit its turn budget', context),
      body: withScore(`The workstream ${formatTurnBudgetOutcome({ limit: payload.turnLimit, source: payload.turnLimitSource })}`, context),
    };
  }
  const reason = payload.failureKind === 'transport' ? 'transient transport error' : payload.reason;
  return {
    title: titled('failed', context),
    body: metadataOnly ? (payload.failureKind === 'transport' ? `Failed: ${reason}` : 'Failed') : withScore(`Failed: ${reason}`, context),
  };
}
