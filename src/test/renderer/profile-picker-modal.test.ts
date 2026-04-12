/**
 * Tests for renderProfilePickerModal renderer.
 */
import { describe, test, expect } from 'bun:test';
import { ProfilePickerModal } from '../../input/profile-picker-modal.ts';
import { ProfileManager } from '../../profiles/manager.ts';
import { renderProfilePickerModal } from '../../renderer/profile-picker-modal.ts';
import { lineToString, linesToText } from '../setup.ts';

const W = 120;
const profileManager = new ProfileManager();

function makeModal(overrides: Partial<ProfilePickerModal> = {}): ProfilePickerModal {
  const modal = new ProfilePickerModal(profileManager);
  modal.active = true;
  modal.profiles = [
    { name: 'work-profile',    timestamp: 1700000000000, filePath: '/x/work-profile.json' },
    { name: 'minimal-profile', timestamp: 1700100000000, filePath: '/x/minimal-profile.json' },
  ];
  modal.selectedIndex = 0;
  Object.assign(modal, overrides);
  return modal;
}

describe('renderProfilePickerModal', () => {
  test('returns a non-empty Line[] array', () => {
    const lines = renderProfilePickerModal(makeModal(), W);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    const lines = renderProfilePickerModal(makeModal(), W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Profiles"', () => {
    const lines = renderProfilePickerModal(makeModal(), W);
    const title = lineToString(lines[0]);
    expect(title).toContain('Profiles');
  });

  test('footer contains navigation hints', () => {
    const lines = renderProfilePickerModal(makeModal(), W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Navigate');
    expect(texts).toContain('Load');
    expect(texts).toContain('Arm/Delete');
    expect(texts).toContain('Save curr');
  });

  test('shows profile names in list', () => {
    const lines = renderProfilePickerModal(makeModal(), W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('work-profile');
    expect(texts).toContain('minimal-profile');
  });

  test('selected item has arrow indicator', () => {
    const lines = renderProfilePickerModal(makeModal(), W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('▸');
  });

  test('empty profiles shows helpful message', () => {
    const modal = makeModal();
    modal.profiles = [];
    const lines = renderProfilePickerModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('No saved profiles');
    expect(texts).toContain('[s]');
  });

  test('status message is displayed when set', () => {
    const modal = makeModal();
    modal.statusMessage = 'Loaded profile: work-profile';
    const lines = renderProfilePickerModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Loaded profile: work-profile');
  });

  test('delete confirmation guidance is displayed when armed', () => {
    const modal = makeModal();
    modal.deleteConfirmationTarget = 'work-profile';
    const lines = renderProfilePickerModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Press [d] again to permanently delete work-profile');
  });

  test('works at narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderProfilePickerModal(makeModal(), narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });
});
