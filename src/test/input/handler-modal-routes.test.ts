/**
 * Router-level tests for handleSettingsModalToken — reset-confirm gate.
 *
 * Follows the existing handler-modal-routes test pattern:
 * - Builds a real SettingsModal (real state class, not a mock) so the
 *   initiateResetCategory/handleResetConfirmKey contract is genuine.
 * - Wraps it in a minimal SettingsRouteState shim to exercise the router.
 * - Does NOT touch the modal methods themselves (verified correct elsewhere
 *   in settings-modal.test.ts).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleSettingsModalToken } from '../../input/handler-modal-routes.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyToken(
  logicalName: string,
  opts: { shift?: boolean; ctrl?: boolean; meta?: boolean } = {},
): InputToken {
  return {
    type: 'key',
    name: logicalName,
    logicalName,
    shift: opts.shift ?? false,
    ctrl: opts.ctrl ?? false,
    meta: opts.meta ?? false,
  };
}

function textToken(value: string): InputToken {
  return { type: 'text', value } as InputToken;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe('handleSettingsModalToken — reset-confirm gate', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;
  let renderCalls: number;

  const mcpRegistry = {
    listServerSecurity: () => [],
    setServerTrustMode: () => {},
  } as unknown as McpRegistry;

  function makeState() {
    return {
      settingsModal: modal,
      requestRender: () => { renderCalls++; },
      handleEscape: () => {},
    };
  }

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `gv-handler-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: tmpDir,
      homeDir: tmpDir,
      configDir: join(tmpDir, '.goodvibes', 'global-tui'),
    });
    ffm = createFeatureFlagManager();
    const secrets = new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm });
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
    const subscriptionManager = new SubscriptionManager(
      join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'),
    );
    const serviceRegistry = new ServiceRegistry(
      join(tmpDir, '.goodvibes', 'tui', 'services.json'),
      { secretsManager: secrets, subscriptionManager },
    );
    modal = new SettingsModal();
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    // Navigate to 'display' category so reset-category has items.
    while (modal.currentCategory !== 'display') modal.nextCategory();
    renderCalls = 0;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Shift+R → initiateResetCategory ────────────────────────────────────

  test('Shift+R arms the category reset confirm', () => {
    const state = makeState();
    const consumed = handleSettingsModalToken(state, keyToken('r', { shift: true }));
    expect(consumed).toBe(true);
    expect(modal.resetCategoryConfirm).not.toBeNull();
    expect(modal.resetCategoryConfirm!.subject).toBe('display');
    expect(modal.resetAllConfirm).toBeNull();
  });

  test('Shift+R: Enter confirms — values reset, gate cleared', () => {
    cm.setDynamic('display.stream', false);
    // Re-open so the modal picks up the changed value
    const secrets = new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm });
    const sub = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    const svc = new ServiceRegistry(
      join(tmpDir, '.goodvibes', 'tui', 'services.json'),
      { secretsManager: secrets, subscriptionManager: sub },
    );
    modal = new SettingsModal();
    modal.open(cm, ffm, sub, svc, mcpRegistry);
    while (modal.currentCategory !== 'display') modal.nextCategory();
    renderCalls = 0;

    const state = makeState();
    // Arm
    handleSettingsModalToken(state, keyToken('r', { shift: true }));
    expect(modal.resetCategoryConfirm).not.toBeNull();

    // Confirm with Enter
    const consumed = handleSettingsModalToken(state, keyToken('enter'));
    expect(consumed).toBe(true);
    expect(modal.resetCategoryConfirm).toBeNull();
    expect(cm.get('display.stream')).toBe(true); // reset to default
    expect(renderCalls).toBeGreaterThanOrEqual(2);
  });

  test('Shift+R: Esc cancels — values unchanged, gate cleared', () => {
    cm.setDynamic('display.stream', false);
    const state = makeState();
    handleSettingsModalToken(state, keyToken('r', { shift: true }));
    const consumed = handleSettingsModalToken(state, keyToken('escape'));
    expect(consumed).toBe(true);
    expect(modal.resetCategoryConfirm).toBeNull();
    expect(cm.get('display.stream')).toBe(false); // unchanged
  });

  test('Shift+R: absorbed keys keep the gate open', () => {
    const state = makeState();
    handleSettingsModalToken(state, keyToken('r', { shift: true }));
    // Up arrow is not a confirm key—should be absorbed by the gate
    const consumed = handleSettingsModalToken(state, keyToken('up'));
    expect(consumed).toBe(true);
    // Gate still armed
    expect(modal.resetCategoryConfirm).not.toBeNull();
  });

  test('Shift+R: y text token confirms via gate', () => {
    cm.setDynamic('display.stream', false);
    const state = makeState();
    handleSettingsModalToken(state, keyToken('r', { shift: true }));
    handleSettingsModalToken(state, textToken('y'));
    expect(modal.resetCategoryConfirm).toBeNull();
    expect(cm.get('display.stream')).toBe(true);
  });

  // ─── Ctrl+Shift+R → initiateResetAll ────────────────────────────────────

  test('Ctrl+Shift+R arms the reset-all confirm', () => {
    const state = makeState();
    const consumed = handleSettingsModalToken(state, keyToken('r', { shift: true, ctrl: true }));
    expect(consumed).toBe(true);
    expect(modal.resetAllConfirm).not.toBeNull();
    expect(modal.resetAllConfirm!.subject).toBe('all');
    expect(modal.resetCategoryConfirm).toBeNull();
  });

  test('Ctrl+Shift+R: Enter confirms reset-all, values reset', () => {
    cm.setDynamic('display.stream', false);
    cm.setDynamic('behavior.autoApprove', true);
    const state = makeState();
    handleSettingsModalToken(state, keyToken('r', { shift: true, ctrl: true }));
    handleSettingsModalToken(state, keyToken('enter'));
    expect(modal.resetAllConfirm).toBeNull();
    expect(cm.get('display.stream')).toBe(true);
    expect(cm.get('behavior.autoApprove')).toBe(false);
  });

  test('Ctrl+Shift+R: Esc cancels reset-all, values unchanged', () => {
    cm.setDynamic('display.stream', false);
    const state = makeState();
    handleSettingsModalToken(state, keyToken('r', { shift: true, ctrl: true }));
    handleSettingsModalToken(state, keyToken('escape'));
    expect(modal.resetAllConfirm).toBeNull();
    expect(cm.get('display.stream')).toBe(false);
  });

  test('Ctrl+Shift+R: absorbed keys keep the gate open', () => {
    const state = makeState();
    handleSettingsModalToken(state, keyToken('r', { shift: true, ctrl: true }));
    handleSettingsModalToken(state, keyToken('down'));
    expect(modal.resetAllConfirm).not.toBeNull();
  });

  // ─── Gate priority: reset gate is checked before normal dispatch ──────────

  test('gate intercepts keys regardless of editingMode/searchFocused state', () => {
    const state = makeState();
    handleSettingsModalToken(state, keyToken('r', { shift: true }));
    // Simulate a search-focused scenario — gate must still intercept
    modal.focusSearch();
    const consumed = handleSettingsModalToken(state, keyToken('up'));
    expect(consumed).toBe(true);
    expect(modal.resetCategoryConfirm).not.toBeNull(); // absorbed, not dispatched
  });

  // ─── Unmodified R still works as per-setting reset (existing behavior) ────

  test('unmodified R does not arm category reset', () => {
    const state = makeState();
    // Navigate to settings pane so R has an effect
    modal.focusSettings();
    handleSettingsModalToken(state, keyToken('r'));
    expect(modal.resetCategoryConfirm).toBeNull();
    expect(modal.resetAllConfirm).toBeNull();
  });

  // ─── Runtime sync after Provider-category reset confirm ────────────────────

  test('Shift+R confirm on provider category syncs ctx.session.runtime.model', () => {
    // Navigate to 'provider' category so the reset targets provider.model.
    while (modal.currentCategory !== 'provider') modal.nextCategory();
    renderCalls = 0;

    // Get the schema default for provider.model before reset.
    const providerModelDefault = cm.get('provider.model');

    // Wire up a fake runtime session with a STALE model value so we can detect
    // that syncRuntimeAfterSettingReset fires and overwrites it.
    const staleModel = '__stale_model_value__';
    const fakeRuntime = { model: staleModel, reasoningEffort: 'medium' } as {
      model: string;
      reasoningEffort: string;
    };
    const state = {
      ...makeState(),
      commandContext: {
        session: { runtime: fakeRuntime },
      } as unknown as import('../../input/command-registry.ts').CommandContext,
    };

    // Arm and confirm the provider-category reset.
    handleSettingsModalToken(state, keyToken('r', { shift: true }));
    expect(modal.resetCategoryConfirm).not.toBeNull();
    handleSettingsModalToken(state, keyToken('enter'));

    // After confirm the gate should be cleared and runtime.model should
    // have been overwritten by syncRuntimeAfterSettingReset.
    expect(modal.resetCategoryConfirm).toBeNull();
    // provider.model is included in provider category — runtime must now reflect
    // the schema default (not the stale value the runtime held before reset).
    expect(fakeRuntime.model).toBe(String(providerModelDefault));
    expect(fakeRuntime.model).not.toBe(staleModel);
  });

  // ─── No confirm pending: gate returns inactive, normal dispatch continues ──

  test('without armed confirm, normal keys still dispatch normally', () => {
    const state = makeState();
    // Modal starts with no confirm armed; Up/Down should be handled normally
    const before = modal.selectedIndex;
    modal.focusSettings();
    handleSettingsModalToken(state, keyToken('down'));
    // selectedIndex may or may not change depending on available items;
    // the key point is that it was consumed and no confirm was armed.
    expect(modal.resetCategoryConfirm).toBeNull();
    expect(modal.resetAllConfirm).toBeNull();
    expect(renderCalls).toBeGreaterThan(0);
    void before; // referenced for clarity
  });
});
