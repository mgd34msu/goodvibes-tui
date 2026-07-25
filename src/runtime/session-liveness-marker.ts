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
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Absolute path to the directory holding every session's liveness marker. */
export function livenessMarkerDirFor(surface: SessionSurface): string {
  return join(surface.homeDirectory, '.goodvibes', surface.surfaceRoot, 'liveness');
}

/** Absolute path to a session's liveness marker file. */
export function livenessMarkerPathFor(surface: SessionSurface, sessionId: string): string {
  return join(livenessMarkerDirFor(surface), `${sessionId}.json`);
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

/** Parse one marker file by absolute path. Returns null for missing, empty, torn, or wrong-shaped content. */
function parseMarkerFile(path: string): LivenessMarker | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf-8');
    // A crash between create and write leaves a zero-byte file. Content, not
    // existence, decides whether this marker says anything at all.
    if (text.trim().length === 0) return null;
    const parsed = JSON.parse(text) as Partial<LivenessMarker>;
    if (typeof parsed.sessionId !== 'string' || typeof parsed.pid !== 'number' || typeof parsed.updatedAt !== 'number') return null;
    if (!Number.isFinite(parsed.pid) || !Number.isFinite(parsed.updatedAt)) return null;
    return { sessionId: parsed.sessionId, pid: parsed.pid, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

function readLivenessMarker(surface: SessionSurface, sessionId: string): LivenessMarker | null {
  return parseMarkerFile(livenessMarkerPathFor(surface, sessionId));
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

// ─── Reaping ────────────────────────────────────────────────────────────────
//
// `removeLivenessMarker` only runs on a CLEAN exit (process-lifecycle.ts). A
// SIGKILL, a panic, or a pulled power cord leaves the marker behind forever,
// and `checkSessionLiveness` treating it as not-live does not remove the file
// — so the liveness directory grows one file per session id ever opened. The
// sweep below is the reclaim half of that lifecycle.

/**
 * Hard ceiling on marker files kept after a sweep, oldest dropped first.
 *
 * The liveness rule below already reclaims ordinary crash residue, but it can
 * be defeated: `isPidAlive` deliberately reports EPERM (a pid this user cannot
 * signal) as alive, so on a busy host a reused pid can keep a dead session's
 * marker "live" indefinitely. This cap is the second, unconditional bound so
 * the directory can never grow without limit whatever the pid probe says.
 */
export const LIVENESS_MARKER_MAX_FILES = 200;

export interface LivenessReapResult {
  /** Marker files examined this sweep. */
  readonly scanned: number;
  /** Marker files deleted this sweep. */
  readonly reaped: number;
}

export interface LivenessReapOptions {
  readonly now?: () => number;
  readonly isPidAliveFn?: typeof isPidAlive;
  /**
   * Session ids that must never be reaped regardless of what the marker says
   * — normally just the current session's id. Belt-and-braces: the current
   * session refreshes its own marker every 60s, so the liveness rule already
   * keeps it.
   */
  readonly keepSessionIds?: readonly string[];
  /** Override the count cap (tests). */
  readonly maxFiles?: number;
}

/**
 * Delete liveness markers that no longer describe a running session.
 *
 * A marker is reaped when it is either:
 *   - unreadable, empty, or not shaped like a marker (crash residue that can
 *     never resolve to a live session again — validated by parsing the
 *     content, not by the file merely existing); or
 *   - definitively not live: older than `LIVENESS_STALE_AFTER_MS` AND its pid
 *     no longer resolves to a running process.
 *
 * Both halves of that second rule are required on purpose. Deleting is
 * destructive while a liveness answer is only advisory, so a marker that is
 * stale-but-pid-alive (a wedged owner still holding the session) or
 * fresh-but-pid-dead (a process that died seconds ago, or a pid probe that
 * failed transiently) is left for a later sweep. A genuinely crashed session
 * satisfies both conditions within `LIVENESS_STALE_AFTER_MS` and is reclaimed
 * on the next sweep after that.
 *
 * Idempotent and safe to run concurrently from several processes: a marker
 * another sweeper unlinked between the directory listing and this unlink
 * (ENOENT) counts as reaped, never as an error.
 */
export function reapStaleLivenessMarkers(surface: SessionSurface, opts: LivenessReapOptions = {}): LivenessReapResult {
  const dir = livenessMarkerDirFor(surface);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    // No liveness directory yet, or it is unreadable — nothing to reclaim.
    return { scanned: 0, reaped: 0 };
  }

  const now = opts.now?.() ?? Date.now();
  const aliveCheck = opts.isPidAliveFn ?? isPidAlive;
  const keep = new Set(opts.keepSessionIds ?? []);
  const maxFiles = opts.maxFiles ?? LIVENESS_MARKER_MAX_FILES;

  let reaped = 0;
  /** Survivors, so the count cap below can drop the oldest of them. */
  const survivors: { readonly path: string; readonly updatedAt: number }[] = [];

  for (const name of names) {
    const sessionId = name.slice(0, -'.json'.length);
    if (keep.has(sessionId)) continue;
    const path = join(dir, name);
    const marker = parseMarkerFile(path);
    if (marker === null) {
      if (unlinkIfPresent(path)) reaped++;
      continue;
    }
    const stale = now - marker.updatedAt > LIVENESS_STALE_AFTER_MS;
    if (stale && !aliveCheck(marker.pid)) {
      if (unlinkIfPresent(path)) reaped++;
      continue;
    }
    survivors.push({ path, updatedAt: marker.updatedAt });
  }

  if (survivors.length > maxFiles) {
    survivors.sort((a, b) => a.updatedAt - b.updatedAt); // oldest first
    for (const victim of survivors.slice(0, survivors.length - maxFiles)) {
      if (unlinkIfPresent(victim.path)) reaped++;
    }
  }

  return { scanned: names.length, reaped };
}

/**
 * Best-effort unlink shared by the sweep. Returns true when the file is gone
 * because of (or by the time of) this call. A concurrent sweeper winning the
 * race (ENOENT) is success, not failure; any other error leaves the file for
 * the next sweep.
 */
function unlinkIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  }
}
