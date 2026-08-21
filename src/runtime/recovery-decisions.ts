/**
 * recovery-decisions.ts, a durable record of the recovery snapshots the user
 * has already said "Remove" to.
 *
 * The defect this exists for: answering Remove deletes the snapshot file, and
 * that was the whole memory of the decision. Anything that puts the file back
 *, a session still running on an older build rewriting its snapshot every
 * 60s, a restored backup, a synced directory, produced the same question
 * again on the next launch, and again after the next removal, with no way for
 * the user to make it stop. A decision the product forgets the instant it acts
 * on it is not a decision the user gets to make.
 *
 * So Remove now writes a record that outlives the process, and a recorded
 * snapshot found on disk again is deleted without asking. "Keep" is
 * deliberately NOT recorded here: Keep means "leave it, ask me next launch",
 * and recovery-prompt.ts's in-process set already holds it for the rest of the
 * run.
 *
 * WHERE IT LIVES, and why not under `surface.stateDir`:
 * `<homeDirectory>/.goodvibes/<surfaceRoot>/recovery-decisions.json`, home-
 * anchored, matching session-liveness-marker.ts, and deliberately NOT the
 * project-anchored `surface.stateDir`. The snapshots this defends against
 * include the ones in the SDK's legacy shared recovery directory, which is
 * itself home-anchored and shared by every project that ever used this
 * surfaceRoot; the current build dual-reads it, so ONE such snapshot is
 * offered at the launch of EVERY project. A project-scoped record could only
 * ever silence one project at a time, which is the same nag wearing a
 * different hat. Records are matched on session id alone; ids are unique, so
 * a record made in one project cannot suppress a different snapshot in
 * another. Each record still carries the workspace it was made in, so the file
 * says plainly where the decision came from.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { SessionSurface } from '@/runtime/index.ts';

/** One "the user removed this snapshot" decision. */
export interface RecoveryRemovalRecord {
  readonly sessionId: string;
  /** The project the decision was made in. Provenance, matching is on sessionId alone. */
  readonly workspace: string;
  readonly removedAt: number;
}

/**
 * Bounds on the ledger. It is append-mostly and never read by anything but
 * the boot offer, so it stays small by construction; these are the guards
 * against a pathological case, not a routine cleanup.
 *
 * Note what is deliberately NOT the pruning rule: "drop records whose snapshot
 * file no longer exists". Every record in here describes a file that was just
 * deleted, so that rule would empty the ledger immediately and reinstate the
 * exact defect it was written to fix, the point is precisely to still
 * remember once the file comes back. Age and count are the honest bounds.
 *
 * Both bounds are enforced wherever records actually leave the disk,
 * pruneRecoveryDecisions (once per boot) and recordRecoveryRemoval (every
 * write), and both DISCLOSE what they discarded. A deletion nobody reports is
 * indistinguishable from data loss, so the counts go in the log with the ledger
 * path, the TTL and the cap alongside them.
 */
const MAX_RECORDS = 200;
const RECORD_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Absolute path to this surface's removal ledger. */
export function recoveryDecisionsPathFor(surface: SessionSurface): string {
  return join(surface.homeDirectory, '.goodvibes', surface.surfaceRoot, 'recovery-decisions.json');
}

function isRecord(value: unknown): value is RecoveryRemovalRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RecoveryRemovalRecord>;
  return typeof candidate.sessionId === 'string'
    && candidate.sessionId.length > 0
    && typeof candidate.workspace === 'string'
    && typeof candidate.removedAt === 'number'
    && Number.isFinite(candidate.removedAt);
}

/** What one load of the ledger found, including everything it discarded. */
interface LedgerLoad {
  /** Records still in force, oldest first. */
  readonly kept: RecoveryRemovalRecord[];
  /** Records dropped because they aged past the TTL. */
  readonly expired: number;
  /** Entries dropped because they were not shaped like a record at all. */
  readonly malformed: number;
  /** The ledger file was present but could not be read or parsed as an array. */
  readonly unreadable: boolean;
  /** The ledger file exists on disk. */
  readonly present: boolean;
}

