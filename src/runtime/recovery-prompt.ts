/**
 * recovery-prompt.ts — the startup "a recovery snapshot exists, do you want
 * it?" flow.
 *
 * A crash-recovery snapshot used to get one sentence in the boot resume
 * notice, which left the operator to read it and retype a command — and for a
 * session that crashed before its first clean save, there was no command that
 * reached the snapshot at all, so the sentence was a dead end. This module
 * replaces that with an explicit two-step ask:
 *
 *   1. "Resume it?"  [Resume] [Not now]
 *   2. on decline:   "Remove this recovery point?"  [Keep] [Remove]
 *
 * Rules this flow keeps:
 *   - Nothing is ever applied without the user picking Resume. There is no
 *     silent auto-restore path here, and this module never loads a snapshot
 *     just to look at it — `checkRecoveryFile` reports, `consumeRecovery`
 *     loads, and only the second one runs after an explicit yes.
 *   - The SDK's `consumeRecovery` is load-then-delete: the snapshot file is
 *     retired only after a successful load, so a failed read can never
 *     destroy state that was never actually recovered.
 *   - Every fact shown is one we actually have (session id, snapshot age,
 *     title when the snapshot carries one, byte size when the file is where
 *     we can stat it). Nothing is estimated to fill the sentence out.
 *   - Those facts live in a row's `detail`, never in the modal title. The
 *     selection overlay truncates its title to the box width
 *     (selection-modal-overlay.ts) but wraps `detail` onto as many lines as it
 *     needs with no cap, so detail is the only place long copy is guaranteed
 *     to be shown in full. Titles here stay short enough to survive a narrow
 *     terminal intact.
 *   - A snapshot whose session still has a live pid marker is not offered at
 *     all: another terminal is refreshing it right now, so it is not an
 *     orphaned crash and resuming it here would fork that instance's live
 *     state.
 *   - Escape is not an answer. Dismissing either modal leaves the snapshot
 *     exactly where it is; only "Remove" deletes anything.
 *   - The destructive row is never the one Enter is already sitting on. Both
 *     modals open on their harmless first row, so answering either of them
 *     without reading keeps the snapshot.
 *   - Keep (or a dismissal) stays quiet for the rest of the run. The snapshot
 *     is offered again on the next launch, not again in this one.
 */
import { statSync } from 'node:fs';
import { checkRecoveryFile, checkRecoveryForSession, consumeRecovery, removeRecoveryPoint } from '@/runtime/index.ts';
import type { RecoveryFileInfo, SessionSurface } from '@/runtime/index.ts';
import { checkSessionLiveness } from './session-liveness-marker.ts';
import type { SelectionItem, SelectionResult } from '../input/selection-modal.ts';

/** How the offer ended. Returned so startup wiring (and tests) can assert the real outcome. */
export type RecoveryPromptOutcome =
  | 'none' // no snapshot, or one that belongs to a still-live session
  | 'resumed' // user chose Resume and the snapshot was applied
  | 'resume-failed' // user chose Resume but the snapshot could not be loaded
  | 'removed' // user declined and chose Remove
  | 'kept'; // user declined and chose Keep, or dismissed a modal

/** Open a selection modal and resolve with the chosen item id (null on dismissal). */
export type SelectionOpener = (
  title: string,
  items: SelectionItem[],
  opts: { preSelectId?: string; allowSearch?: boolean; primaryVerbLabel?: string } | undefined,
  callback: (result: SelectionResult | null) => void,
) => void;

export interface RecoveryPromptDeps {
  readonly surface: SessionSurface;
  /** The shell's selection-modal opener. Absent in headless hosts — the flow then does nothing at all. */
  readonly openSelection: SelectionOpener | undefined;
  /**
   * Apply an explicitly-accepted snapshot to the live conversation and report
   * how many messages ended up in it. Supplied by the startup wiring so this
   * module never reaches into conversation state itself.
   */
  readonly applySnapshot: (payload: { readonly snapshot: Record<string, unknown>; readonly sessionId: string }) => number;
  /** One-line honest receipt into the transcript. */
  readonly receipt: (line: string) => void;
  readonly render: () => void;
  /** Injectable for tests. Defaults to the real wall clock. */
  readonly now?: () => number;
  /** Injectable for tests. Defaults to statSync on the surface's own recovery file. */
  readonly snapshotBytes?: (sessionId: string) => number | null;
  /**
   * When set, offer THIS session's snapshot specifically (via
   * `checkRecoveryForSession`) instead of the newest snapshot across every
   * session (`checkRecoveryFile`). Used by the `--continue` / bare `--resume`
   * pre-resume check (cli/tui-startup.ts): resuming a named session straight
   * from its durable store would silently drop the tail of messages held only
   * in a snapshot newer than that store — the same rule `checkRecoveryFile`
   * uses, just scoped to the one session being resumed instead of "whichever
   * session has the newest snapshot".
   */
  readonly targetSessionId?: string;
}

