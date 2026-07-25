/**
 * durability-housekeeping.ts — the reclaim half of every crash-durability
 * artefact this product writes to disk.
 *
 * The standing rule this module implements: if something is persisted across
 * restarts and crashes, recovery has to do the housekeeping. Each individual
 * store already knew how to WRITE its artefact and how to retire it on a clean
 * path; none of them reclaimed what a SIGKILL left behind. Four stores, four
 * kinds of residue:
 *
 *   - liveness markers      `<home>/.goodvibes/<root>/liveness/<id>.json`
 *                           removed only on a clean exit, so a crash leaks one
 *                           file per session id ever opened.
 *   - transcript journals   `<home>/.goodvibes/<root>/transcript-<id>.journal`
 *                           deleted on snapshot or replay, so a session that
 *                           crashes and is never resumed leaks its journal.
 *   - quarantine files      `<path>.unrecognized` — written so a human can
 *                           inspect a corrupt file, never removed afterwards.
 *   - anchor sidecars       `<sessionsDir>/<id>.anchors.json` — outlives the
 *                           session JSONL that owns it.
 *
 * Every reap here is bounded by BOTH an age window and a count cap, decides
 * what to keep by reading content rather than by a file merely existing, never
 * touches the current session, tolerates a competing sweeper deleting the same
 * file first, and reports what it removed. `startDurabilityHousekeeping` runs
 * the sweep at startup and then on a repeating timer, because a long-lived
 * process that only sweeps at boot never sweeps.
 *
 * Best-effort throughout: a failure in one reap never aborts the others and
 * nothing here ever throws to its caller.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { join } from 'node:path';
import { reapQuarantinedFiles } from '@/config/read-versioned.ts';
import { reapOrphanedAnchorSidecars } from '@/core/rewind-turn-anchors.ts';
import { reapOrphanedJournals } from '@/core/transcript-journal.ts';
import { checkSessionLiveness, reapStaleLivenessMarkers } from '@/runtime/session-liveness-marker.ts';
import type { SessionSurface } from '@/runtime/index.ts';

/**
 * How often the sweep repeats after startup: 6 hours. Hours, not minutes — the
 * residue this reclaims accumulates per crashed session, not continuously, and
 * a directory scan is not something a foreground TUI should be doing often.
 */
export const DURABILITY_HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface DurabilityHousekeepingInput {
  /** The app's declare-once storage handle; every swept path derives from it. */
  readonly surface: SessionSurface;
  /**
   * The session this process is using right now, read at sweep time rather
   * than captured once — a resume or fork can repoint it between sweeps.
   * Returning null means "not known yet", which is safe: the age and liveness
   * rules independently protect an actively written artefact.
   */
  readonly currentSessionId?: () => string | null;
  /** Extra directories to scan for `.unrecognized` quarantine files. */
  readonly extraQuarantineDirs?: readonly string[];
}

export interface DurabilityHousekeepingOutcome {
  readonly livenessMarkers: number;
  readonly transcriptJournals: number;
  readonly quarantineFiles: number;
  readonly anchorSidecars: number;
  /** Sum of the four counts above — zero means nothing was reclaimed. */
  readonly total: number;
}

/**
 * Run all four reaps once and return what each reclaimed.
 *
 * Each reap is isolated: one throwing is logged at warn level and counted as
 * zero, and the remaining reaps still run. The caller never sees an exception.
 */
export function runDurabilityHousekeeping(input: DurabilityHousekeepingInput): DurabilityHousekeepingOutcome {
  const { surface } = input;
  const currentSessionId = safely('current session id', () => input.currentSessionId?.() ?? null, null);

  const livenessMarkers = safely('liveness markers', () =>
    reapStaleLivenessMarkers(surface, {
      keepSessionIds: currentSessionId ? [currentSessionId] : [],
    }).reaped, 0);

  const transcriptJournals = safely('transcript journals', () =>
    reapOrphanedJournals(surface, {
      currentSessionId,
      // Composition happens here so transcript-journal.ts keeps no dependency
      // on the liveness marker: a journal whose session is open in another
      // running instance is live state, not residue.
      isSessionLive: (sessionId) => checkSessionLiveness(surface, sessionId).live,
    }).reaped, 0);

  const quarantineFiles = safely('quarantine files', () =>
    reapQuarantinedFiles(quarantineDirsFor(input)).reaped, 0);

  const anchorSidecars = safely('anchor sidecars', () =>
    reapOrphanedAnchorSidecars(surface, { currentSessionId }).reaped, 0);

  const outcome: DurabilityHousekeepingOutcome = {
    livenessMarkers,
    transcriptJournals,
    quarantineFiles,
    anchorSidecars,
    total: livenessMarkers + transcriptJournals + quarantineFiles + anchorSidecars,
  };
  discloseHousekeeping(outcome);
  return outcome;
}

/**
 * Start durability housekeeping: one sweep now, then a repeating sweep every
 * `DURABILITY_HOUSEKEEPING_INTERVAL_MS`. Returns a disposer that stops the
 * timer; calling it more than once is harmless.
 *
 * The timer is `unref()`d, so an undisposed sweeper can never hold the process
 * open — same convention the store-snapshot scheduler and the config-file
 * watchers in durability-services.ts use.
 */
export function startDurabilityHousekeeping(
  input: DurabilityHousekeepingInput,
  options: { readonly intervalMs?: number } = {},
): () => void {
  runDurabilityHousekeeping(input);
  const timer = setInterval(
    () => { runDurabilityHousekeeping(input); },
    options.intervalMs ?? DURABILITY_HOUSEKEEPING_INTERVAL_MS,
  );
  timer.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Disclose what was reclaimed — silent deletion is indistinguishable from data
 * loss. Paths and counts only; nothing about a reclaimed file's contents.
 *
 * A sweep that reclaimed nothing logs nothing: the overwhelmingly common boot
 * has no residue at all, and a per-boot "reclaimed 0" line would train readers
 * to ignore the line that actually matters.
 */
function discloseHousekeeping(outcome: DurabilityHousekeepingOutcome): void {
  if (outcome.total === 0) return;
  logger.info('durability housekeeping reclaimed crash residue', {
    livenessMarkers: outcome.livenessMarkers,
    transcriptJournals: outcome.transcriptJournals,
    quarantineFiles: outcome.quarantineFiles,
    anchorSidecars: outcome.anchorSidecars,
    total: outcome.total,
  });
}

/**
 * Every directory that can accumulate `.unrecognized` files: the home-scoped
 * surface root (transcript-journal quarantines) and the per-project session,
 * state, recovery and checkpoint directories (versioned-config quarantines),
 * plus whatever the caller adds.
 */
function quarantineDirsFor(input: DurabilityHousekeepingInput): readonly string[] {
  const { surface } = input;
  return [
    join(surface.homeDirectory, '.goodvibes', surface.surfaceRoot),
    surface.sessionsDir,
    surface.stateDir,
    surface.recoveryDir,
    surface.checkpointsDir,
    ...(input.extraQuarantineDirs ?? []),
  ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
}

/** Run one reap in isolation: never throws, returns `fallback` if it would have. */
function safely<T>(label: string, run: () => T, fallback: T): T {
  try {
    return run();
  } catch (error) {
    logger.warn('durability housekeeping step failed', { step: label, error: summarizeError(error) });
    return fallback;
  }
}
