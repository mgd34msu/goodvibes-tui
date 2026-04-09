import { describe, expect, test } from 'bun:test';
import { handleSelectionModalToken, handleSettingsModalToken } from '../../input/handler-modal-routes.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { ConfigManager } from '../../config/manager.ts';
import { createFeatureFlagManager } from '../../runtime/feature-flags/manager.ts';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';
import type { SelectionAction } from '../../input/selection-modal.ts';

function text(value: string) {
  return { type: 'text' as const, value };
}

describe('modal space actions', () => {
  test('selection modal ignores space when no toggle action is declared', () => {
    let callbackCount = 0;
    const state = {
      selectionModal: {
        active: true,
        query: '',
        searchFocused: false,
        allowSearch: true,
        customActions: new Map<string, SelectionAction>(),
        selectedIndex: 0,
        getSelected: () => ({ id: 'display.stream', label: 'display.stream' }),
        setQuery: () => {},
        focusSearch: () => {},
        blurSearch: () => {},
        moveUp: () => {},
        moveDown: () => {},
        close: () => {},
      },
      selectionCallback: () => { callbackCount++; },
      modalStack: ['selection'],
      requestRender: () => {},
      handleEscape: () => {},
    };
    const handled = handleSelectionModalToken(state, text(' '));
    expect(handled).toBe(true);
    expect(callbackCount).toBe(0);
  });

  test('selection modal uses space to toggle when enter is mapped to toggle', () => {
    const results: Array<{ action: SelectionAction }> = [];
    const state = {
      selectionModal: {
        active: true,
        query: '',
        searchFocused: false,
        allowSearch: true,
        customActions: new Map<string, SelectionAction>([['enter', 'toggle']]),
        selectedIndex: 0,
        getSelected: () => ({ id: 'permissions.mode', label: 'permissions.mode' }),
        setQuery: () => {},
        focusSearch: () => {},
        blurSearch: () => {},
        moveUp: () => {},
        moveDown: () => {},
        close: () => {},
      },
      selectionCallback: (result: { action: SelectionAction } | null) => { if (result) results.push(result); },
      modalStack: ['selection'],
      requestRender: () => {},
      handleEscape: () => {},
    };
    handleSelectionModalToken(state, text(' '));
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('toggle');
  });

  test('selection modal uses space to toggle when the selected item declares toggle as its primary action', () => {
    const results: Array<{ action: SelectionAction }> = [];
    const state = {
      selectionModal: {
        active: true,
        query: '',
        searchFocused: false,
        allowSearch: true,
        customActions: new Map<string, SelectionAction>(),
        selectedIndex: 0,
        getSelected: () => ({ id: 'display.stream', label: 'display.stream', primaryAction: 'toggle' as const }),
        setQuery: () => {},
        focusSearch: () => {},
        blurSearch: () => {},
        moveUp: () => {},
        moveDown: () => {},
        close: () => {},
      },
      selectionCallback: (result: { action: SelectionAction } | null) => { if (result) results.push(result); },
      modalStack: ['selection'],
      requestRender: () => {},
      handleEscape: () => {},
    };
    handleSelectionModalToken(state, text(' '));
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('toggle');
  });

  test('selection modal keeps toggle-style modals open on enter', () => {
    let closeCount = 0;
    const results: Array<{ action: SelectionAction }> = [];
    const state = {
      selectionModal: {
        active: true,
        query: '',
        searchFocused: false,
        allowSearch: true,
        customActions: new Map<string, SelectionAction>([['enter', 'toggle']]),
        selectedIndex: 0,
        getSelected: () => ({ id: 'danger.daemon', label: 'danger.daemon' }),
        setQuery: () => {},
        focusSearch: () => {},
        blurSearch: () => {},
        moveUp: () => {},
        moveDown: () => {},
        close: () => { closeCount++; },
      },
      selectionCallback: (result: { action: SelectionAction } | null) => { if (result) results.push(result); },
      modalStack: ['selection'],
      requestRender: () => {},
      handleEscape: () => {},
    };
    handleSelectionModalToken(state, { type: 'key', name: '\r', logicalName: 'enter', ctrl: false, shift: false, meta: false });
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('toggle');
    expect(closeCount).toBe(0);
    expect(state.modalStack).toEqual(['selection']);
  });

  test('selection modal uses item primary action for enter dispatch', () => {
    const results: Array<{ action: SelectionAction }> = [];
    let closeCount = 0;
    const state = {
      selectionModal: {
        active: true,
        query: '',
        searchFocused: false,
        allowSearch: true,
        customActions: new Map<string, SelectionAction>(),
        selectedIndex: 0,
        getSelected: () => ({ id: 'danger.daemon', label: 'danger.daemon', primaryAction: 'toggle' as const }),
        setQuery: () => {},
        focusSearch: () => {},
        blurSearch: () => {},
        moveUp: () => {},
        moveDown: () => {},
        close: () => { closeCount++; },
      },
      selectionCallback: (result: { action: SelectionAction } | null) => { if (result) results.push(result); },
      modalStack: ['selection'],
      requestRender: () => {},
      handleEscape: () => {},
    };
    handleSelectionModalToken(state, { type: 'key', name: '\r', logicalName: 'enter', ctrl: false, shift: false, meta: false });
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('toggle');
    expect(closeCount).toBe(0);
    expect(state.modalStack).toEqual(['selection']);
  });

  test('selection modal uses left/right to adjust toggleable values', () => {
    const results: Array<{ action: SelectionAction; step?: number }> = [];
    const state = {
      selectionModal: {
        active: true,
        query: '',
        searchFocused: false,
        allowSearch: true,
        customActions: new Map<string, SelectionAction>(),
        selectedIndex: 0,
        getSelected: () => ({ id: 'permissions.mode', label: 'permissions.mode', adjustable: true }),
        setQuery: () => {},
        focusSearch: () => {},
        blurSearch: () => {},
        moveUp: () => {},
        moveDown: () => {},
        close: () => {},
      },
      selectionCallback: (result: { action: SelectionAction; step?: number } | null) => { if (result) results.push(result); },
      modalStack: ['selection'],
      requestRender: () => {},
      handleEscape: () => {},
    };
    handleSelectionModalToken(state, { type: 'key', name: '', logicalName: 'left', ctrl: false, shift: true, meta: false });
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('decrement');
    expect(results[0]!.step).toBe(10);
  });

  test('selection modal uses per-item decimal step metadata for adjustable values', () => {
    const results: Array<{ action: SelectionAction; step?: number }> = [];
    const state = {
      selectionModal: {
        active: true,
        query: '',
        searchFocused: false,
        allowSearch: true,
        customActions: new Map<string, SelectionAction>(),
        selectedIndex: 0,
        getSelected: () => ({
          id: 'wrfc.scoreThreshold',
          label: 'wrfc.scoreThreshold',
          adjustable: true,
          adjustStep: 0.1,
          adjustMin: 0,
          adjustMax: 10,
          adjustPrecision: 1,
        }),
        setQuery: () => {},
        focusSearch: () => {},
        blurSearch: () => {},
        moveUp: () => {},
        moveDown: () => {},
        close: () => {},
      },
      selectionCallback: (result: { action: SelectionAction; step?: number } | null) => { if (result) results.push(result); },
      modalStack: ['selection'],
      requestRender: () => {},
      handleEscape: () => {},
    };
    handleSelectionModalToken(state, { type: 'key', name: '', logicalName: 'right', ctrl: false, shift: false, meta: false });
    handleSelectionModalToken(state, { type: 'key', name: '', logicalName: 'left', ctrl: false, shift: true, meta: false });
    expect(results).toHaveLength(2);
    expect(results[0]!.step).toBe(0.1);
    expect(results[1]!.step).toBe(1);
  });

  test('settings modal toggles the selected value on space', () => {
    const dir = join(tmpdir(), `gv-settings-space-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const cm = new ConfigManager({ workingDir: dir, configDir: join(dir, '.goodvibes', 'tui') });
      const modal = new SettingsModal();
      modal.open(cm, createFeatureFlagManager(), { listServerSecurity: () => [], setServerTrustMode: () => {} } as never);
      const idx = modal.currentItems.findIndex((entry) => entry.setting.key === 'display.stream');
      for (let i = 0; i < idx; i++) modal.moveDown();
      const before = cm.get('display.stream') as boolean;
      const handled = handleSettingsModalToken({
        settingsModal: modal,
        requestRender: () => {},
        handleEscape: () => {},
      }, text(' '));
      expect(handled).toBe(true);
      expect(cm.get('display.stream')).toBe(!before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('settings modal adjusts selected values with left/right and shift steps', () => {
    const calls: Array<{ direction: 'left' | 'right'; step?: number }> = [];
    const handled = handleSettingsModalToken({
      settingsModal: {
        active: true,
        editingMode: false,
        currentCategory: 'display',
        commitEdit: () => {},
        toggleSelectedFlag: () => {},
        activateSelected: () => {},
        adjustSelected: (direction, step) => { calls.push({ direction, step }); },
        moveUp: () => {},
        moveDown: () => {},
        nextCategory: () => {},
        editBackspace: () => {},
        editChar: () => {},
      },
      requestRender: () => {},
      handleEscape: () => {},
    }, { type: 'key', name: '', logicalName: 'right', ctrl: false, shift: true, meta: false });
    expect(handled).toBe(true);
    expect(calls).toEqual([{ direction: 'right', step: 10 }]);
  });

  test('settings modal applies left/right adjustments to booleans and numbers', () => {
    const dir = join(tmpdir(), `gv-settings-adjust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const cm = new ConfigManager({ workingDir: dir, configDir: join(dir, '.goodvibes', 'tui') });
      const modal = new SettingsModal();
      modal.open(cm, createFeatureFlagManager(), { listServerSecurity: () => [], setServerTrustMode: () => {} } as never);

      const streamIdx = modal.currentItems.findIndex((entry) => entry.setting.key === 'display.stream');
      for (let i = 0; i < streamIdx; i++) modal.moveDown();
      modal.adjustSelected('left');
      expect(cm.get('display.stream')).toBe(false);
      modal.adjustSelected('right');
      expect(cm.get('display.stream')).toBe(true);

      const collapseIdx = modal.currentItems.findIndex((entry) => entry.setting.key === 'display.collapseThreshold');
      while (modal.selectedIndex < collapseIdx) modal.moveDown();
      const before = cm.get('display.collapseThreshold') as number;
      modal.adjustSelected('right', 10);
      expect(cm.get('display.collapseThreshold')).toBe(before + 10);
      modal.adjustSelected('left', 1);
      expect(cm.get('display.collapseThreshold')).toBe(before + 9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
