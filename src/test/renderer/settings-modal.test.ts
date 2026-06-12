/**
 * Tests for renderSettingsModal renderer.
 */
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
    const lines = renderSettingsModal(modal, W);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    const lines = renderSettingsModal(modal, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Settings"', () => {
    const lines = renderSettingsModal(modal, W);
    const titleLine = lineToString(lines[0]);
    expect(titleLine).toContain('Settings');
  });

  test('footer contains navigation hints', () => {
    const lines = renderSettingsModal(modal, W);
    const footer = lineToString(lines[lines.length - 2]);
    expect(footer).toContain('Tab');
    expect(footer).toContain('Esc');
  });

  test('category rail and header show the active category count', () => {
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Display (8)');
  });

  test('category rail is grouped and opens with category focus', () => {
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(modal.focusPane).toBe('categories');
    expect(texts).toContain('INTERFACE');
    expect(texts).toContain('AI ROUTING');
    expect(texts).toContain('  ▸ Display (8)');
    const interfaceLine = lines.find(line => lineToString(line).includes('INTERFACE'));
    expect(interfaceLine).toBeDefined();
    const interfaceIndex = lineToString(interfaceLine!).indexOf('INTERFACE');
    expect(interfaceLine![interfaceIndex]?.bold).toBe(true);
  });

  test('settings list shows setting keys', () => {
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    // display category should show stream, lineNumbers, etc.
    expect(texts.toLowerCase()).toMatch(/stream|linenumbers|theme/);
  });

  test('selected item has arrow indicator', () => {
    const lines = renderSettingsModal(modal, W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '▸'));
    expect(hasArrow).toBe(true);
  });

  test('description of selected setting is shown', () => {
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    // The first setting in display is 'display.stream' with description containing 'Stream'
    expect(texts).toMatch(/stream|Stream/);
  });

  test('selected setting surfaces resolved source metadata', () => {
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Source');
  });

  test('selected conflicting setting surfaces conflict provenance', () => {
    const selected = modal.getSelected();
    expect(selected).not.toBeNull();
    selected!.conflict = true;
    modal.groups.set(modal.currentCategory, [selected!]);
    const lines = renderSettingsModal(modal, W, 40);
    const texts = linesToText(lines).join('\n');
    expect(texts.toLowerCase()).toContain('conflict');
  });

  test('selected synced setting surfaces synced provenance', () => {
    const selected = modal.getSelected();
    expect(selected).not.toBeNull();
    selected!.effectiveSource = 'synced';
    modal.groups.set(modal.currentCategory, [selected!]);
    const lines = renderSettingsModal(modal, W, 40);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Source: synced');
  });

  test('footer shows [Enter] Confirm/[Esc] Cancel in editing mode', () => {
    modal.editingMode = true;
    const lines = renderSettingsModal(modal, W);
    const footer = lineToString(lines[lines.length - 2]);
    expect(footer).toContain('Confirm');
    expect(footer).toContain('Cancel');
  });

  test('edit cursor shown when in editing mode', () => {
    modal.editingMode = true;
    modal.editBuffer = 'test';
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    // Block cursor character
    expect(texts).toContain('test\u2588');
  });

  test('changing category shows different settings', () => {
    modal.nextCategory();
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('UI (4)');
  });

  test('mcp category renders server trust editing surface', () => {
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('MCP (1)');
    expect(texts).toContain('docs-server');
    expect(texts).toContain('ask-on-risk');
  });

  test('mcp category renders explicit allow-all confirmation guidance', () => {
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    modal.editingMode = true;
    modal.mcpAllowAllConfirmationTarget = 'docs-server';
    const lines = renderSettingsModal(modal, W);
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
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Subscriptions (1)');
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
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Sign out openai? Enter/y to confirm, n/Esc to cancel.');
  });

  test('works with narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderSettingsModal(modal, narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });
});
