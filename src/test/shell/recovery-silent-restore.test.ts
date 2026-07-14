/**
 * recovery-silent-restore.test.ts — the silent crash-recovery restore (no
 * Ctrl+R prompt, no .preserved dance) and the concurrent-session delete
 * isolation fix.
 *
 *   • autoRestoreRecoverySession restores the newest crash snapshot in place
 *     and emits a single one-line receipt; a no-op when nothing is on disk.
 *   • deleteRecoveryFile(options, sessionId) removes ONLY that session's
 *     snapshot — one session's exit never wipes a concurrent session's.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { ConversationManager } from '../../core/conversation.ts';
import { autoRestoreRecoverySession } from '../../shell/recovery-input-helpers.ts';
import { deleteRecoveryFile, getRecoveryFilePath, writeRecoveryFile } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let tmpDir: string;
beforeEach(() => { tmpDir = makeProjectTempDir('gv-silent-restore-test'); });
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function writeCrash(sessionId: string, messages: Array<{ role: string; content: string }>, title: string): void {
  writeRecoveryFile(
    { messages: messages as never, title, titleSource: 'auto', timestamp: Date.now() - 1000 },
    sessionId,
    title,
    { workingDirectory: tmpDir, homeDirectory: tmpDir },
  );
}

describe('silent crash-recovery restore', () => {
  test('restores the snapshot in place, emits one receipt, and deletes the file', () => {
    writeCrash('sess-A', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'Interrupted work');
    const conversation = new ConversationManager(() => 80);
    const receipts: string[] = [];
    const reopened: unknown[] = [];

    const restored = autoRestoreRecoverySession({
      workingDirectory: tmpDir,
      homeDirectory: tmpDir,
      conversation,
      persistSnapshot: () => {},
      reopenPanels: (s) => { reopened.push(s); },
      systemMessageRouter: { high: (m) => receipts.push(m) },
    });

    expect(restored).toBe(true);
    expect(conversation.getMessageCount()).toBe(2);
    // Exactly one receipt line, and it is the SDK's honest "Restored ..." wording.
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('Restored an interrupted session');
    expect(receipts[0]).toContain('Interrupted work');
    // The snapshot's panels are reopened, and the file is gone (scoped delete).
    expect(reopened).toHaveLength(1);
    expect(existsSync(getRecoveryFilePath(tmpDir, 'sess-A'))).toBe(false);
  });

  test('is a silent no-op (returns false, emits nothing) when there is nothing to restore', () => {
    const conversation = new ConversationManager(() => 80);
    const receipts: string[] = [];
    const restored = autoRestoreRecoverySession({
      workingDirectory: tmpDir,
      homeDirectory: tmpDir,
      conversation,
      persistSnapshot: () => {},
      reopenPanels: () => {},
      systemMessageRouter: { high: (m) => receipts.push(m) },
    });
    expect(restored).toBe(false);
    expect(receipts).toHaveLength(0);
    expect(conversation.getMessageCount()).toBe(0);
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
