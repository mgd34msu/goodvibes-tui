/**
 * recovery-input-helpers.test.ts — preserve-on-dismiss.
 *
 * The SDK now keeps per-session crash snapshots (recovery-<sessionId>.jsonl), so
 * this session's autosave no longer clobbers a crashed session's file. But
 * checkRecoveryFile only offers a snapshot newer than the last clean save, so a
 * dismissed crash snapshot would stop being offered once this session saves.
 * These tests cover the preserve-on-dismiss mechanism: on dismiss, copy the
 * dismissed session's crash file (resolved via checkRecoveryFile) aside to a
 * single fixed preserved sibling, check it at next startup, and pick the newer
 * of live vs. preserved.
 */
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { writeRecoveryFile } from '@/runtime/index.ts';
import {
  checkPreservedRecoveryFile,
  createPreserveRecoveryFile,
  deletePreservedRecoveryFile,
  loadPreservedRecoveryConversation,
  pickNewestRecoveryInfo,
} from '../../shell/recovery-input-helpers.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** Write a per-session crash-recovery snapshot the way the live autosave does. */
function writeCrash(dir: string, sessionId: string, title: string, timestamp: number, titleSource?: 'user' | 'system'): void {
  writeRecoveryFile(
    { messages: [{ role: 'user', content: 'hi' }], timestamp, title, ...(titleSource ? { titleSource } : {}) },
    sessionId,
    title,
    { workingDirectory: dir, homeDirectory: dir },
  );
}

describe('recovery-input-helpers — preserve-on-dismiss', () => {
  test('createPreserveRecoveryFile copies the dismissed session file aside; no-op when nothing live', () => {
    const dir = makeProjectTempDir('gv-recovery-preserve');
    try {
      const preserve = createPreserveRecoveryFile({ homeDirectory: dir, workingDirectory: dir });

      // Nothing live yet — checkRecoveryFile finds no crash snapshot.
      expect(preserve()).toEqual({ preserved: false, replacedPrevious: false });
      expect(checkPreservedRecoveryFile({ homeDirectory: dir })).toBeNull();

      writeCrash(dir, 'a', 'Session A', 1000);
      const result = preserve();
      expect(result).toEqual({ preserved: true, replacedPrevious: false });
      expect(checkPreservedRecoveryFile({ homeDirectory: dir })?.sessionId).toBe('a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a second dismiss replaces the preserved file and reports it honestly', () => {
    const dir = makeProjectTempDir('gv-recovery-preserve-replace');
    try {
      const preserve = createPreserveRecoveryFile({ homeDirectory: dir, workingDirectory: dir });

      writeCrash(dir, 'a', 'Session A', 1000);
      expect(preserve()).toEqual({ preserved: true, replacedPrevious: false });

      // A later session crashes (newer); checkRecoveryFile now offers B, so the
      // second dismiss preserves B, replacing the earlier preserved sibling.
      writeCrash(dir, 'b', 'Session B', 2000);
      expect(preserve()).toEqual({ preserved: true, replacedPrevious: true });

      // Bounded to exactly one preserved file, holding the newest dismiss.
      const info = checkPreservedRecoveryFile({ homeDirectory: dir });
      expect(info?.sessionId).toBe('b');
      expect(info?.title).toBe('Session B');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkPreservedRecoveryFile is null when no preserved file exists', () => {
    const dir = makeProjectTempDir('gv-recovery-preserve-none');
    try {
      expect(checkPreservedRecoveryFile({ homeDirectory: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadPreservedRecoveryConversation round-trips messages, title, and titleSource', () => {
    const dir = makeProjectTempDir('gv-recovery-preserve-load');
    try {
      writeCrash(dir, 'a', 'My Session', 1000, 'user');
      createPreserveRecoveryFile({ homeDirectory: dir, workingDirectory: dir })();

      const snapshot = loadPreservedRecoveryConversation({ homeDirectory: dir });
      expect(snapshot?.title).toBe('My Session');
      expect(snapshot?.titleSource).toBe('user');
      expect(snapshot?.messages).toEqual([{ role: 'user', content: 'hi' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deletePreservedRecoveryFile removes it; missing file is a silent no-op', () => {
    const dir = makeProjectTempDir('gv-recovery-preserve-delete');
    try {
      writeCrash(dir, 'a', 'Session A', 1000);
      createPreserveRecoveryFile({ homeDirectory: dir, workingDirectory: dir })();
      expect(checkPreservedRecoveryFile({ homeDirectory: dir })).not.toBeNull();

      deletePreservedRecoveryFile({ homeDirectory: dir });
      expect(checkPreservedRecoveryFile({ homeDirectory: dir })).toBeNull();

      // Deleting again (nothing there) must not throw.
      expect(() => deletePreservedRecoveryFile({ homeDirectory: dir })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('pickNewestRecoveryInfo: null when neither exists; tags the source of whichever is picked', () => {
    const live = { title: 'live', timestamp: 1000, sessionId: 'l' };
    const preserved = { title: 'preserved', timestamp: 2000, sessionId: 'p' };

    expect(pickNewestRecoveryInfo(null, null)).toBeNull();
    expect(pickNewestRecoveryInfo(live, null)).toEqual({ ...live, source: 'live' });
    expect(pickNewestRecoveryInfo(null, preserved)).toEqual({ ...preserved, source: 'preserved' });
    expect(pickNewestRecoveryInfo(live, preserved)).toEqual({ ...preserved, source: 'preserved' });
    expect(pickNewestRecoveryInfo(preserved, live)).toEqual({ ...preserved, source: 'live' });
  });
});
