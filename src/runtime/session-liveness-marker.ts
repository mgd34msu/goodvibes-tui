/**
 * session-liveness-marker.ts — best-effort "this session is open in another
 * terminal" signal for multi-instance safety.
 *
 * Two independent TUI instances resuming or writing recovery snapshots for
 * the SAME session can silently step on each other: one instance's periodic
 * recovery write looks, to a second instance, indistinguishable from a
 * genuine crash snapshot, and resuming a session another instance still has
 * open forks its live state without warning.
 *
 * This module writes a small marker file (session id + pid), refreshed on
 * the SAME 60s cadence as the existing recovery-file write (main.ts), so a
 * second instance can do a best-effort liveness check before either warning
 * about a stale-looking recovery snapshot or resuming a live session out
 * from under its owner.
 *
 * Every check here is best-effort by design: a missing or stale marker never
 * blocks anything — it just means "we can't tell, proceed as before". This is
 * a convenience signal, not a lock.
 *
 * Location: <homeDirectory>/.goodvibes/<surfaceRoot>/liveness/<sessionId>.json.
 * Both halves come off the caller's SessionSurface rather than being spelled
 * out here, so the markers land under the same scope as the sessions and
 * recovery snapshots they describe — mirrors the transcript-journal.ts
 * convention (homeDirectory-scoped, under the surface's own directory).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionSurface } from '@/runtime/index.ts';

export interface LivenessMarker {
  readonly sessionId: string;
  readonly pid: number;
  readonly updatedAt: number;
}

/**
 * A marker older than this is treated as stale even if its pid happens to
 * still resolve to a running process (pid reuse after a crash) — the marker
 * is refreshed every 60s (main.ts's recovery cadence), so anything past
 * ~2.5x that cadence means the writer stopped refreshing it.
 */
export const LIVENESS_STALE_AFTER_MS = 150_000;

/** Absolute path to a session's liveness marker file. */
export function livenessMarkerPathFor(surface: SessionSurface, sessionId: string): string {
  return join(surface.homeDirectory, '.goodvibes', surface.surfaceRoot, 'liveness', `${sessionId}.json`);
}

/** Refresh (creating if needed) the liveness marker for this session/pid. Best-effort — never throws. */
export function writeLivenessMarker(surface: SessionSurface, sessionId: string, pid: number = process.pid): void {
  try {
    const path = livenessMarkerPathFor(surface, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    const marker: LivenessMarker = { sessionId, pid, updatedAt: Date.now() };
    writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
  } catch {
    // Best-effort — a missed liveness refresh never blocks anything.
  }
}

/** Best-effort removal on exit. Never throws. */
export function removeLivenessMarker(surface: SessionSurface, sessionId: string): void {
  try {
    const path = livenessMarkerPathFor(surface, sessionId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort.
  }
}

function readLivenessMarker(surface: SessionSurface, sessionId: string): LivenessMarker | null {
  try {
    const path = livenessMarkerPathFor(surface, sessionId);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LivenessMarker>;
    if (typeof parsed.sessionId !== 'string' || typeof parsed.pid !== 'number' || typeof parsed.updatedAt !== 'number') return null;
    return { sessionId: parsed.sessionId, pid: parsed.pid, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

/** Best-effort check that a pid still refers to a running process. Injectable for tests. */
export function isPidAlive(pid: number, kill: (pid: number, signal: 0) => void = process.kill.bind(process)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. Any other error (e.g. EPERM — exists but this
    // process lacks permission to signal it) is treated as "still alive" —
    // best-effort here means erring toward not silently dropping a real warning.
    return (err as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

export interface SessionLivenessCheck {
  readonly live: boolean;
  readonly pid: number | null;
}

/**
 * Best-effort: is `sessionId` apparently open in another still-running
 * process right now? A missing, stale (older than LIVENESS_STALE_AFTER_MS),
 * or unreadable marker all resolve to `{ live: false, pid: null }` — never a
 * throw, never a block on the caller.
 */
export function checkSessionLiveness(
  surface: SessionSurface,
  sessionId: string,
  opts: { readonly now?: () => number; readonly isPidAliveFn?: typeof isPidAlive } = {},
): SessionLivenessCheck {
  const marker = readLivenessMarker(surface, sessionId);
  if (!marker) return { live: false, pid: null };
  const now = opts.now?.() ?? Date.now();
  if (now - marker.updatedAt > LIVENESS_STALE_AFTER_MS) return { live: false, pid: null };
  const aliveCheck = opts.isPidAliveFn ?? isPidAlive;
  if (!aliveCheck(marker.pid)) return { live: false, pid: null };
  return { live: true, pid: marker.pid };
}
