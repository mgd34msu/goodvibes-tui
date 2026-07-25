// ---------------------------------------------------------------------------
// workstream-draft-store.ts — durable journal for not-yet-launched proposals
//
// A /workstream proposal (WorkstreamDraft, workstream-services.ts) is TUI-owned
// state the OrchestrationEngine has no concept of — its only creation entry
// point materializes a real, ticking workstream with no pre-launch "draft"
// stage (see that module's REALITY-WINS header). Earlier waves therefore held
// drafts in memory only, and a restart between create and launch silently lost
// them. This store journals each draft to disk so the plan-review gate survives
// a restart and is resumable: the same reshaped, approved proposal is still
// there to launch afterward.
//
// This is TUI-side persistence, NOT an engine feature — it sits ALONGSIDE the
// engine's own .goodvibes/orchestration/<id>.json workstream snapshots, under a
// drafts/ subdirectory, and is loaded by the command facade at construction the
// same way the engine's resumeAllFromDisk() reloads live workstreams. A draft
// is a pure-data object (id/task/spec/gate/proposal/provenance/approved), so a
// plain JSON round-trip is lossless.
//
// Every operation is guarded and NEVER throws: a missing directory, an
// unreadable or malformed file, or a write failure degrades to "that draft
// isn't there" rather than crashing session startup — mirroring the engine
// persistence layer's own quarantine-don't-propagate discipline.
//
// RECLAIM: `remove(id)` retires a draft the moment it is launched or cancelled,
// but a draft the user simply walks away from was never reclaimed by anything,
// so the directory grew forever. `loadAll()` — the recovery point, called once
// at command-facade construction — now also bounds the directory by BOTH an age
// TTL and a count cap, and reports what it reclaimed through `lastReclaim` /
// the `onReclaim` hook. Deletions are `rmSync(..., { force: true })`, so a file
// another process removed first is not an error: two concurrent `loadAll()`
// calls converge on the same surviving set.
// ---------------------------------------------------------------------------

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '@/config/atomic-write.ts';
import type { WorkstreamDraft } from './workstream-draft-types.ts';

/**
 * Age TTL for an abandoned draft. A proposal that has sat un-launched and
 * un-cancelled this long is not a plan the user is still reviewing; it is
 * litter. Measured from the draft's own `createdAt`.
 */
export const WORKSTREAM_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Count cap on retained drafts: the newest this many survive, older ones are
 * reclaimed oldest-first. Bounds the directory even if every draft is recent.
 */
export const WORKSTREAM_DRAFT_CAP = 50;

/**
 * Minimum gap between reaps triggered by `save()`. `loadAll()` is the recovery
 * point but runs once per session, so a session that stays open for days would
 * otherwise never reap again. Every `save()` (draft created, reshaped, or
 * approved) re-checks the bounds, throttled to this interval so the directory
 * is not re-scanned on every keystroke-driven save.
 */
export const WORKSTREAM_DRAFT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** What one `loadAll()` reclaimed. Counts only — never draft text. */
export interface WorkstreamDraftReclaim {
  /** Unix ms of the sweep. */
  readonly at: number;
  /** Valid drafts removed because they aged past the TTL. */
  readonly expired: number;
  /** Valid drafts removed because they fell outside the count cap. */
  readonly overCap: number;
  /** Torn/malformed snapshots removed once they were older than the TTL. */
  readonly unreadable: number;
}

export interface WorkstreamDraftStoreOptions {
  /**
   * Called after a `loadAll()` that reclaimed at least one file, so the count
   * can be surfaced to the operator. Receives counts only. Never throws out of
   * `loadAll()` — a failing hook is swallowed like every other side effect here.
   */
  readonly onReclaim?: (summary: WorkstreamDraftReclaim) => void;
  /** Clock seam (tests). Defaults to Date.now. */
  readonly now?: () => number;
  /** Override the age TTL (tests / embedders). Defaults to WORKSTREAM_DRAFT_TTL_MS. */
  readonly ttlMs?: number;
  /** Override the count cap (tests / embedders). Defaults to WORKSTREAM_DRAFT_CAP. */
  readonly cap?: number;
  /**
   * Throttle for the reap that `save()` triggers. 0 or less means every save
   * reaps (tests); defaults to WORKSTREAM_DRAFT_SWEEP_INTERVAL_MS.
   */
  readonly sweepIntervalMs?: number;
}

export interface WorkstreamDraftStore {
  /**
   * Every valid draft on disk, oldest first, after reaping abandoned ones. A
   * directory that doesn't exist yet ⇒ []. Malformed files are skipped, never
   * fatal, and are only deleted once older than the TTL.
   */
  loadAll(): WorkstreamDraft[];
  /** Write (or overwrite) one draft's snapshot atomically. Silently no-ops on any I/O failure — a lost journal write must never break the in-memory flow. */
  save(draft: WorkstreamDraft): void;
  /** Delete one draft's snapshot (on launch or cancel). Missing file ⇒ no-op. */
  remove(id: string): void;
  /** Summary of the most recent `loadAll()` that reclaimed something; null otherwise. */
  readonly lastReclaim: WorkstreamDraftReclaim | null;
}

/** Human-readable, content-free disclosure line for a reclaim summary. */
export function formatWorkstreamDraftReclaim(summary: WorkstreamDraftReclaim): string {
  const parts: string[] = [];
  if (summary.expired > 0) parts.push(`${summary.expired} abandoned`);
  if (summary.overCap > 0) parts.push(`${summary.overCap} over the retention cap`);
  if (summary.unreadable > 0) parts.push(`${summary.unreadable} unreadable`);
  if (parts.length === 0) return 'Workstream drafts: nothing reclaimed.';
  return `Workstream drafts: reclaimed ${parts.join(', ')} draft file(s).`;
}