// ─── Honest fact formatting ─────────────────────────────────────────────────

/** Human-readable age of a snapshot. Coarse on purpose — the exact second is not a fact worth claiming. */
export function formatSnapshotAge(ageMs: number): string {
  if (ageMs < 0) return 'just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Compact byte size. Only ever called with a size we actually read off disk. */
export function formatSnapshotSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short, fixed modal titles. Kept well inside the narrowest box width so neither is ever truncated. */
export const RECOVERY_OFFER_TITLE = 'Recovery snapshot found';
export const RECOVERY_RETIRE_TITLE = 'Remove recovery point?';

/**
 * The facts line shown in the modal. Only includes what is genuinely known:
 * the session id and age are always available from `checkRecoveryFile`; the
 * title appears only when the snapshot carries a non-empty one; the size
 * appears only when the file could be stat'd.
 */
export function describeRecoverySnapshot(
  info: RecoveryFileInfo,
  facts: { readonly nowMs: number; readonly bytes: number | null },
): string {
  const parts = [`session ${info.sessionId}`, formatSnapshotAge(facts.nowMs - info.timestamp)];
  if (info.title && info.title.trim()) parts.push(`"${info.title.trim()}"`);
  if (facts.bytes !== null) parts.push(formatSnapshotSize(facts.bytes));
  return parts.join(' · ');
}

/**
 * The offer modal's rows. The snapshot's facts ride on the Resume row's
 * `detail` — both because that is where they are decision-relevant ("this is
 * what you would be loading") and because `detail` is the only field the
 * selection overlay wraps rather than truncates, so the full description
 * survives any terminal width.
 */
export function buildRecoveryOfferItems(facts: string): SelectionItem[] {
  return [
    {
      id: 'resume',
      label: 'Resume it',
      detail: `Loads ${facts} into this session. The recovery point is deleted once it loads.`,
      primaryAction: 'select',
    },
    {
      id: 'not-now',
      label: 'Not now',
      detail: 'Start fresh. You will be asked whether to keep or remove the recovery point.',
      primaryAction: 'select',
    },
  ];
}

/**
 * The follow-up modal's rows, shown only after an explicit decline. Restates
 * which snapshot is at stake.
 *
 * Keep comes first, and so is what a blind Enter lands on. This modal is the
 * one place in the flow where a keypress can destroy a conversation, and it
 * appears unrequested at boot, so the row under the cursor has to be the one
 * that costs nothing: pressing Enter without reading leaves the snapshot on
 * disk to be offered again. Deleting it takes a deliberate move down first.
 */
export function buildRecoveryRetireItems(facts: string): SelectionItem[] {
  return [
    {
      id: 'keep',
      label: 'Keep it',
      detail: 'Leave the recovery point on disk. It will be offered again the next time this workspace opens.',
      primaryAction: 'select',
    },
    {
      id: 'remove',
      label: 'Remove it',
      detail: `Deletes the recovery point for ${facts}. The conversation it holds cannot be recovered afterwards.`,
      primaryAction: 'select',
    },
  ];
}

// ─── Flow ───────────────────────────────────────────────────────────────────

function ask(open: SelectionOpener, title: string, items: SelectionItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    open(title, items, { allowSearch: false, primaryVerbLabel: 'Choose' }, (result) => {
      resolve(result?.item.id ?? null);
    });
  });
}

function defaultSnapshotBytes(surface: SessionSurface, sessionId: string): number | null {
  try {
    return statSync(surface.recoveryFile(sessionId)).size;
  } catch {
    // The snapshot may have come from the SDK's legacy dual-read location,
    // which this path cannot address. Report no size rather than a wrong one.
    return null;
  }
}

/**
 * Snapshots the user has already answered about (Keep or dismissal) during
 * this process's lifetime. Two offer paths exist in one boot — the targeted
 * pre-resume check for `--continue`/`--resume` and the general startup offer —
 * and both can find the same snapshot; an answer given to either binds both,
 * so "stays quiet for the rest of the run" holds across the pair. Resume and
 * Remove retire the file itself, so only the declined cases need remembering.
 */
