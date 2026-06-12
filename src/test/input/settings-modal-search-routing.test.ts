/**
 * Integration test: settings modal search routing (WRFC:settings-truth-fix1 item 3).
 *
 * Tests the full input→state→render pipeline for the settings modal search feature:
 *   - typing a query through handleSettingsModalToken filters the rendered list
 *   - Esc restores normal view (two-stage: first Esc exits search, second Esc closes modal)
 *   - Enter on a search result selects that setting (activateSelected path)
 *   - backspace edits the query in search mode
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsModal } from '../../input/settings-modal.ts';
import { handleSettingsModalToken } from '../../input/handler-modal-routes.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { SecretsManager } from '../../config/secrets.ts';
import { linesToText } from '../setup.ts';

const W = 120;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-settings-search-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('settings modal search routing integration', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let modal: SettingsModal;
  let escaped: boolean;
  let renderRequested: boolean;

  // Minimal route state that satisfies SettingsRouteState
  function makeState() {
    escaped = false;
    renderRequested = false;
    return {
      settingsModal: modal,
      requestRender: () => { renderRequested = true; },
      handleEscape: () => { escaped = true; modal.close(); },
    };
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
    mkdirSync(join(tmpDir, '.goodvibes', 'global-tui'), { recursive: true });
    cm = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: tmpDir,
      homeDir: tmpDir,
      configDir: join(tmpDir, '.goodvibes', 'global-tui'),
    });
    modal = new SettingsModal();
    const ffm = createFeatureFlagManager();
    const sm = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    const secrets = new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm });
    const sr = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: secrets,
      subscriptionManager: sm,
    });
    const mcpRegistry = {
      listServerSecurity: () => [],
      setServerTrustMode: () => {},
    } as unknown as McpRegistry;
    modal.open(cm, ffm, sm, sr, mcpRegistry);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('pressing / enters search mode and focuses the search input', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    expect(modal.searchFocused).toBe(true);
    expect(modal.searchQuery).toBe('');
  });

  test('printable chars in search mode append to query and update searchResults', () => {
    const state = makeState();
    // Enter search mode via /
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    // Type "stream"
    for (const ch of 'stream') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    expect(modal.searchQuery).toBe('stream');
    expect(modal.searchResults.length).toBeGreaterThan(0);
    expect(modal.searchResults.some(e => e.setting.key === 'display.stream')).toBe(true);
  });

  test('typed query filters the rendered list: search prompt row appears', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    for (const ch of 'stream') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    // The search prompt row should contain the query
    expect(texts).toContain('stream');
    // The main header should show "Search:"
    expect(texts).toContain('Search:');
    // Setting key should appear in results
    expect(texts.toLowerCase()).toContain('stream');
  });

  test('first Esc exits search mode (clears search) but does not close modal', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    for (const ch of 'stream') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    expect(modal.searchFocused).toBe(true);
    // First Esc
    handleSettingsModalToken(state, { type: 'key', name: 'escape', logicalName: 'escape', ctrl: false, shift: false, meta: false });
    expect(modal.searchFocused).toBe(false);
    expect(modal.searchQuery).toBe('');
    expect(modal.active).toBe(true); // modal still open
    expect(escaped).toBe(false);
  });

  test('second Esc closes the modal (two-stage escape contract)', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    for (const ch of 'theme') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    // First Esc exits search
    handleSettingsModalToken(state, { type: 'key', name: 'escape', logicalName: 'escape', ctrl: false, shift: false, meta: false });
    expect(modal.searchFocused).toBe(false);
    expect(modal.active).toBe(true);
    // Second Esc closes modal
    handleSettingsModalToken(state, { type: 'key', name: 'escape', logicalName: 'escape', ctrl: false, shift: false, meta: false });
    expect(escaped).toBe(true);
    expect(modal.active).toBe(false);
  });

  test('Esc with no search active immediately closes modal', () => {
    const state = makeState();
    expect(modal.searchFocused).toBe(false);
    handleSettingsModalToken(state, { type: 'key', name: 'escape', logicalName: 'escape', ctrl: false, shift: false, meta: false });
    expect(escaped).toBe(true);
    expect(modal.active).toBe(false);
  });

  test('backspace in search mode trims the query', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    for (const ch of 'str') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    expect(modal.searchQuery).toBe('str');
    handleSettingsModalToken(state, { type: 'key', name: 'backspace', logicalName: 'backspace', ctrl: false, shift: false, meta: false });
    expect(modal.searchQuery).toBe('st');
    handleSettingsModalToken(state, { type: 'key', name: 'backspace', logicalName: 'backspace', ctrl: false, shift: false, meta: false });
    expect(modal.searchQuery).toBe('s');
  });

  test('up/down navigate search results in search mode', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    // Type a query that returns multiple results
    for (const ch of 'dis') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    expect(modal.searchResults.length).toBeGreaterThan(1);
    const initialIndex = modal.selectedIndex;
    handleSettingsModalToken(state, { type: 'key', name: 'down', logicalName: 'down', ctrl: false, shift: false, meta: false });
    expect(modal.selectedIndex).toBe((initialIndex + 1) % modal.searchResults.length);
    handleSettingsModalToken(state, { type: 'key', name: 'up', logicalName: 'up', ctrl: false, shift: false, meta: false });
    expect(modal.selectedIndex).toBe(initialIndex);
  });

  test('Enter on a search result selects (activates) that setting', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    // Search for 'stream' — known boolean setting
    for (const ch of 'stream') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    // Move to first result
    modal.selectedIndex = 0;
    const firstResult = modal.searchResults[0];
    expect(firstResult).toBeDefined();
    expect(firstResult!.setting.key).toBe('display.stream');
    // Press Enter — boolean settings toggle on activateSelected
    const before = modal.getSelected()?.currentValue;
    handleSettingsModalToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
    const after = modal.getSelected()?.currentValue;
    // A boolean setting should have toggled
    expect(after).not.toBe(before);
  });

  test('/ key token also enters search mode (key branch)', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'key', name: '/', logicalName: '/', ctrl: false, shift: false, meta: false });
    expect(modal.searchFocused).toBe(true);
  });

  test('edit-mode keystroke routing: chars after Enter on string/number search result go to editBuffer not searchQuery', () => {
    // Find a plain string setting via search — provider.systemPromptFile is a non-secret,
    // non-picker string setting that reliably enters inline edit mode on Enter.
    // Type a char after Enter and verify it goes to editBuffer, NOT searchQuery.
    const state = makeState();
    // Enter search mode and search for provider.systemPromptFile
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    for (const ch of 'systemPrompt') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    // Find the systemPromptFile entry in search results
    const promptResult = modal.searchResults.find(
      e => e.setting.key === 'provider.systemPromptFile',
    );
    expect(promptResult).toBeDefined();
    expect(promptResult!.setting.type).toBe('string');
    // Move selection to that result
    const resultIdx = modal.searchResults.indexOf(promptResult!);
    modal.selectedIndex = resultIdx;
    // Record query before Enter
    const queryBefore = modal.searchQuery;
    // Press Enter — must enter inline editingMode for the string setting
    handleSettingsModalToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
    // editingMode must be true now
    expect(modal.editingMode).toBe(true);
    // Type a char — it MUST go to editBuffer, NOT append to searchQuery
    handleSettingsModalToken(state, { type: 'text', value: 'X' });
    expect(modal.editBuffer).toContain('X');
    // searchQuery must remain unchanged
    expect(modal.searchQuery).toBe(queryBefore);
  });

  test('Down/Up with empty query in search mode is a no-op (does not navigate category list)', () => {
    const state = makeState();
    // Enter search mode but leave query empty
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    expect(modal.searchFocused).toBe(true);
    expect(modal.searchResults.length).toBe(0);
    // Record current category before nav
    const catBefore = modal.categoryIndex;
    const selBefore = modal.selectedIndex;
    // Down should be a no-op — categoryIndex must NOT change
    handleSettingsModalToken(state, { type: 'key', name: 'down', logicalName: 'down', ctrl: false, shift: false, meta: false });
    expect(modal.categoryIndex).toBe(catBefore);
    expect(modal.selectedIndex).toBe(selBefore);
    // Up should also be a no-op
    handleSettingsModalToken(state, { type: 'key', name: 'up', logicalName: 'up', ctrl: false, shift: false, meta: false });
    expect(modal.categoryIndex).toBe(catBefore);
    expect(modal.selectedIndex).toBe(selBefore);
  });

  test('rendered output shows "Search Results" context pane header when in search mode', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    for (const ch of 'stream') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Search Results');
  });

  test('Esc restores normal category view in renderer after exiting search', () => {
    const state = makeState();
    handleSettingsModalToken(state, { type: 'text', value: '/' });
    for (const ch of 'stream') {
      handleSettingsModalToken(state, { type: 'text', value: ch });
    }
    // Confirm search UI is active
    let lines = renderSettingsModal(modal, W);
    let texts = linesToText(lines).join('\n');
    expect(texts).toContain('Search:');
    // Exit search with Esc
    handleSettingsModalToken(state, { type: 'key', name: 'escape', logicalName: 'escape', ctrl: false, shift: false, meta: false });
    // Re-render: should show category view again
    lines = renderSettingsModal(modal, W);
    texts = linesToText(lines).join('\n');
    expect(texts).not.toContain('Search:');
    expect(texts).toContain('Display');
  });
});
