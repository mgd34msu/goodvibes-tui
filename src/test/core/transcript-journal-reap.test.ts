/**
 * Tests for the transcript journal's crash-residue handling:
 *
 *   - reapOrphanedJournals — a session that crashes and is never resumed never
 *     reaches rotate(), so before this sweep existed its journal stayed on disk
 *     permanently.
 *   - the zero-byte-journal header fix — a crash between creating the journal
 *     file and writing its header used to leave a file that an existence-only
 *     check treated as already initialised, so every later record landed in a
 *     header-less file that the next replay quarantined wholesale.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import {
  JOURNAL_ORPHAN_MAX_AGE_MS,
  journalPathFor,
  openTranscriptJournal,
  reapOrphanedJournals,
  replayJournal,
} from '../../core/transcript-journal.ts';

let tmpHome: string;
let surface: SessionSurface;
let journalDir: string;

const NOW = 1_800_000_000_000;
const neverLive = () => false;

beforeEach(() => {
  tmpHome = makeProjectTempDir('gv-journal-reap');
  surface = makeTestSurface(tmpHome);
  journalDir = join(tmpHome, '.goodvibes', 'tui');
  mkdirSync(journalDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

/** Write a journal for `sessionId` and stamp its mtime `ageMs` in the past. */
function putJournal(sessionId: string, ageMs: number, body = '{"version":1,"sessionId":"x","createdAt":1}\n'): string {
  const path = journalPathFor(surface, sessionId);
  writeFileSync(path, body);
  const at = new Date(NOW - ageMs);
  utimesSync(path, at, at);
  return path;
}

describe('reapOrphanedJournals', () => {
  test('an orphaned journal is reaped while the current session journal survives', () => {
    const orphan = putJournal('abandoned-session', JOURNAL_ORPHAN_MAX_AGE_MS + 60_000);
    const current = putJournal('current-session', JOURNAL_ORPHAN_MAX_AGE_MS + 60_000);

    const result = reapOrphanedJournals(surface, {
      now: () => NOW,
      isSessionLive: neverLive,
      currentSessionId: 'current-session',
    });

    expect(result.scanned).toBe(2);
    expect(result.reaped).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(current)).toBe(true);
  });

  test('a journal whose session is open in another running instance survives regardless of age', () => {
    const path = putJournal('open-elsewhere', JOURNAL_ORPHAN_MAX_AGE_MS * 10);

    const result = reapOrphanedJournals(surface, {
      now: () => NOW,
      isSessionLive: (id) => id === 'open-elsewhere',
    });

    expect(result.reaped).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('a journal inside the age window is kept', () => {
    const path = putJournal('recent-crash', 60_000);
    expect(reapOrphanedJournals(surface, { now: () => NOW, isSessionLive: neverLive }).reaped).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('a torn tail does NOT make a recent journal reapable — an unparseable tail is what replay salvages', () => {
    const path = putJournal(
      'torn-tail',
      60_000,
      '{"version":1,"sessionId":"torn-tail","createdAt":1}\n' +
        '{"type":"user_message","seq":0,"ts":5,"messages":[]}\n' +
        '{"type":"assistant_turn","seq":1,"ts":6,"mess', // killed mid-append
    );

    const result = reapOrphanedJournals(surface, { now: () => NOW, isSessionLive: neverLive });

    expect(result.reaped).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('a zero-byte journal for a dead session is reaped immediately — it holds no records to lose', () => {
    const path = putJournal('empty-journal', 1_000, '');
    const result = reapOrphanedJournals(surface, { now: () => NOW, isSessionLive: neverLive });
    expect(result.reaped).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test('a zero-byte journal for the CURRENT session is never reaped', () => {
    const path = putJournal('mine', 1_000, '');
    const result = reapOrphanedJournals(surface, { now: () => NOW, isSessionLive: neverLive, currentSessionId: 'mine' });
    expect(result.reaped).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('the count cap bounds a burst of crashes that all land inside the age window', () => {
    for (let i = 0; i < 5; i++) putJournal(`burst-${i}`, i * 1_000 + 1_000);

    const result = reapOrphanedJournals(surface, { now: () => NOW, isSessionLive: neverLive, maxFiles: 2 });

    expect(result.reaped).toBe(3);
    const left = readdirSync(journalDir).filter((n) => n.endsWith('.journal')).sort();
    // The two most recently written survive.
    expect(left).toEqual(['transcript-burst-0.journal', 'transcript-burst-1.journal']);
  });

  test('reaping twice in a row is a no-op the second time', () => {
    putJournal('gone-a', JOURNAL_ORPHAN_MAX_AGE_MS + 1);
    putJournal('gone-b', JOURNAL_ORPHAN_MAX_AGE_MS + 1);

    const first = reapOrphanedJournals(surface, { now: () => NOW, isSessionLive: neverLive });
    const second = reapOrphanedJournals(surface, { now: () => NOW, isSessionLive: neverLive });

    expect(first.reaped).toBe(2);
    expect(second).toEqual({ scanned: 0, reaped: 0 });
  });

  test('a journal deleted by another sweeper between the listing and the stat is not an error', () => {
    const path = putJournal('raced', JOURNAL_ORPHAN_MAX_AGE_MS + 1);

    let result: { scanned: number; reaped: number } | null = null;
    expect(() => {
      result = reapOrphanedJournals(surface, {
        now: () => NOW,
        // Stand in for a second instance winning the race: the file is gone
        // before this sweep gets to look at it.
        isSessionLive: () => {
          if (existsSync(path)) unlinkSync(path);
          return false;
        },
      });
    }).not.toThrow();

    expect(result).not.toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test('a missing surface directory reclaims nothing and never throws', () => {
    const emptySurface = makeTestSurface(join(tmpHome, 'no-such-home'));
    expect(reapOrphanedJournals(emptySurface, { isSessionLive: neverLive })).toEqual({ scanned: 0, reaped: 0 });
  });

  test('files that are not transcript journals are ignored', () => {
    const stray = join(journalDir, 'recovery-something.jsonl');
    writeFileSync(stray, 'keep me');
    const result = reapOrphanedJournals(surface, { now: () => NOW, isSessionLive: neverLive });
    expect(result.scanned).toBe(0);
    expect(existsSync(stray)).toBe(true);
  });
});

describe('journal initialisation validates by content, not by existence', () => {
  test('a zero-byte journal left by a crash gets a fresh header instead of header-less records', () => {
    const path = journalPathFor(surface, 'crashed-before-header');
    writeFileSync(path, ''); // created, then killed before the header landed

    const journal = openTranscriptJournal(path, 'crashed-before-header');
    journal.appendRecord('user_message', []);

    const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).version).toBe(1);
    expect(JSON.parse(lines[1]).type).toBe('user_message');
  });

  test('records appended after a zero-byte crash replay instead of being quarantined wholesale', () => {
    const path = journalPathFor(surface, 'recoverable');
    writeFileSync(path, '');

    const journal = openTranscriptJournal(path, 'recoverable');
    journal.appendRecord('user_message', []);

    const replay = replayJournal(path, 0);
    expect(replay.hadCorruptTail).toBe(false);
    expect(replay.records).toHaveLength(1);
    expect(existsSync(`${path}.unrecognized`)).toBe(false);
  });
});
