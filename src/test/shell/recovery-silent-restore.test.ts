/**
 * recovery-silent-restore.test.ts — the bare-launch no-auto-restore contract.
 *
 * Owner ruling: state restores happen ONLY when the user explicitly asks —
 * via a CLI argument, a slash command, or a prompt. Never automatically. The
 * old silent-restore-at-startup path (autoRestoreRecoverySession, formerly
 * called unconditionally from main.ts on every bare launch) is gone
 * entirely. A live recovery snapshot on disk is now surfaced, never
 * applied, by the boot resume notice (announceResumeState /
 * buildResumeNotice in runtime/resume-notice.ts): it prints an honest
 * one-line notice and, only when the snapshot's session id is genuinely
 * reachable via /session resume <id>, the exact command to restore it. The
 * notice never mutates the live conversation, never replays the journal, and
 * never deletes the recovery file — it only reports.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationManager } from '../../core/conversation.ts';
import { announceResumeState } from '../../runtime/resume-notice.ts';
import { checkRecoveryFile, deleteRecoveryFile, getRecoveryFilePath, writeRecoveryFile } from '@/runtime/index.ts';
import { journalPathFor, openTranscriptJournal } from '../../core/transcript-journal.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let tmpDir: string;
beforeEach(() => { tmpDir = makeProjectTempDir('gv-silent-restore-test'); });
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function writeCrash(sessionId: string, messages: Array<{ role: string; content: string }>, title: string): void {
  writeRecoveryFile(
    { messages: messages as never, title, titleSource: 'auto', timestamp: Date.now() - 5000 },
    sessionId,
    title,
    { workingDirectory: tmpDir, homeDirectory: tmpDir },
  );
}

/** Write one post-snapshot journal record for `sessionId`, mirroring what a live session would leave behind mid-turn. Returns the journal's path. */
function writeJournalRecord(sessionId: string): string {
  const journalPath = journalPathFor(tmpDir, sessionId);
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

    // The boot resume notice is the ONLY thing touching recovery state at
    // startup now; it takes no `conversation` dependency at all (see
    // ResumeNoticeDeps) — there is nothing left in the bare-launch path that
    // could apply this snapshot to a live conversation.
    await announceResumeState({
      workingDirectory: tmpDir,
      homeDirectory: tmpDir,
      surfaceRoot: 'tui',
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
    expect(existsSync(getRecoveryFilePath(tmpDir, 'sess-A'))).toBe(true);
    expect(checkRecoveryFile({ workingDirectory: tmpDir, homeDirectory: tmpDir })?.sessionId).toBe('sess-A');
  });

  test('no explicit resume intent + a recovery file present: the boot notice reports it, without a command, when its session was never fully saved', async () => {
    writeCrash('sess-A', [{ role: 'user', content: 'hi' }], 'Interrupted work');
    const receipts: string[] = [];

    await announceResumeState({
      workingDirectory: tmpDir,
      homeDirectory: tmpDir,
      surfaceRoot: 'tui',
      sessionManager: { load: () => { throw new Error('not saved'); } },
      checkpointManager: undefined,
      chainHistory: [],
      memoryAvailable: false,
      router: { high: (m) => receipts.push(m) },
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('recovery snapshot');
    // Never a fabricated restore command for a session that isn't actually loadable.
    expect(receipts[0]).not.toContain('/session resume');
  });

  test('no explicit resume intent + a recovery file whose session IS resumable: the boot notice names the exact working command', async () => {
    writeCrash('sess-B', [{ role: 'user', content: 'hi' }], 'Interrupted work');
    const receipts: string[] = [];

    await announceResumeState({
      workingDirectory: tmpDir,
      homeDirectory: tmpDir,
      surfaceRoot: 'tui',
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

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('/session resume sess-B');
  });
});

describe('concurrent-session delete isolation', () => {
  test('deleteRecoveryFile with a sessionId removes ONLY that session, leaving concurrent snapshots intact', () => {
    writeCrash('sess-A', [{ role: 'user', content: 'a' }], 'A');
    writeCrash('sess-B', [{ role: 'user', content: 'b' }], 'B');
    expect(existsSync(getRecoveryFilePath(tmpDir, 'sess-A'))).toBe(true);
    expect(existsSync(getRecoveryFilePath(tmpDir, 'sess-B'))).toBe(true);

    deleteRecoveryFile({ homeDirectory: tmpDir }, 'sess-A');

    expect(existsSync(getRecoveryFilePath(tmpDir, 'sess-A'))).toBe(false);
    // The concurrent session's snapshot must survive — the bug this fixes.
    expect(existsSync(getRecoveryFilePath(tmpDir, 'sess-B'))).toBe(true);
  });
});
