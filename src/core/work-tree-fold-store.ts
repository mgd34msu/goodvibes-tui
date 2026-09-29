/**
 * work-tree-fold-store.ts, the work tree's fold state, kept per session.
 *
 * Which turns are folded, which agent lanes are folded, which beads are open
 * and which opened bodies show everything: kept beside the session file as
 * `<stem>.work-tree.json` (the same stem rule the session file uses, see
 * sanitizeSessionName), so reopening a session keeps the view.
 *
 * Bounded (the most recent MAX_KEYS decisions), validated on load (anything
 * that is not a known key shape with a boolean value is dropped), written
 * atomically (temp file + rename), and swept: a sidecar whose session file is
 * gone is removed by sweepOrphanWorkTreeFolds.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeSessionName } from '@pellux/goodvibes-sdk/platform/sessions';

const SUFFIX = '.work-tree.json';
const VERSION = 1;
/** Most fold decisions kept per session. */
export const MAX_FOLD_KEYS = 2000;
/** A staging file older than this is crash residue. */
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Collapse keys the work tree owns (work-tree-model.ts). */
const KEY_SHAPE = /^(turn_\d+|bead_[\w:./-]+|beadmore_[\w:./-]+|lane_[\w:./-]+)$/;

export function isWorkTreeFoldKey(key: string): boolean {
  return KEY_SHAPE.test(key);
}

function sidecarPath(sessionsDir: string, sessionId: string): string | null {
  if (!sessionsDir || !sessionId) return null;
  const stem = sanitizeSessionName(sessionId);
  if (stem === '') return null;
  return join(sessionsDir, `${stem}${SUFFIX}`);
}

/** Keep only work-tree keys with boolean values, the most recent MAX_FOLD_KEYS. */
export function boundFoldState(entries: Iterable<readonly [string, unknown]>): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  for (const [key, value] of entries) if (typeof value === 'boolean' && isWorkTreeFoldKey(key)) out.push([key, value]);
  return out.length > MAX_FOLD_KEYS ? out.slice(out.length - MAX_FOLD_KEYS) : out;
}

/** Write the session's fold state. Best effort: a failed write never breaks the session. */
export function saveWorkTreeFolds(sessionsDir: string, sessionId: string, state: Iterable<readonly [string, boolean]>): void {
  const path = sidecarPath(sessionsDir, sessionId);
  if (!path) return;
  try {
    mkdirSync(sessionsDir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: VERSION, sessionId, folds: Object.fromEntries(boundFoldState(state)) }));
    renameSync(tmp, path);
  } catch {
    // best effort; the view falls back to defaults on the next resume
  }
}

/** Read the session's fold state; an absent or unreadable sidecar reads as empty. */
export function loadWorkTreeFolds(sessionsDir: string, sessionId: string): Array<[string, boolean]> {
  const path = sidecarPath(sessionsDir, sessionId);
  if (!path || !existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return [];
    const folds = (parsed as { folds?: unknown }).folds;
    if (!folds || typeof folds !== 'object' || Array.isArray(folds)) return [];
    return boundFoldState(Object.entries(folds as Record<string, unknown>));
  } catch {
    return [];
  }
}

/**
 * Remove fold sidecars whose session file no longer exists, and staging files
 * a crash left behind. Returns how many files were removed.
 */
export function sweepOrphanWorkTreeFolds(sessionsDir: string, now = Date.now()): number {
  if (!sessionsDir || !existsSync(sessionsDir)) return 0;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return 0;
  }
  const present = new Set(names);
  for (const name of names) {
    try {
      if (name.includes(`${SUFFIX}.tmp-`)) {
        if (now - statSync(join(sessionsDir, name)).mtimeMs > TMP_MAX_AGE_MS) { unlinkSync(join(sessionsDir, name)); removed++; }
        continue;
      }
      if (!name.endsWith(SUFFIX)) continue;
      const stem = name.slice(0, -SUFFIX.length);
      // Settled for an hour first: a session folds things before its first save writes the session file.
      if (!present.has(`${stem}.jsonl`) && now - statSync(join(sessionsDir, name)).mtimeMs > TMP_MAX_AGE_MS) {
        unlinkSync(join(sessionsDir, name));
        removed++;
      }
    } catch {
      // a file that vanished or cannot be removed is left for the next sweep
    }
  }
  return removed;
}
