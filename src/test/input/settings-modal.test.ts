/**
 * Tests for SettingsModal state class.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsModal, SETTINGS_CATEGORIES } from '../../input/settings-modal.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { createFeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/manager';
import type { FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/manager';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp/registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-settings-modal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SettingsModal', () => {
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
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('starts inactive', () => {
    expect(modal.active).toBe(false);
  });

  test('open() activates modal and loads config groups', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    expect(modal.active).toBe(true);
    expect(modal.categoryIndex).toBe(0);
    expect(modal.selectedIndex).toBe(0);
    expect(modal.editingMode).toBe(false);
  });

  test('open() populates all categories', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    for (const cat of SETTINGS_CATEGORIES) {
      if (cat === 'flags') {
        expect(Array.isArray(modal.flagEntries)).toBe(true);
        continue;
      }
      const items = modal.groups.get(cat);
      expect(items).toBeDefined();
      expect(Array.isArray(items)).toBe(true);
    }
  });

  test('currentCategory returns correct category', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    expect(modal.currentCategory).toBe(SETTINGS_CATEGORIES[0]);
  });

  test('nextCategory cycles through categories', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const initial = modal.categoryIndex;
    modal.nextCategory();
    expect(modal.categoryIndex).toBe((initial + 1) % SETTINGS_CATEGORIES.length);
  });

  test('prevCategory cycles backwards', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.prevCategory();
    expect(modal.categoryIndex).toBe(SETTINGS_CATEGORIES.length - 1);
  });

  test('nextCategory resets selectedIndex to 0', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.moveDown();
    modal.moveDown();
    modal.nextCategory();
    expect(modal.selectedIndex).toBe(0);
  });

  test('moveDown increments selectedIndex', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const before = modal.selectedIndex;
    modal.moveDown();
    expect(modal.selectedIndex).toBe(before + 1);
  });

  test('moveUp wraps around to last item', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.moveUp();
    const len = modal.currentItems.length;
    expect(modal.selectedIndex).toBe(len - 1);
  });

  test('getSelected returns the selected SettingEntry', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const entry = modal.getSelected();
    expect(entry).not.toBeNull();
    expect(entry!.setting).toBeDefined();
    expect(entry!.setting.key).toBeTruthy();
  });

  test('activateSelected toggles boolean setting', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const items = modal.currentItems;
    const boolIdx = items.findIndex((entry) => entry.setting.key === 'display.stream');
    expect(boolIdx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < boolIdx; i++) modal.moveDown();

    const before = modal.getSelected()!.currentValue as boolean;
    modal.activateSelected();
    const afterEntry = modal.getSelected();
    const after = afterEntry?.currentValue as boolean;
    expect(cm.get('display.stream')).toBe(!before);
    expect(after).toBe(!before);
  });

  test('activateSelected enters editingMode for string setting', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
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
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const items = modal.currentItems;
    const strIdx = items.findIndex(e => e.setting.type === 'string');
    for (let i = 0; i < strIdx; i++) modal.moveDown();
    modal.activateSelected();
    const before = modal.editBuffer;
    modal.editChar('x');
    expect(modal.editBuffer).toBe(before + 'x');
  });

  test('editBackspace removes last char', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const items = modal.currentItems;
    const strIdx = items.findIndex(e => e.setting.type === 'string');
    for (let i = 0; i < strIdx; i++) modal.moveDown();
    modal.activateSelected();
    modal.editBuffer = 'hello';
    modal.editBackspace();
    expect(modal.editBuffer).toBe('hell');
  });

  test('cancelEdit exits editingMode without saving', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
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
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
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
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.editingMode = true;
    modal.editBuffer = 'partial';
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.editingMode).toBe(false);
    expect(modal.editBuffer).toBe('');
  });

  test('navigating categories does not change settings in other categories', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.nextCategory();
    const items = modal.currentItems;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.setting.key.startsWith(modal.currentCategory)).toBe(true);
    }
  });

  test('editingMode blocks category and direction navigation', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
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

  test('mcp category loads registered servers', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    expect(modal.mcpEntries.length).toBe(1);
    expect(modal.getSelectedMcp()?.name).toBe('docs-server');
  });

  test('subscriptions category requires confirmation before sign out', () => {
    const manager = subscriptionManager;
    const started = manager.beginOAuthLogin('openai', {
      authUrl: 'https://auth.openai.test/authorize',
      tokenUrl: 'https://auth.openai.test/token',
      clientId: 'openai-client',
      redirectUri: 'http://127.0.0.1/callback',
    });
    manager.saveSubscription({
      provider: 'openai',
      accessToken: 'token',
      tokenType: 'Bearer',
      authMode: 'oauth',
      overrideAmbientApiKeys: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    void started;

    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'subscriptions') modal.nextCategory();
    expect(modal.subscriptionEntries.some((entry) => entry.provider === 'openai' && entry.state === 'active')).toBe(true);

    const openaiIndex = modal.subscriptionEntries.findIndex((entry) => entry.provider === 'openai');
    expect(openaiIndex).toBeGreaterThanOrEqual(0);
    modal.selectedIndex = openaiIndex;
    expect(modal.getSelectedSubscription()?.provider).toBe('openai');
    expect(modal.getSelectedSubscription()?.state).toBe('active');

    modal.activateSelected();
    expect(modal.subscriptionLogoutConfirmationTarget).toBe('openai');
    expect(subscriptionManager.get('openai')).not.toBeNull();

    modal.activateSelected();
    expect(subscriptionManager.get('openai')).toBeNull();
  });

  test('mcp trust mode requires explicit allow-all confirmation', () => {
    let updatedMode: string | null = null;
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
      setServerTrustMode: (_name: string, mode: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked') => {
        updatedMode = mode;
      },
    } as unknown as McpRegistry;

    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    modal.activateSelected();
    expect(modal.editingMode).toBe(true);
    modal.editBuffer = 'allow-all';
    expect(modal.commitEdit()).toBe(false);
    expect(modal.mcpAllowAllConfirmationTarget).toBe('docs-server');
    expect(updatedMode as string | null).toBeNull();
    modal.editBuffer = 'ALLOW ALL docs-server';
    expect(modal.commitEdit()).toBe(true);
    expect(updatedMode as string | null).toBe('allow-all');
  });
});
