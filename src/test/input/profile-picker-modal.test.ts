/**
 * Tests for ProfilePickerModal state class.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProfilePickerModal } from '../../input/profile-picker-modal.ts';
import { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles/manager';
import { ConfigManager } from '../../config/manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-prof-picker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ProfilePickerModal', () => {
  let tmpDir: string;
  let pm: ProfileManager;
  let cm: ConfigManager;
  let modal: ProfilePickerModal;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    pm = new ProfileManager(join(tmpDir, 'profiles'));
    cm = createConfigManager(tmpDir);
    modal = new ProfilePickerModal(pm);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('starts inactive', () => {
    expect(modal.active).toBe(false);
  });

  test('close() deactivates modal and clears statusMessage', () => {
    modal.active = true;
    modal.statusMessage = 'something';
    modal.deleteConfirmationTarget = 'work-profile';
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.statusMessage).toBe('');
    expect(modal.deleteConfirmationTarget).toBeNull();
  });

  test('navigation wraps around (moveUp from 0 → last)', () => {
    modal.profiles = [
      { name: 'a', timestamp: 1, filePath: '/a' },
      { name: 'b', timestamp: 2, filePath: '/b' },
    ];
    modal.selectedIndex = 0;
    modal.moveUp();
    expect(modal.selectedIndex).toBe(1);
  });

  test('moveDown increments selectedIndex', () => {
    modal.profiles = [
      { name: 'a', timestamp: 1, filePath: '/a' },
      { name: 'b', timestamp: 2, filePath: '/b' },
    ];
    modal.selectedIndex = 0;
    modal.deleteConfirmationTarget = 'a';
    modal.moveDown();
    expect(modal.selectedIndex).toBe(1);
    expect(modal.deleteConfirmationTarget).toBeNull();
  });

  test('moveDown wraps around', () => {
    modal.profiles = [{ name: 'a', timestamp: 1, filePath: '/a' }];
    modal.selectedIndex = 0;
    modal.moveDown();
    expect(modal.selectedIndex).toBe(0);
  });

  test('getSelected returns the current profile', () => {
    modal.profiles = [
      { name: 'a', timestamp: 1, filePath: '/a' },
      { name: 'b', timestamp: 2, filePath: '/b' },
    ];
    modal.selectedIndex = 1;
    expect(modal.getSelected()!.name).toBe('b');
  });

  test('no navigation when profiles list is empty', () => {
    modal.profiles = [];
    modal.moveUp();
    modal.moveDown();
    expect(modal.selectedIndex).toBe(0);
  });

  test('saveCurrentAs saves a profile', () => {
    const result = modal.saveCurrentAs('my-profile', cm);
    expect(result).toBe(true);
    expect(modal.statusMessage).toContain('my-profile');
  });

  test('saveCurrentAs with empty name returns false', () => {
    const result = modal.saveCurrentAs('', cm);
    expect(result).toBe(false);
    expect(modal.statusMessage).toBeTruthy();
  });

  test('deleteSelected requires confirmation before removal', () => {
    pm.save('test-profile', { display: {}, behavior: {} });
    // We can't easily inject pm into the modal since it uses getProfileManager(),
    // so test the interface with manually set profiles
    modal.profiles = [{ name: 'nonexistent-xyz', timestamp: 1, filePath: '/nonexistent' }];
    modal.selectedIndex = 0;
    const first = modal.deleteSelected();
    expect(first).toBe(false);
    expect(modal.deleteConfirmationTarget).toBe('nonexistent-xyz');
    expect(modal.statusMessage).toContain('Press delete again');
  });

  test('loadSelected on missing profile returns false with status message', () => {
    modal.profiles = [{ name: 'missing', timestamp: 0, filePath: '/nowhere/missing.json' }];
    modal.selectedIndex = 0;
    const result = modal.loadSelected(cm);
    expect(result).toBe(false);
    expect(modal.statusMessage).toContain('Error');
  });
});