/** Draft ids are `wsd_<hex>`; this refuses anything else so a crafted id can never escape the drafts directory. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function isDraftShape(value: unknown): value is WorkstreamDraft {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === 'string'
    && typeof d.task === 'string'
    && typeof d.approved === 'boolean'
    && typeof d.createdAt === 'number'
    && typeof d.spec === 'object' && d.spec !== null
    && Array.isArray((d.spec as Record<string, unknown>).items)
  );
}

export function createWorkstreamDraftStore(
  projectRoot: string,
  options: WorkstreamDraftStoreOptions = {},
): WorkstreamDraftStore {
  const dir = join(projectRoot, '.goodvibes', 'orchestration', 'drafts');
  const fileFor = (id: string): string => join(dir, `${id}.json`);
  const clock = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? WORKSTREAM_DRAFT_TTL_MS;
  const cap = options.cap ?? WORKSTREAM_DRAFT_CAP;
  const sweepIntervalMs = options.sweepIntervalMs ?? WORKSTREAM_DRAFT_SWEEP_INTERVAL_MS;
  let lastReclaim: WorkstreamDraftReclaim | null = null;
  /** Unix ms of this instance's last reap; 0 means "never", so the first save sweeps. */
  let lastSweepAt = 0;

  /** Delete one path, treating "already gone" as success (concurrent sweeps). */
  const discard = (path: string): void => {
    try {
      rmSync(path, { force: true });
    } catch {
      // Unremovable (permissions, or a racing process holding it) — the next
      // loadAll() will try again; never fatal.
    }
  };

  /** Age of a file by mtime, used only for snapshots whose contents we cannot trust. */
  const modifiedBefore = (path: string, cutoff: number): boolean => {
    try {
      return statSync(path).mtimeMs < cutoff;
    } catch {
      return false;
    }
  };

  /**
   * Read every snapshot, reject the ones whose CONTENT is not a draft, apply
   * both bounds, and record/announce what was reclaimed. Returns the surviving
   * drafts, oldest first. Never throws.
   *
   * Idempotent: a second run over the same directory finds nothing left to
   * remove, which is also what makes two processes running it at once safe —
   * they converge on the same surviving set and unlink races count as done.
   */
  const reap = (): WorkstreamDraft[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      lastReclaim = null;
      return []; // directory not created yet, or unreadable — nothing to resume
    }
    const now = clock();
    lastSweepAt = now;
    const cutoff = now - ttlMs;
    const drafts: WorkstreamDraft[] = [];
    let unreadable = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        parsed = undefined;
      }
      // Validation is by CONTENT: a torn or half-written snapshot never
      // becomes a draft. It is only DELETED once it is older than the TTL, so
      // a file another process is writing right now is left alone.
      if (parsed !== undefined && isDraftShape(parsed) && isSafeId(parsed.id)) {
        drafts.push(parsed);
        continue;
      }
      if (modifiedBefore(path, cutoff)) {
        discard(path);
        unreadable += 1;
      }
    }
    drafts.sort((a, b) => a.createdAt - b.createdAt);

    // Bound 1 — age TTL: an abandoned proposal is reclaimed.
    const live: WorkstreamDraft[] = [];
    let expired = 0;
    for (const draft of drafts) {
      if (now - draft.createdAt > ttlMs) {
        discard(fileFor(draft.id));
        expired += 1;
        continue;
      }
      live.push(draft);
    }
    // Bound 2 — count cap: keep the newest `cap`, reclaim the oldest overflow.
    const overCapCount = Math.max(0, live.length - cap);
    for (const draft of live.slice(0, overCapCount)) discard(fileFor(draft.id));
    const kept = live.slice(overCapCount);

    if (expired + overCapCount + unreadable > 0) {
      lastReclaim = { at: now, expired, overCap: overCapCount, unreadable };
      try {
        options.onReclaim?.(lastReclaim);
      } catch {
        // Disclosure must never take startup down.
      }
    } else {
      lastReclaim = null;
    }
    return kept;
  };

  return {
    get lastReclaim(): WorkstreamDraftReclaim | null {
      return lastReclaim;
    },
    loadAll(): WorkstreamDraft[] {
      return reap();
    },
    save(draft: WorkstreamDraft): void {
      if (!isSafeId(draft.id)) return;
      try {
        mkdirSync(dir, { recursive: true });
        // Atomic (temp + fsync + rename): a crash mid-save can no longer leave a
        // truncated snapshot behind for loadAll() to reject.
        atomicWriteFileSync(fileFor(draft.id), JSON.stringify(draft));
      } catch {
        // A failed journal write leaves the in-memory draft intact and usable;
        // only its restart-durability is lost, which is strictly better than
        // failing the edit the user just made.
      }
      // Keep reaping DURING the session, not only at the loadAll() recovery
      // point: loadAll runs once at construction, so a long-lived session would
      // otherwise never bound the directory again. Throttled, and always after
      // this draft is on disk so the newest file is never the one reclaimed.
      if (clock() - lastSweepAt >= sweepIntervalMs) reap();
    },
    remove(id: string): void {
      if (!isSafeId(id)) return;
      discard(fileFor(id));
    },
  };
}
