/**
 * recovery-input-helpers.test.ts — W3 Finding 3.
 *
 * main.ts's 60s autosave (writeRecoveryFile) overwrites the single shared
 * recovery.jsonl with the CURRENT session's state within a minute, so the
 * recovery banner's dismiss promise ("still on disk; you will be asked again
 * next time") silently expired. These tests cover the preserve-on-dismiss
 * mechanism: copy recovery.jsonl aside to a `.preserved` sibling, check it
 * honestly at next startup, and pick the newer of live vs. preserved.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { getRecoveryFilePath } from '@/runtime/index.ts';
import {
  checkPreservedRecoveryFile,
  createPreserveRecoveryFile,
  deletePreservedRecoveryFile,
  loadPreservedRecoveryConversation,
  pickNewestRecoveryInfo,
} from '../../shell/recovery-input-helpers.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function writeLiveRecoveryFile(homeDirectory: string, meta: { title: string; timestamp: number; sessionId: string }, messages: Array<Record<string, unknown>> = [{ role: 'user', content: 'hi' }]): void {
  const path = getRecoveryFilePath(homeDirectory);
  mkdirSync(dirname(path), { recursive: true });
  const lines = [JSON.stringify({ type: 'meta', ...meta }), ...messages.map((m) => JSON.stringify({ type: 'message', ...m }))];
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

describe('recovery-input-helpers — preserve-on-dismiss (W3 Finding 3)', () => {
  test('createPreserveRecoveryFile copies the live file aside; no-op when nothing live', () => {
    const dir = makeProjectTempDir('gv-recovery-preserve');
    try {
      const preserve = createPreserveRecoveryFile({ homeDirectory: dir });

      // Nothing live yet.
      expect(preserve()).toEqual({ preserved: false, replacedPrevious: false });
      expect(existsSync(`${getRecoveryFilePath(dir)}.preserved`)).toBe(false);

      writeLiveRecoveryFile(dir, { title: 'Session A', timestamp: 1000, sessionId: 'a' });
      const result = preserve();
      expect(result).toEqual({ preserved: true, replacedPrevious: false });
      expect(existsSync(`${getRecoveryFilePath(dir)}.preserved`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a second dismiss replaces the preserved file and reports it honestly', () => {
    const dir = makeProjectTempDir('gv-recovery-preserve-replace');
    try {
      const preserve = createPreserveRecoveryFile({ homeDirectory: dir });

      writeLiveRecoveryFile(dir, { title: 'Session A', timestamp: 1000, sessionId: 'a' });
      expect(preserve()).toEqual({ preserved: true, replacedPrevious: false });

      // A later session's dismiss overwrites the live file, then dismisses again.
      writeLiveRecoveryFile(dir, { title: 'Session B', timestamp: 2000, sessionId: 'b' });
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
      const live = getRecoveryFilePath(dir);
      mkdirSync(dirname(live), { recursive: true });
      const lines = [
        JSON.stringify({ type: 'meta', sessionId: 'a', title: 'My Session', timestamp: 1000, titleSource: 'user' }),
        JSON.stringify({ type: 'message', role: 'user', content: 'hello' }),
      ];
      writeFileSync(live, lines.join('\n') + '\n', 'utf-8');

      const preserve = createPreserveRecoveryFile({ homeDirectory: dir });
      preserve();

      const snapshot = loadPreservedRecoveryConversation({ homeDirectory: dir });
      expect(snapshot?.title).toBe('My Session');
      expect(snapshot?.titleSource).toBe('user');
      expect(snapshot?.messages).toEqual([{ role: 'user', content: 'hello' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deletePreservedRecoveryFile removes it; missing file is a silent no-op', () => {
    const dir = makeProjectTempDir('gv-recovery-preserve-delete');
    try {
      writeLiveRecoveryFile(dir, { title: 'Session A', timestamp: 1000, sessionId: 'a' });
      const preserve = createPreserveRecoveryFile({ homeDirectory: dir });
      preserve();
      const preservedPath = `${getRecoveryFilePath(dir)}.preserved`;
      expect(existsSync(preservedPath)).toBe(true);

      deletePreservedRecoveryFile({ homeDirectory: dir });
      expect(existsSync(preservedPath)).toBe(false);

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
    // preserved is newer here.
    expect(pickNewestRecoveryInfo(live, preserved)).toEqual({ ...preserved, source: 'preserved' });
    // live is newer here.
    expect(pickNewestRecoveryInfo(preserved, live)).toEqual({ ...preserved, source: 'live' });
  });
});
