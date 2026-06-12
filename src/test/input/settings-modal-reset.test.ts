/**
 * Unit tests for settings-modal-reset — the extracted reset helpers.
 *
 * These tests exercise the free functions directly, independent of SettingsModal
 * class state, verifying that the logic is correct when injected via callbacks.
 */
import { describe, test, expect } from 'bun:test';
import {
  resetSelected,
  initiateResetCategory,
  initiateResetAll,
  handleResetConfirmKey,
} from '../../input/settings-modal-reset.ts';
import type { SettingEntry } from '../../input/settings-modal-types.ts';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(key: string, defaultValue: unknown, currentValue: unknown): SettingEntry {
  return {
    setting: {
      key,
      type: 'boolean',
      label: key,
      description: '',
      default: defaultValue,
      category: 'display',
    },
    currentValue,
    isDefault: currentValue === defaultValue,
  } as unknown as SettingEntry;
}

// ---------------------------------------------------------------------------
// resetSelected
// ---------------------------------------------------------------------------

describe('resetSelected', () => {
  test('returns null when editingMode is true', () => {
    const entry = makeEntry('display.stream', true, false);
    const result = resetSelected({
      editingMode: true,
      hasConfigManager: true,
      selected: entry,
      secretsManager: null,
      setValue: () => {},
    });
    expect(result).toBeNull();
  });

  test('returns null when configManager is absent', () => {
    const entry = makeEntry('display.stream', true, false);
    const result = resetSelected({
      editingMode: false,
      hasConfigManager: false,
      selected: entry,
      secretsManager: null,
      setValue: () => {},
    });
    expect(result).toBeNull();
  });

  test('returns null when no entry is selected', () => {
    const result = resetSelected({
      editingMode: false,
      hasConfigManager: true,
      selected: null,
      secretsManager: null,
      setValue: () => {},
    });
    expect(result).toBeNull();
  });

  test('calls setValue with default value and returns key/value pair', () => {
    const entry = makeEntry('display.stream', true, false);
    const calls: Array<[ConfigKey, unknown]> = [];
    const result = resetSelected({
      editingMode: false,
      hasConfigManager: true,
      selected: entry,
      secretsManager: null,
      setValue: (key, value) => calls.push([key, value]),
    });
    expect(result).toEqual({ key: 'display.stream', value: true });
    expect(calls).toEqual([['display.stream', true]]);
  });
});

// ---------------------------------------------------------------------------
// initiateResetCategory
// ---------------------------------------------------------------------------

