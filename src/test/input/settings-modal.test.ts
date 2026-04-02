/**
 * Tests for SettingsModal state class.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsModal, SETTINGS_CATEGORIES } from '../../input/settings-modal.ts';
import { ConfigManager } from '../../config/manager.ts';
import { FeatureFlagManager } from '../../runtime/feature-flags/manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-settings-modal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SettingsModal', () => {
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cm = new ConfigManager({ workingDir: tmpDir });
    ffm = new FeatureFlagManager();
    modal = new SettingsModal();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('starts inactive', () => {
    expect(modal.active).toBe(false);
  });

  test('open() activates modal and loads config groups', () => {
    modal.open(cm, ffm);
    expect(modal.active).toBe(true);
    expect(modal.categoryIndex).toBe(0);
    expect(modal.selectedIndex).toBe(0);
    expect(modal.editingMode).toBe(false);
  });

  test('open() populates all categories', () => {
    modal.open(cm, ffm);
    for (const cat of SETTINGS_CATEGORIES) {
      const items = modal.groups.get(cat);
      expect(items).toBeDefined();
      expect(Array.isArray(items)).toBe(true);
    }
  });

  test('currentCategory returns correct category', () => {
    modal.open(cm, ffm);
    expect(modal.currentCategory).toBe(SETTINGS_CATEGORIES[0]);
  });

  test('nextCategory cycles through categories', () => {
    modal.open(cm, ffm);
    const initial = modal.categoryIndex;
    modal.nextCategory();
    expect(modal.categoryIndex).toBe((initial + 1) % SETTINGS_CATEGORIES.length);
  });

  test('prevCategory cycles backwards', () => {
    modal.open(cm, ffm);
    modal.prevCategory();
    expect(modal.categoryIndex).toBe(SETTINGS_CATEGORIES.length - 1);
  });

  test('nextCategory resets selectedIndex to 0', () => {
    modal.open(cm, ffm);
    modal.moveDown();
    modal.moveDown();
    modal.nextCategory();
    expect(modal.selectedIndex).toBe(0);
  });

  test('moveDown increments selectedIndex', () => {
    modal.open(cm, ffm);
    const before = modal.selectedIndex;
    modal.moveDown();
    expect(modal.selectedIndex).toBe(before + 1);
  });

  test('moveUp wraps around to last item', () => {
    modal.open(cm, ffm);
    modal.moveUp();
    const len = modal.currentItems.length;
    expect(modal.selectedIndex).toBe(len - 1);
  });

  test('getSelected returns the selected SettingEntry', () => {
    modal.open(cm, ffm);
    const entry = modal.getSelected();
    expect(entry).not.toBeNull();
    expect(entry!.setting).toBeDefined();
    expect(entry!.setting.key).toBeTruthy();
  });

  test('activateSelected toggles boolean setting', () => {
    modal.open(cm, ffm);
    // Navigate to a boolean setting (display.stream is first in display)
    const items = modal.currentItems;
    const boolIdx = items.findIndex(e => e.setting.type === 'boolean');
    expect(boolIdx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < boolIdx; i++) modal.moveDown();

    const before = modal.getSelected()!.currentValue as boolean;
    modal.activateSelected();
    // Reload
    const afterEntry = modal.getSelected();
    const after = afterEntry?.currentValue as boolean;
    expect(after).toBe(!before);
  });

  test('activateSelected enters editingMode for string setting', () => {
    modal.open(cm, ffm);
    // Navigate to a string setting (display.theme)
    const items = modal.currentItems;
    const strIdx = items.findIndex(e => e.setting.type === 'string');
    expect(strIdx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < strIdx; i++) modal.moveDown();

    modal.activateSelected();
    expect(modal.editingMode).toBe(true);
    expect(modal.editBuffer).toBeTruthy(); // pre-populated with current value
  });

  test('editChar appends to editBuffer', () => {
    modal.open(cm, ffm);
    const items = modal.currentItems;
    const strIdx = items.findIndex(e => e.setting.type === 'string');
    for (let i = 0; i < strIdx; i++) modal.moveDown();
    modal.activateSelected();
    const before = modal.editBuffer;
    modal.editChar('x');
    expect(modal.editBuffer).toBe(before + 'x');
  });

  test('editBackspace removes last char', () => {
    modal.open(cm, ffm);
    const items = modal.currentItems;
    const strIdx = items.findIndex(e => e.setting.type === 'string');
    for (let i = 0; i < strIdx; i++) modal.moveDown();
    modal.activateSelected();
    modal.editBuffer = 'hello';
    modal.editBackspace();
    expect(modal.editBuffer).toBe('hell');
  });

  test('cancelEdit exits editingMode without saving', () => {
    modal.open(cm, ffm);
    const items = modal.currentItems;
    const strIdx = items.findIndex(e => e.setting.type === 'string');
    for (let i = 0; i < strIdx; i++) modal.moveDown();
    const entry = modal.getSelected()!;
    const originalValue = entry.currentValue;
    modal.activateSelected();
    modal.editBuffer = 'something-new';
    modal.cancelEdit();
    expect(modal.editingMode).toBe(false);
    // Value should not have changed
    expect(String(cm.get(entry.setting.key as 'display.theme'))).toBe(String(originalValue));
  });

  test('commitEdit saves string value', () => {
    modal.open(cm, ffm);
    // Go to provider category which has model (string)
    while (modal.currentCategory !== 'provider') modal.nextCategory();
    const items = modal.currentItems;
    const strIdx = items.findIndex(e => e.setting.type === 'string');
    for (let i = 0; i < strIdx; i++) modal.moveDown();
    modal.activateSelected();
    modal.editBuffer = 'new-model-name';
    const editResult = modal.commitEdit();
    expect(editResult).toBe(true);
    expect(modal.editingMode).toBe(false);
  });

  test('close() deactivates modal and clears editing state', () => {
    modal.open(cm, ffm);
    modal.editingMode = true;
    modal.editBuffer = 'partial';
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.editingMode).toBe(false);
    expect(modal.editBuffer).toBe('');
  });

  test('navigating categories does not change settings in other categories', () => {
    modal.open(cm, ffm);
    modal.nextCategory();
    const items = modal.currentItems;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.setting.key.startsWith(modal.currentCategory)).toBe(true);
    }
  });

  test('editingMode blocks category and direction navigation', () => {
    modal.open(cm, ffm);
    modal.editingMode = true;
    const catBefore = modal.categoryIndex;
    const idxBefore = modal.selectedIndex;
    modal.nextCategory();
    modal.prevCategory();
    modal.moveDown();
    modal.moveUp();
    expect(modal.categoryIndex).toBe(catBefore);
    expect(modal.selectedIndex).toBe(idxBefore);
  });
});
