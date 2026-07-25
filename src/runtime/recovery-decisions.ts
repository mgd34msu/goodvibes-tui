/**
 * recovery-decisions.ts — a durable record of the recovery snapshots the user
 * has already said "Remove" to.
 *
 * The defect this exists for: answering Remove deletes the snapshot file, and
 * that was the whole memory of the decision. Anything that puts the file back
 * — a session still running on an older build rewriting its snapshot every
 * 60s, a restored backup, a synced directory — produced the same question
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
 * `<homeDirectory>/.goodvibes/<surfaceRoot>/recovery-decisions.json` — home-
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionSurface } from '@/runtime/index.ts';

/** One "the user removed this snapshot" decision. */
export interface RecoveryRemovalRecord {
  readonly sessionId: string;
  /** The project the decision was made in. Provenance — matching is on sessionId alone. */
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
 * exact defect it was written to fix — the point is precisely to still
 * remember once the file comes back. Age and count are the honest bounds.
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

/**
 * Every removal decision still in force, oldest first. A missing, unreadable
 * or malformed ledger reads as "no decisions recorded" rather than throwing:
 * a corrupt file must not be able to take a boot down, and the worst outcome
 * of losing it is that the user is asked once more.
 */
export function readRecoveryRemovals(surface: SessionSurface, nowMs: number = Date.now()): RecoveryRemovalRecord[] {
  try {
    const path = recoveryDecisionsPathFor(surface);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).filter((record) => nowMs - record.removedAt < RECORD_TTL_MS);
  } catch {
    return [];
  }
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
 * Record that the user chose Remove for `sessionId`. Idempotent — a repeat
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
  try {
    const kept = readRecoveryRemovals(surface, nowMs).filter((record) => record.sessionId !== sessionId);
    kept.push({ sessionId, workspace: surface.workingDirectory, removedAt: nowMs });
    // Oldest decisions fall off first; the newest are the ones a reappearing
    // snapshot is most likely to match.
    const bounded = kept.slice(-MAX_RECORDS);
    const path = recoveryDecisionsPathFor(surface);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(bounded, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Best-effort by construction — see the doc comment above.
  }
}