describe('initiateResetCategory', () => {
  test('does nothing when configManager is absent', () => {
    let catConfirm: { readonly subject: string } | null = null;
    let allConfirm: { readonly subject: 'all' } | null = { subject: 'all' };
    initiateResetCategory({
      hasConfigManager: false,
      currentCategory: 'display',
      setResetCategoryConfirm: (v) => { catConfirm = v; },
      setResetAllConfirm: (v) => { allConfirm = v; },
    });
    expect(catConfirm).toBeNull();
    expect(allConfirm).toEqual({ subject: 'all' }); // unchanged
  });

  test('arms category confirm and clears all confirm', () => {
    let catConfirm: { readonly subject: string } | null = null;
    let allConfirm: { readonly subject: 'all' } | null = { subject: 'all' };
    initiateResetCategory({
      hasConfigManager: true,
      currentCategory: 'display',
      setResetCategoryConfirm: (v) => { catConfirm = v; },
      setResetAllConfirm: (v) => { allConfirm = v; },
    });
    expect(catConfirm).toEqual({ subject: 'display' });
    expect(allConfirm).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// initiateResetAll
// ---------------------------------------------------------------------------

describe('initiateResetAll', () => {
  test('does nothing when configManager is absent', () => {
    let catConfirm: { readonly subject: string } | null = { subject: 'display' };
    let allConfirm: { readonly subject: 'all' } | null = null;
    initiateResetAll({
      hasConfigManager: false,
      setResetCategoryConfirm: (v) => { catConfirm = v; },
      setResetAllConfirm: (v) => { allConfirm = v; },
    });
    expect(catConfirm).toEqual({ subject: 'display' }); // unchanged
    expect(allConfirm).toBeNull();
  });

  test('arms all confirm and clears category confirm', () => {
    let catConfirm: { readonly subject: string } | null = { subject: 'display' };
    let allConfirm: { readonly subject: 'all' } | null = null;
    initiateResetAll({
      hasConfigManager: true,
      setResetCategoryConfirm: (v) => { catConfirm = v; },
      setResetAllConfirm: (v) => { allConfirm = v; },
    });
    expect(catConfirm).toBeNull();
    expect(allConfirm).toEqual({ subject: 'all' });
  });
});

// ---------------------------------------------------------------------------
// handleResetConfirmKey
// ---------------------------------------------------------------------------

describe('handleResetConfirmKey', () => {
  test('returns inactive when no gate is armed', () => {
    const result = handleResetConfirmKey({
      key: 'enter',
      resetCategoryConfirm: null,
      resetAllConfirm: null,
      hasConfigManager: true,
      currentItems: () => [],
      groups: new Map(),
      setValue: () => {},
      setResetCategoryConfirm: () => {},
      setResetAllConfirm: () => {},
    });
    expect(result).toBe('inactive');
  });

  test('returns inactive when configManager is absent even if gate is armed', () => {
    const result = handleResetConfirmKey({
      key: 'enter',
      resetCategoryConfirm: { subject: 'display' },
      resetAllConfirm: null,
      hasConfigManager: false,
      currentItems: () => [],
      groups: new Map(),
      setValue: () => {},
      setResetCategoryConfirm: () => {},
      setResetAllConfirm: () => {},
    });
    expect(result).toBe('inactive');
  });

  test('category reset: enter resets current category items and returns confirmed', () => {
    const entry1 = makeEntry('display.stream', true, false);
    const entry2 = makeEntry('display.lineNumbers', true, false);
    const calls: Array<[ConfigKey, unknown]> = [];
    let catConfirm: { readonly subject: string } | null = { subject: 'display' };

    const result = handleResetConfirmKey({
      key: 'enter',
      resetCategoryConfirm: catConfirm,
      resetAllConfirm: null,
      hasConfigManager: true,
      currentItems: () => [entry1, entry2],
      groups: new Map(),
      setValue: (key, value) => calls.push([key, value]),
      setResetCategoryConfirm: (v) => { catConfirm = v; },
      setResetAllConfirm: () => {},
    });

    expect(typeof result).toBe('object');
    const confirmed = result as { result: 'confirmed'; entries: ReadonlyArray<{ key: string; value: unknown }> };
    expect(confirmed.result).toBe('confirmed');
    expect(confirmed.entries).toHaveLength(2);
    expect(calls).toEqual([['display.stream', true], ['display.lineNumbers', true]]);
    expect(catConfirm).toBeNull();
  });

  test('all reset: y resets all groups and returns confirmed', () => {
    const entry1 = makeEntry('display.stream', true, false);
    const entry2 = makeEntry('behavior.compact', false, true);
    const groups = new Map([
      ['display' as 'display', [entry1]],
      ['behavior' as 'behavior', [entry2]],
    ]);
    const calls: Array<[ConfigKey, unknown]> = [];
    let allConfirm: { readonly subject: 'all' } | null = { subject: 'all' };

    const result = handleResetConfirmKey({
      key: 'y',
      resetCategoryConfirm: null,
      resetAllConfirm: allConfirm,
      hasConfigManager: true,
      currentItems: () => [],
      groups,
      setValue: (key, value) => calls.push([key, value]),
      setResetCategoryConfirm: () => {},
      setResetAllConfirm: (v) => { allConfirm = v; },
    });

    expect(typeof result).toBe('object');
    const confirmed = result as { result: 'confirmed'; entries: ReadonlyArray<{ key: string; value: unknown }> };
    expect(confirmed.result).toBe('confirmed');
    expect(confirmed.entries).toHaveLength(2);
    expect(allConfirm).toBeNull();
  });

  test('escape cancels and clears both gates', () => {
    let catConfirm: { readonly subject: string } | null = { subject: 'display' };
    let allConfirm: { readonly subject: 'all' } | null = null;

    const result = handleResetConfirmKey({
      key: 'escape',
      resetCategoryConfirm: catConfirm,
      resetAllConfirm: allConfirm,
      hasConfigManager: true,
      currentItems: () => [],
      groups: new Map(),
      setValue: () => {},
      setResetCategoryConfirm: (v) => { catConfirm = v; },
      setResetAllConfirm: (v) => { allConfirm = v; },
    });
    expect(result).toBe('cancelled');
    expect(catConfirm).toBeNull();
    expect(allConfirm).toBeNull();
  });

  test('n cancels and clears both gates', () => {
    let catConfirm: { readonly subject: string } | null = null;
    let allConfirm: { readonly subject: 'all' } | null = { subject: 'all' };

    const result = handleResetConfirmKey({
      key: 'n',
      resetCategoryConfirm: catConfirm,
      resetAllConfirm: allConfirm,
      hasConfigManager: true,
      currentItems: () => [],
      groups: new Map(),
      setValue: () => {},
      setResetCategoryConfirm: (v) => { catConfirm = v; },
      setResetAllConfirm: (v) => { allConfirm = v; },
    });
    expect(result).toBe('cancelled');
    expect(catConfirm).toBeNull();
    expect(allConfirm).toBeNull();
  });

  test('other keys are absorbed while gate is active', () => {
    const result = handleResetConfirmKey({
      key: 'up',
      resetCategoryConfirm: { subject: 'display' },
      resetAllConfirm: null,
      hasConfigManager: true,
      currentItems: () => [],
      groups: new Map(),
      setValue: () => {},
      setResetCategoryConfirm: () => {},
      setResetAllConfirm: () => {},
    });
    expect(result).toBe('absorbed');
  });
});
