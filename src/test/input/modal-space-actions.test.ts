import { describe, expect, test } from 'bun:test';
import { handleSelectionModalToken, handleSettingsModalToken } from '../../input/handler-modal-routes.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { createFeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/manager';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
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

  test('selection modal preserves callbacks across chained selection modals', () => {
    let selected = { id: 'llm-provider', label: 'TTS LLM provider' };
    let closeCount = 0;
    let modelCallbackCalled = 0;
    let currentCallback: ((result: { item: { id: string; label: string }; action: SelectionAction } | null) => void) | null = null;
    const modelCallback = (result: { item: { id: string; label: string }; action: SelectionAction } | null) => {
      if (result?.item.id === 'anthropic:claude-sonnet') modelCallbackCalled++;
    };
    const providerCallback = (result: { item: { id: string; label: string }; action: SelectionAction } | null) => {
      if (result?.item.id !== 'anthropic') return;
      selected = { id: 'anthropic:claude-sonnet', label: 'Claude Sonnet' };
      state.selectionModal.active = true;
      state.modalStack.push('selection');
      currentCallback = modelCallback;
    };
    const firstCallback = () => {
      selected = { id: 'anthropic', label: 'anthropic' };
      state.selectionModal.active = true;
      state.modalStack.push('selection');
      currentCallback = providerCallback;
    };
    currentCallback = firstCallback;
    const state = {
      selectionModal: {
        active: true,
        query: '',
        searchFocused: false,
        allowSearch: true,
        customActions: new Map<string, SelectionAction>(),
        selectedIndex: 0,
        getSelected: () => selected,
        setQuery: () => {},
        focusSearch: () => {},
        blurSearch: () => {},
        moveUp: () => {},
        moveDown: () => {},
        close: () => {
          closeCount++;
          state.selectionModal.active = false;
        },
      },
      selectionCallback: currentCallback,
      getSelectionCallback: () => currentCallback,
      setSelectionCallback: (callback: typeof currentCallback) => { currentCallback = callback; },
      modalStack: ['selection'],
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleSelectionModalToken(state, { type: 'key', name: '\r', logicalName: 'enter', ctrl: false, shift: false, meta: false });
    expect(state.selectionModal.active).toBe(true);
    expect(state.selectionCallback).toBe(providerCallback);
    expect(currentCallback).toBe(providerCallback);
    expect(state.modalStack).toEqual(['selection']);

    handleSelectionModalToken(state, { type: 'key', name: '\r', logicalName: 'enter', ctrl: false, shift: false, meta: false });
    expect(state.selectionModal.active).toBe(true);
    expect(state.selectionCallback).toBe(modelCallback);
    expect(currentCallback).toBe(modelCallback);
    expect(state.modalStack).toEqual(['selection']);

    handleSelectionModalToken(state, { type: 'key', name: '\r', logicalName: 'enter', ctrl: false, shift: false, meta: false });
    expect(modelCallbackCalled).toBe(1);
    expect(closeCount).toBe(3);
    expect(currentCallback).toBeNull();
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
      const cm = new ConfigManager({ surfaceRoot: 'tui',  workingDir: dir, configDir: join(dir, '.goodvibes', 'tui') });
      const subscriptionManager = new SubscriptionManager(join(dir, '.goodvibes', 'tui', 'subscriptions.json'));
      const serviceRegistry = new ServiceRegistry(join(dir, '.goodvibes', 'tui', 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: dir, globalHome: dir, configManager: cm }),
        subscriptionManager,
      });
      const modal = new SettingsModal();
      modal.open(
        cm,
        createFeatureFlagManager(),
        subscriptionManager,
        serviceRegistry,
        { listServerSecurity: () => [], setServerTrustMode: () => {} } as never,
      );
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
        pendingModelPickerTarget: null,
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

  test('settings modal opens provider-model picker requests before model-only picker requests', () => {
    const providerTargets: string[] = [];
    const modelTargets: string[] = [];
    const settingsModal = {
      active: true,
      editingMode: false,
      currentCategory: 'voice',
      commitEdit: () => {},
      toggleSelectedFlag: () => {},
      activateSelected: () => {
        settingsModal.pendingProviderModelPickerTarget = 'tts';
      },
      pendingModelPickerTarget: null as import('../../input/model-picker.ts').ModelPickerTarget | null,
      pendingProviderModelPickerTarget: null as import('../../input/model-picker.ts').ModelPickerTarget | null,
      adjustSelected: () => {},
      moveUp: () => {},
      moveDown: () => {},
      nextCategory: () => {},
      editBackspace: () => {},
      editChar: () => {},
    };

    const handled = handleSettingsModalToken({
      settingsModal,
      openProviderModelPickerWithTarget: (target) => { providerTargets.push(target); },
      openModelPickerWithTarget: (target) => { modelTargets.push(target); },
      requestRender: () => {},
      handleEscape: () => {},
    }, { type: 'key', name: '', logicalName: 'enter', ctrl: false, shift: false, meta: false });

    expect(handled).toBe(true);
    expect(providerTargets).toEqual(['tts']);
    expect(modelTargets).toEqual([]);
    expect(settingsModal.pendingProviderModelPickerTarget).toBeNull();
  });

  test('settings modal applies left/right adjustments to booleans and numbers', () => {
    const dir = join(tmpdir(), `gv-settings-adjust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const cm = new ConfigManager({ surfaceRoot: 'tui',  workingDir: dir, configDir: join(dir, '.goodvibes', 'tui') });
      const subscriptionManager = new SubscriptionManager(join(dir, '.goodvibes', 'tui', 'subscriptions.json'));
      const serviceRegistry = new ServiceRegistry(join(dir, '.goodvibes', 'tui', 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: dir, globalHome: dir, configManager: cm }),
        subscriptionManager,
      });
      const modal = new SettingsModal();
      modal.open(
        cm,
        createFeatureFlagManager(),
        subscriptionManager,
        serviceRegistry,
        { listServerSecurity: () => [], setServerTrustMode: () => {} } as never,
      );

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