/**
 * Load and filter the ledger. Validation is by CONTENT, the file is parsed and
 * every entry is shape-checked, so a torn, truncated or zero-byte ledger left
 * by a crash reads as "no decisions recorded" instead of being trusted because
 * it exists. Never throws: a corrupt file must not be able to take a boot down,
 * and the worst outcome of losing it is that the user is asked once more.
 */
function loadLedger(surface: SessionSurface, nowMs: number): LedgerLoad {
  const path = recoveryDecisionsPathFor(surface);
  let present = false;
  try {
    present = existsSync(path);
    if (!present) return { kept: [], expired: 0, malformed: 0, unreadable: false, present: false };
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return { kept: [], expired: 0, malformed: 0, unreadable: true, present };
    const wellFormed = parsed.filter(isRecord);
    const kept = wellFormed.filter((record) => nowMs - record.removedAt < RECORD_TTL_MS);
    return {
      kept,
      expired: wellFormed.length - kept.length,
      malformed: parsed.length - wellFormed.length,
      unreadable: false,
      present,
    };
  } catch {
    return { kept: [], expired: 0, malformed: 0, unreadable: true, present };
  }
}

/**
 * Every removal decision still in force, oldest first. A missing, unreadable
 * or malformed ledger reads as "no decisions recorded" rather than throwing:
 * a corrupt file must not be able to take a boot down, and the worst outcome
 * of losing it is that the user is asked once more.
 *
 * This is a filtered READ, it discards nothing from disk, so it stays silent.
 * Disclosure belongs to the calls that actually delete: {@link pruneRecoveryDecisions}
 * and {@link recordRecoveryRemoval}.
 */
export function readRecoveryRemovals(surface: SessionSurface, nowMs: number = Date.now()): RecoveryRemovalRecord[] {
  return loadLedger(surface, nowMs).kept;
}

/**
 * Write `records` to the ledger through a temp file and an atomic rename.
 *
 * A plain `writeFileSync` onto the live path truncates first and fills after,
 * so a crash, or a second TUI in another terminal writing the same home-
 * anchored ledger at the same moment, could leave a half-written array that a
 * later boot reads as an empty or corrupt ledger, silently forgetting every
 * decision the user made. `rename` is atomic on the same filesystem: a reader
 * sees either the whole old ledger or the whole new one. The temp name carries
 * the pid so two writers cannot interleave into one temp file.
 */
function writeLedgerAtomically(path: string, records: readonly RecoveryRemovalRecord[]): void {
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp file is inert; a failed cleanup is not worth a second error.
    }
    throw error;
  }
}

/** What a prune pass discarded, returned so callers (and tests) can assert it. */
export interface RecoveryDecisionsPruneOutcome {
  /** Records dropped because they aged past the 90-day TTL. */
  readonly expired: number;
  /** Entries dropped because they were not shaped like a record. */
  readonly malformed: number;
  /** Records dropped because the ledger was over the 200-record cap. */
  readonly overCap: number;
  /** Records still in force after the prune. */
  readonly kept: number;
  /** The ledger file was present but unreadable or not an array. */
  readonly unreadable: boolean;
}

/**
 * Apply both bounds to the on-disk ledger and say what was discarded.
 *
 * `readRecoveryRemovals` filters in memory on every call, so the expired
 * records were already inert, but they stayed on disk until the next time the
 * user happened to answer "Remove", which on a machine where that never happens
 * again is never. This makes the reap explicit and, crucially, VISIBLE: a
 * silent deletion is indistinguishable from data loss, so every pass that drops
 * anything logs the counts and the ledger path.
 *
 * Idempotent and safe to run from two processes at once: it is a pure function
 * of the file's content plus `nowMs`, the rewrite is a temp-file-plus-rename,
 * and a second run over an already-pruned ledger drops nothing and writes
 * nothing. Best-effort, a ledger that cannot be pruned is left exactly as it
 * was and never breaks a boot.
 */
