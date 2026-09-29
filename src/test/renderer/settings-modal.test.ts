/**
 * Tests for renderSettingsModal renderer.
 */
import { frameFromLayer } from '../helpers/surface-frame.ts';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsModal } from '../../input/settings-modal.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { lineToString, linesToText } from '../setup.ts';
import { activeTokens } from '../../renderer/theme.ts';

const W = 120;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-settings-renderer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({ surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

describe('renderSettingsModal', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;
  let mcpRegistry: McpRegistry;
  let subscriptionManager: SubscriptionManager;
  let serviceRegistry: ServiceRegistry;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = createConfigManager(tmpDir);
    ffm = createFeatureFlagManager();
    modal = new SettingsModal();
    subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
      subscriptionManager,
    });
    mcpRegistry = {
      listServerSecurity: () => [
        {
          name: 'docs-server',
          connected: true,
          role: 'docs',
          trustMode: 'ask-on-risk',
          allowedPaths: ['/workspace/docs'],
          allowedHosts: [],
          schemaFreshness: 'fresh',
        },
      ],
      setServerTrustMode: () => {},
    } as unknown as McpRegistry;
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'), JSON.stringify({
      version: 1,
      subscriptions: {
        openai: {
          provider: 'openai',
          accessToken: 'token',
          tokenType: 'Bearer',
          authMode: 'oauth',
          overrideAmbientApiKeys: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      pending: {},
    }, null, 2));
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns a non-empty Line[] array', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title row carries the ✦ mark, the title and the breadcrumb', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('✦ Settings › Display');
  });

  test('hint row shows keycap hints and the title row the esc keycap', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain(' tab  pane');
    expect(texts).toMatch(/ esc$/m);
  });

  test('category rail shows the active category count right-aligned', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    // 10 = the SDK's 10 display.* CONFIG_SCHEMA keys (display.themeMode and display.treeGlyphs included).
    expect(texts).toMatch(/Display +10/);
  });

  test('category rail is grouped and opens with category focus', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(modal.focusPane).toBe('categories');
    expect(texts).toContain('✦ interface');
    expect(texts).toContain('✦ ai routing');
    const interfaceLine = lines.find(line => lineToString(line).includes('interface'));
    expect(interfaceLine).toBeDefined();
    const interfaceIndex = lineToString(interfaceLine!).indexOf('interface');
    expect(interfaceLine![interfaceIndex]?.bold).toBe(true);
    // The focused category is the selected (gradient, bold, dark text) row.
    const displayLine = lines.find(line => /Display +10/.test(lineToString(line)))!;
    const displayCell = displayLine[lineToString(displayLine).indexOf('Display')]!;
    expect(displayCell.bold).toBe(true);
    expect(displayCell.fg).toBe(activeTokens().selectedListItemText);
  });

  test('settings list shows setting keys', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    // display category should show stream, lineNumbers, etc.
    expect(texts.toLowerCase()).toMatch(/stream|linenumbers|theme/);
  });

  test('the selected row is drawn as the selected row (bold dark text on the gradient)', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const selectedText = lines.some(line => line.some(cell => cell.bold && cell.fg === activeTokens().selectedListItemText && cell.char.trim() !== ''));
    expect(selectedText).toBe(true);
  });

  test('description of selected setting is shown', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    // The first setting in display is 'display.stream' with description containing 'Stream'
    expect(texts).toMatch(/stream|Stream/);
  });

  test('selected setting surfaces resolved source metadata', () => {
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('source default');
  });

  test('selected conflicting setting surfaces conflict provenance', () => {
    const selected = modal.getSelected();
    expect(selected).not.toBeNull();
    selected!.conflict = true;
    modal.groups.set(modal.currentCategory, [selected!]);
    const lines = frameFromLayer(renderSettingsModal(modal, W, 40), W, 40);
    const texts = linesToText(lines).join('\n');
    expect(texts.toLowerCase()).toContain('conflict');
  });

  test('selected synced setting surfaces synced provenance', () => {
    const selected = modal.getSelected();
    expect(selected).not.toBeNull();
    selected!.effectiveSource = 'synced';
    modal.groups.set(modal.currentCategory, [selected!]);
    const lines = frameFromLayer(renderSettingsModal(modal, W, 40), W, 40);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('source synced');
  });

  test('hint row shows save / cancel edit in editing mode', () => {
    modal.editingMode = true;
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain(' ⏎  save');
    expect(texts).toContain(' esc  cancel edit');
  });

  test('edit cursor shown when in editing mode', () => {
    modal.editingMode = true;
    modal.editBuffer = 'test';
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    // Block cursor character
    expect(texts).toContain('test\u2588');
  });

  test('non-secret string setting still renders its typed value while editing (no regression)', () => {
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();
    modal.focusPane = 'settings';
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.homeassistant.instanceUrl');
    expect(modal.selectedIndex).toBeGreaterThanOrEqual(0);
    modal.editingMode = true;
    modal.editBuffer = 'http://homeassistant.local:8123';
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('http://homeassistant.local:8123\u2588');
  });

  test('secret-backed setting masks the typed value while editing, everywhere it would render', () => {
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();
    modal.focusPane = 'settings';
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.homeassistant.accessToken');
    expect(modal.selectedIndex).toBeGreaterThanOrEqual(0);
    modal.editingMode = true;
    const typed = 'ha-super-secret-long-lived-token';
    modal.editBuffer = typed;
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    // The plaintext must not appear anywhere in the rendered frame: not in the
    // settings table row, not in the "Current: ..." documentation line.
    expect(texts).not.toContain(typed);
    // Keystrokes must still register visibly: a bullet mask with the cursor.
    expect(texts).toContain('\u2022'.repeat(typed.length) + '\u2588');
  });

  test('secret-backed setting search result also masks the typed value while editing', () => {
    modal.setSearchQuery('homeassistant access token');
    const result = modal.searchResults.find((entry) => entry.setting.key === 'surfaces.homeassistant.accessToken');
    expect(result).toBeDefined();
    modal.selectedIndex = modal.searchResults.indexOf(result!);
    modal.editingMode = true;
    const typed = 'another-secret-value';
    modal.editBuffer = typed;
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).not.toContain(typed);
  });

  test('changing category shows different settings', () => {
    modal.nextCategory();
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toMatch(/UI +4/);
  });

  test('mcp category renders server trust editing surface', () => {
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toMatch(/MCP +1/);
    expect(texts).toContain('docs-server');
    expect(texts).toContain('ask-on-risk');
  });

  test('mcp category renders explicit allow-all confirmation guidance', () => {
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    modal.editingMode = true;
    modal.mcpAllowAllConfirmationTarget = 'docs-server';
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('ALLOW ALL docs-server');
  });

  test('subscriptions category renders provider override state', () => {
    while (modal.currentCategory !== 'subscriptions') modal.nextCategory();
    modal.subscriptionEntries = [{
      provider: 'openai',
      state: 'active',
      tokenType: 'Bearer',
      oauthConfigured: true,
    }];
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toMatch(/Subscriptions +1/);
    expect(texts).toContain('openai');
    expect(texts).toContain('active');
    expect(texts).toContain('ambient key ov');
  });

  test('subscriptions category renders explicit logout confirmation guidance when armed', () => {
    while (modal.currentCategory !== 'subscriptions') modal.nextCategory();
    modal.subscriptionEntries = [{
      provider: 'openai',
      state: 'active',
      tokenType: 'Bearer',
      oauthConfigured: true,
    }];
    modal.subscriptionLogoutConfirmationTarget = 'openai';
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Sign out openai? Enter/y to confirm, n/Esc to cancel.');
  });

  test('works with narrow terminal width', () => {
    const narrowW = 60;
    const lines = frameFromLayer(renderSettingsModal(modal, narrowW), narrowW, 24);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });

  test('hint row shows both reset affordances at W=120', () => {
    // Navigate to settings category (has Setting entries, not flags/mcp/subscriptions)
    while (modal.currentCategory !== 'display') modal.nextCategory();
    modal.focusPane = 'settings';
    // W=120 must render both reset affordances in compact form.
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain(' shift+r  reset category');
    expect(texts).toContain(' ctrl+shift+r  reset all');
  });

  test('hint row wraps rather than dropping resets at W=80', () => {
    while (modal.currentCategory !== 'display') modal.nextCategory();
    modal.focusPane = 'settings';
    const lines = frameFromLayer(renderSettingsModal(modal, 80), 80, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain(' shift+r  reset category');
    expect(texts).toContain(' ctrl+shift+r  reset all');
  });

  test('footer shows confirm prompt when resetCategoryConfirm is armed', () => {
    while (modal.currentCategory !== 'display') modal.nextCategory();
    modal.initiateResetCategory();
    expect(modal.resetCategoryConfirm).not.toBeNull();
    // Armed footer is short; W=120 is sufficient.
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain(' ⏎  confirm reset');
    expect(texts).toContain(' esc  cancel');
    // Cleanup
    modal.resetCategoryConfirm = null;
  });

  test('footer shows confirm prompt when resetAllConfirm is armed', () => {
    modal.initiateResetAll();
    expect(modal.resetAllConfirm).not.toBeNull();
    // Armed footer is short; W=120 is sufficient.
    const lines = frameFromLayer(renderSettingsModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain(' ⏎  confirm reset');
    expect(texts).toContain(' esc  cancel');
    // Cleanup
    modal.resetAllConfirm = null;
  });
});