const answeredThisRun = new Set<string>();

/** Test seam: a fresh process has no answered offers. */
export function resetAnsweredRecoveryOffersForTest(): void {
  answeredThisRun.clear();
}

/**
 * Run the startup recovery offer. Resolves once the user has answered (or
 * once it is established that there is nothing to ask about). Never throws:
 * a failure anywhere in here must not take a boot down.
 */
export async function offerRecoverySnapshot(deps: RecoveryPromptDeps): Promise<RecoveryPromptOutcome> {
  try {
    const info = deps.targetSessionId !== undefined
      ? checkRecoveryForSession(deps.surface, deps.targetSessionId)
      : checkRecoveryFile({ surface: deps.surface });
    if (!info) return 'none';
    // Already answered about this snapshot earlier in this same run (the
    // targeted --continue offer and the general startup offer can both find
    // it). The earlier answer stands; don't ask twice.
    if (answeredThisRun.has(info.sessionId)) return 'kept';
    // Another terminal is actively refreshing this snapshot — it is that
    // instance's live state, not an orphaned crash.
    if (checkSessionLiveness(deps.surface, info.sessionId).live) return 'none';
    const open = deps.openSelection;
    if (!open) return 'none';

    const nowMs = deps.now?.() ?? Date.now();
    const bytes = deps.snapshotBytes ? deps.snapshotBytes(info.sessionId) : defaultSnapshotBytes(deps.surface, info.sessionId);
    const facts = describeRecoverySnapshot(info, { nowMs, bytes });

    const answer = await ask(open, RECOVERY_OFFER_TITLE, buildRecoveryOfferItems(facts));

    if (answer === 'resume') {
      const { snapshot, consumed } = consumeRecovery(deps.surface, info.sessionId);
      if (!snapshot || !consumed) {
        // consumeRecovery leaves the file alone when the load fails, so the
        // snapshot is still there to try again next launch. Say so.
        deps.receipt('Recovery snapshot could not be read — it was left on disk and will be offered again next launch.');
        deps.render();
        return 'resume-failed';
      }
      const messageCount = deps.applySnapshot({ snapshot: snapshot as unknown as Record<string, unknown>, sessionId: info.sessionId });
      deps.receipt(`Recovery snapshot restored: ${messageCount} message(s) from session ${info.sessionId}. The recovery point has been retired.`);
      deps.render();
      return 'resumed';
    }

    if (answer !== 'not-now') {
      // Dismissed rather than answered. Nothing is deleted and nothing is
      // asked again this run.
      answeredThisRun.add(info.sessionId);
      return 'kept';
    }

    const retire = await ask(open, RECOVERY_RETIRE_TITLE, buildRecoveryRetireItems(facts));
    if (retire === 'remove') {
      const { removed } = removeRecoveryPoint(deps.surface, info.sessionId);
      deps.receipt(removed
        ? `Recovery point removed (session ${info.sessionId}).`
        : `No recovery point was found to remove (session ${info.sessionId}).`);
      deps.render();
      return 'removed';
    }

    answeredThisRun.add(info.sessionId);
    deps.receipt(`Recovery point kept (session ${info.sessionId}) — it will be offered again next launch.`);
    deps.render();
    return 'kept';
  } catch {
    // Best-effort by construction: a recovery offer that fails must leave the
    // snapshot untouched and the boot unharmed.
    return 'none';
  }
}

// ─── Startup wiring ─────────────────────────────────────────────────────────

/**
 * Raise the recovery offer once the shell is up.
 *
 * Deliberately fire-and-forget and deliberately AFTER the first render: the
 * modal is drawn by the render loop, so asking before a frame exists would
 * mean a question nobody can see, and awaiting it would hold the terminal
 * blank while the user was expected to answer. Scheduled on a macrotask so
 * the caller's own initial render has completed first.
 *
 * Every failure mode here ends with the snapshot untouched: `offerRecoverySnapshot`
 * swallows its own errors, and this wrapper adds a catch for the scheduling
 * boundary.
 */
export function scheduleRecoveryOffer(deps: RecoveryPromptDeps): void {
  setTimeout(() => {
    void offerRecoverySnapshot(deps).catch(() => {
      // Best-effort: a failed offer must never take the shell down.
    });
  }, 0).unref?.();
}
