/**
 * recovery-silent-restore.test.ts — the bare-launch no-auto-restore contract.
 *
 * Owner ruling: state restores happen ONLY when the user explicitly asks —
 * via a CLI argument, a slash command, or a prompt. Never automatically. The
 * old silent-restore-at-startup path (autoRestoreRecoverySession, formerly
 * called unconditionally from main.ts on every bare launch) is gone entirely.
 *
 * What changed since: a live recovery snapshot used to get a passive clause
 * in the boot resume notice, which meant the only route back to a crashed
 * session was reading a sentence and retyping a command — and for a session
 * that crashed before its first clean save there was no command that reached
 * it at all. The snapshot is now an explicit ask-then-retire modal
 * (runtime/recovery-prompt.ts, covered in recovery-prompt.test.ts), and the
 * resume notice no longer mentions recovery snapshots at all — announcing the
 * same snapshot twice would be worse, not better.
 *
 * What this file still pins:
 *   - The boot notice never mutates the conversation, never replays the
 *     journal, and never deletes a recovery file. It reports; that is all.
 *   - The notice stays silent about recovery snapshots specifically, so the
 *     modal is the single place that offer is made.
 *   - Per-session delete isolation: retiring one session's snapshot leaves a
 *     concurrent session's snapshot alone.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationManager } from '../../core/conversation.ts';
import { announceResumeState } from '../../runtime/resume-notice.ts';
import { checkRecoveryFile, deleteRecoveryFile, writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { journalPathFor, openTranscriptJournal } from '../../core/transcript-journal.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ageRecoverySnapshot, makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;
beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-silent-restore-test');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function writeCrash(sessionId: string, messages: Array<{ role: string; content: string }>, title: string): void {
  writeRecoveryFile(
    { messages: messages as never, title, titleSource: 'system', timestamp: Date.now() - 5000 },
    sessionId,
    title,
    { surface },
  );
  // Aged out of the live-refresh window so the boot path sees an offerable
  // crash — the thing this file proves a bare launch does NOT restore.
  ageRecoverySnapshot(surface.recoveryFile(sessionId));
}

/** Write one post-snapshot journal record for `sessionId`, mirroring what a live session would leave behind mid-turn. Returns the journal's path. */
function writeJournalRecord(sessionId: string): string {
  const journalPath = journalPathFor(surface, sessionId);
  const dir = join(journalPath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const journal = openTranscriptJournal(journalPath, sessionId);
  journal.appendRecord('assistant_turn', [{ role: 'user', content: 'post-crash turn' }] as never);
  return journalPath;
}

describe('bare launch never restores state', () => {
  test('a live recovery file + journal on disk are left untouched: no fromJSON, no journal replay, no delete', async () => {
    writeCrash('sess-A', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'Interrupted work');
    const journalPath = writeJournalRecord('sess-A');
    const conversation = new ConversationManager(() => 80);

    // The boot resume notice takes no `conversation` dependency at all (see
    // ResumeNoticeDeps) — there is nothing in the bare-launch path that could
    // apply this snapshot to a live conversation on its own.
    await announceResumeState({
      surface,
      sessionManager: { load: () => { throw new Error('sess-A was never fully saved'); } },
      checkpointManager: undefined,
      chainHistory: [],
      memoryAvailable: false,
      router: { high: () => {} },
    });

    expect(conversation.getMessageCount()).toBe(0);
    // Journal not replayed/rotated.
    expect(existsSync(journalPath)).toBe(true);
    // Recovery file not consumed/deleted — still the newest live snapshot.
    expect(existsSync(surface.recoveryFile('sess-A'))).toBe(true);
    expect(checkRecoveryFile({ surface })?.sessionId).toBe('sess-A');
  });

  test('the boot notice says nothing about a recovery snapshot — the ask-then-retire modal owns that offer', async () => {
    writeCrash('sess-A', [{ role: 'user', content: 'hi' }], 'Interrupted work');
    const receipts: string[] = [];

    await announceResumeState({
      surface,
      sessionManager: { load: () => { throw new Error('not saved'); } },
      checkpointManager: undefined,
      chainHistory: [],
      memoryAvailable: false,
      router: { high: (m) => receipts.push(m) },
    });

    // No prior session, no checkpoints, no chain history — and a recovery
    // snapshot is no longer a reason for this notice to speak at all.
    expect(receipts).toHaveLength(0);
  });

  test('a resumable recovery snapshot does not add a clause either — no double announcement', async () => {
    writeCrash('sess-B', [{ role: 'user', content: 'hi' }], 'Interrupted work');
    const receipts: string[] = [];

    await announceResumeState({
      surface,
      sessionManager: {
        load: (id: string) => {
          if (id !== 'sess-B') throw new Error('not found');
          return { messages: [], meta: { title: 'Interrupted work', timestamp: Date.now() } } as never;
        },
      },
      checkpointManager: undefined,
      chainHistory: [],
      memoryAvailable: false,
      router: { high: (m) => receipts.push(m) },
    });

    expect(receipts.join('\n')).not.toContain('recovery');
    // And the snapshot itself is untouched by the notice.
    expect(existsSync(surface.recoveryFile('sess-B'))).toBe(true);
  });
});

describe('concurrent-session delete isolation', () => {
  test('deleteRecoveryFile with a sessionId removes ONLY that session, leaving concurrent snapshots intact', () => {
    writeCrash('sess-A', [{ role: 'user', content: 'a' }], 'A');
    writeCrash('sess-B', [{ role: 'user', content: 'b' }], 'B');
    expect(existsSync(surface.recoveryFile('sess-A'))).toBe(true);
    expect(existsSync(surface.recoveryFile('sess-B'))).toBe(true);

    deleteRecoveryFile({ surface }, 'sess-A');

    expect(existsSync(surface.recoveryFile('sess-A'))).toBe(false);
    // The concurrent session's snapshot must survive — the bug this fixes.
    expect(existsSync(surface.recoveryFile('sess-B'))).toBe(true);
  });
});
