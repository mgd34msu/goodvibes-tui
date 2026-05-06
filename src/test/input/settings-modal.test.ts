/**
 * Tests for SettingsModal state class.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsModal, SETTINGS_CATEGORIES, SETTINGS_CATEGORY_GROUPS } from '../../input/settings-modal.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../config/secret-config.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';

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
    expect(modal.focusPane).toBe('categories');
    expect(modal.editingMode).toBe(false);
  });

  test('category rail is grouped into a complete non-duplicated navigation order', () => {
    const grouped = SETTINGS_CATEGORY_GROUPS.flatMap(group => group.categories);
    expect(grouped).toEqual(SETTINGS_CATEGORIES);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(SETTINGS_CATEGORY_GROUPS.map(group => group.label)).toEqual([
      'Interface',
      'AI Routing',
      'Service & Network',
      'Surfaces & Cloud',
      'Automation',
      'Runtime & Data',
      'Advanced',
    ]);
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

  test('open() routes every SDK config schema key into the workspace', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const visibleKeys = new Set<string>();
    for (const entries of modal.groups.values()) {
      for (const entry of entries) visibleKeys.add(entry.setting.key);
    }
    const missing = CONFIG_SCHEMA.map((entry) => entry.key).filter((key) => !visibleKeys.has(key));
    expect(missing).toEqual([]);
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

  test('activateSelected delegates TTS LLM settings to the targeted provider-model picker flow', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.categoryIndex = SETTINGS_CATEGORIES.indexOf('display');
    modal.groups.set('display', [
      {
        setting: { key: 'tts.llmProvider', type: 'string', label: 'TTS LLM provider', description: '' } as never,
        currentValue: '',
        isDefault: true,
      },
      {
        setting: { key: 'tts.llmModel', type: 'string', label: 'TTS LLM model', description: '' } as never,
        currentValue: '',
        isDefault: true,
      },
    ]);

    modal.selectedIndex = 0;
    modal.activateSelected();
    expect(modal.pendingProviderModelPickerTarget).toBe('tts');
    expect(modal.pendingModelPickerTarget).toBeNull();

    modal.pendingProviderModelPickerTarget = null;
    modal.selectedIndex = 1;
    modal.activateSelected();
    expect(modal.pendingModelPickerTarget).toBe('tts');
    expect(modal.pendingProviderModelPickerTarget).toBeNull();
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
    while (modal.currentCategory !== 'display') modal.nextCategory();
    const items = modal.currentItems;
    const strIdx = items.findIndex(e => e.setting.key === 'display.theme');
    for (let i = 0; i < strIdx; i++) modal.moveDown();
    modal.activateSelected();
    modal.editBuffer = 'new-model-name';
    const editResult = modal.commitEdit();
    expect(editResult).toBe(true);
    expect(modal.editingMode).toBe(false);
  });

  test('activateSelected delegates main provider/model settings to the shared picker flow', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'provider') modal.nextCategory();

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'provider.model');
    modal.activateSelected();
    expect(modal.pendingProviderModelPickerTarget).toBe('main');
    expect(modal.pendingModelPickerTarget).toBeNull();
  });

  test('activateSelected delegates TTS provider and voice settings to external pickers', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'tts') modal.nextCategory();

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'tts.provider');
    modal.activateSelected();
    expect(modal.pendingSettingsPickerAction).toBe('tts-provider');

    modal.pendingSettingsPickerAction = null;
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'tts.voice');
    modal.activateSelected();
    expect(modal.pendingSettingsPickerAction as 'tts-voice' | null).toBe('tts-voice');
  });

  test('resetSelected restores selected config value to its schema default', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'display') modal.nextCategory();

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'display.stream');
    cm.setDynamic('display.stream', false);
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'display.stream');

    const reset = modal.resetSelected();
    expect(reset).toEqual({ key: 'display.stream', value: true });
    expect(cm.get('display.stream')).toBe(true);
    expect(modal.getSelected()?.currentValue).toBe(true);
  });

  test('surfaces category exposes editable Home Assistant settings', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();

    const keys = modal.currentItems.map((entry) => entry.setting.key);
    expect(keys).toContain('surfaces.homeassistant.enabled');
    expect(keys).toContain('surfaces.homeassistant.instanceUrl');
    expect(keys).toContain('surfaces.homeassistant.accessToken');
    expect(keys).toContain('surfaces.homeassistant.webhookSecret');

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.homeassistant.instanceUrl');
    modal.activateSelected();
    expect(modal.editingMode).toBe(true);
    modal.editBuffer = 'http://homeassistant.local:8123';
    expect(modal.commitEdit()).toBe(true);
    expect(cm.get('surfaces.homeassistant.instanceUrl')).toBe('http://homeassistant.local:8123');
  });

  test('settings modal stores edited Home Assistant secrets through goodvibes secret refs', async () => {
    const secrets = new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm });
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets);
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.homeassistant.accessToken');
    modal.activateSelected();
    modal.editBuffer = 'ha-long-lived-token';
    expect(modal.commitEdit()).toBe(true);

    const secretKey = buildGoodVibesSecretKey('surfaces.homeassistant.accessToken');
    expect(cm.get('surfaces.homeassistant.accessToken')).toBe(buildGoodVibesSecretRef(secretKey));
    expect(await secrets.get(secretKey)).toBe('ha-long-lived-token');
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
    manager.saveSubscription({
      provider: 'openai',
      accessToken: 'token',
      tokenType: 'Bearer',
      authMode: 'oauth',
      overrideAmbientApiKeys: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

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