export function pruneRecoveryDecisions(surface: SessionSurface, nowMs: number = Date.now()): RecoveryDecisionsPruneOutcome {
  const path = recoveryDecisionsPathFor(surface);
  const load = loadLedger(surface, nowMs);
  const overCap = Math.max(0, load.kept.length - MAX_RECORDS);
  const bounded = load.kept.slice(-MAX_RECORDS);
  const outcome: RecoveryDecisionsPruneOutcome = {
    expired: load.expired,
    malformed: load.malformed,
    overCap,
    kept: bounded.length,
    unreadable: load.unreadable,
  };

  if (load.unreadable) {
    // Do NOT rewrite: an unreadable ledger might be a transient read failure,
    // and replacing it with `[]` would turn "could not read" into "forgot every
    // decision the user made". Say so and leave it alone.
    logger.warn('recovery decisions: ledger present but unreadable; left untouched, decisions may be re-asked', {
      ledger: path,
    });
    return outcome;
  }
  const dropped = load.expired + load.malformed + overCap;
  if (dropped === 0 || !load.present) return outcome;

  try {
    writeLedgerAtomically(path, bounded);
  } catch {
    // The in-memory filter already ignores these records; failing to persist
    // the prune costs disk space, not correctness.
    return outcome;
  }
  logger.info('recovery decisions: pruned the removal ledger', {
    ledger: path,
    expiredRecords: load.expired,
    malformedEntries: load.malformed,
    overCapRecords: overCap,
    keptRecords: bounded.length,
    ttlDays: Math.round(RECORD_TTL_MS / (24 * 60 * 60 * 1000)),
    maxRecords: MAX_RECORDS,
  });
  return outcome;
}

/**
 * Has the user already chosen Remove for this snapshot's session, in this or
 * any earlier run?
 */
export function isRecoveryRemovalRecorded(surface: SessionSurface, sessionId: string, nowMs: number = Date.now()): boolean {
  if (!sessionId.trim()) return false;
  return readRecoveryRemovals(surface, nowMs).some((record) => record.sessionId === sessionId);
}

/**
 * Record that the user chose Remove for `sessionId`. Idempotent, a repeat
 * removal of a snapshot that came back refreshes the existing record's
 * timestamp rather than adding a second one, so the ledger cannot grow by one
 * entry per reappearance.
 *
 * Best-effort: a ledger that cannot be written must not break the removal the
 * user actually asked for. The cost of a failed write is one more question on
 * a future launch, which is exactly the behaviour that shipped before this
 * file existed.
 */
export function recordRecoveryRemoval(surface: SessionSurface, sessionId: string, nowMs: number = Date.now()): void {
  if (!sessionId.trim()) return;
  const path = recoveryDecisionsPathFor(surface);
  try {
    const load = loadLedger(surface, nowMs);
    if (load.unreadable) {
      // Appending onto an unreadable ledger would rewrite it as a one-record
      // array, silently discarding whatever the user decided before. Say so
      // rather than quietly resetting their history.
      logger.warn('recovery decisions: ledger unreadable; recording this removal replaces it', {
        ledger: path,
        sessionId,
      });
    }
    const kept = load.kept.filter((record) => record.sessionId !== sessionId);
    kept.push({ sessionId, workspace: surface.workingDirectory, removedAt: nowMs });
    // Oldest decisions fall off first; the newest are the ones a reappearing
    // snapshot is most likely to match.
    const overCap = Math.max(0, kept.length - MAX_RECORDS);
    const bounded = kept.slice(-MAX_RECORDS);
    writeLedgerAtomically(path, bounded);
    // Disclosure: this write is where records actually leave the disk, so it
    // is where the counts get said out loud.
    const dropped = load.expired + load.malformed + overCap;
    if (dropped > 0) {
      logger.info('recovery decisions: dropped records while recording a removal', {
        ledger: path,
        expiredRecords: load.expired,
        malformedEntries: load.malformed,
        overCapRecords: overCap,
        keptRecords: bounded.length,
      });
    }
  } catch {
    // Best-effort by construction, see the doc comment above.
  }
}
