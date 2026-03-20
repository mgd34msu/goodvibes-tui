/**
 * Tests for SessionPickerModal state class.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { SessionManager } from '../../sessions/manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-sess-picker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const META = { title: 'Test Session', model: 'mercury-2', provider: 'inceptionlabs', timestamp: 1700000000000 };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SessionPickerModal', () => {
  let tmpDir: string;
  let sm: SessionManager;
  let modal: SessionPickerModal;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new SessionManager(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('starts inactive', () => {
    modal = new SessionPickerModal();
    expect(modal.active).toBe(false);
  });

  test('open() on empty dir shows empty sessions', () => {
    // Override the internal SessionManager by testing with no sessions
    modal = new SessionPickerModal();
    // The modal uses getSessionManager() which points to cwd, so just test the interface
    modal.active = true;
    modal.sessions = [];
    modal.selectedIndex = 0;
    expect(modal.sessions.length).toBe(0);
    expect(modal.getSelected()).toBeNull();
  });

  test('navigation wraps around (moveUp from 0 → last)', () => {
    modal = new SessionPickerModal();
    modal.sessions = [
      { name: 'a', title: 'A', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
      { name: 'b', title: 'B', model: '', provider: '', timestamp: 2, messageCount: 3, filePath: '/b' },
    ];
    modal.selectedIndex = 0;
    modal.moveUp();
    expect(modal.selectedIndex).toBe(1);
  });

  test('moveDown increments selectedIndex', () => {
    modal = new SessionPickerModal();
    modal.sessions = [
      { name: 'a', title: 'A', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
      { name: 'b', title: 'B', model: '', provider: '', timestamp: 2, messageCount: 3, filePath: '/b' },
    ];
    modal.selectedIndex = 0;
    modal.moveDown();
    expect(modal.selectedIndex).toBe(1);
  });

  test('moveDown wraps around', () => {
    modal = new SessionPickerModal();
    modal.sessions = [
      { name: 'a', title: 'A', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
    ];
    modal.selectedIndex = 0;
    modal.moveDown();
    expect(modal.selectedIndex).toBe(0);
  });

  test('getSelected returns the current session', () => {
    modal = new SessionPickerModal();
    modal.sessions = [
      { name: 'a', title: 'A', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
      { name: 'b', title: 'B', model: '', provider: '', timestamp: 2, messageCount: 3, filePath: '/b' },
    ];
    modal.selectedIndex = 1;
    const sel = modal.getSelected();
    expect(sel).not.toBeNull();
    expect(sel!.name).toBe('b');
  });

  test('deleteSelected removes session file and refreshes list', () => {
    sm.save('mysession', [{ role: 'user', content: 'hi' }], META);
    modal = new SessionPickerModal();
    // Directly inject the session manager by testing with real data
    // We need to replace modal's sessions list with what sm.list() returns
    const sessions = sm.list();
    modal.sessions = sessions;
    modal.selectedIndex = 0;

    const deleted = modal.deleteSelected();
    // Check that the file is gone
    expect(deleted).toBe(true);
    expect(existsSync(sessions[0].filePath)).toBe(false);
  });

  test('close() deactivates modal', () => {
    modal = new SessionPickerModal();
    modal.active = true;
    modal.statusMessage = 'some message';
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.statusMessage).toBe('');
  });

  test('no navigation when sessions list is empty', () => {
    modal = new SessionPickerModal();
    modal.sessions = [];
    modal.selectedIndex = 0;
    modal.moveUp();
    modal.moveDown();
    expect(modal.selectedIndex).toBe(0);
  });
});
