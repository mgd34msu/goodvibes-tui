/**
 * Tests for renderSettingsModal renderer.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsModal, SETTINGS_CATEGORIES } from '../../input/settings-modal.ts';
import { ConfigManager } from '../../config/manager.ts';
import { createFeatureFlagManager } from '../../runtime/feature-flags/manager.ts';
import type { FeatureFlagManager } from '../../runtime/feature-flags/manager.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { lineToString, linesToText } from '../setup.ts';

const W = 120;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-settings-renderer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('renderSettingsModal', () => {
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cm = new ConfigManager({ workingDir: tmpDir });
    ffm = createFeatureFlagManager();
    modal = new SettingsModal();
    modal.open(cm, ffm);
  });

  afterEach(() => {
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
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Tab');
    expect(footer).toContain('Esc');
  });

  test('category tabs row shows active category in brackets', () => {
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    const activeCat = SETTINGS_CATEGORIES[0].toUpperCase();
    expect(texts).toContain(`[${activeCat}]`);
  });

  test('settings list shows setting keys', () => {
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    // display category should show stream, lineNumbers, etc.
    expect(texts.toLowerCase()).toMatch(/stream|linenumbers|theme/);
  });

  test('selected item has arrow indicator', () => {
    const lines = renderSettingsModal(modal, W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '\u25b6'));
    expect(hasArrow).toBe(true);
  });

  test('description of selected setting is shown', () => {
    const lines = renderSettingsModal(modal, W);
    const texts = linesToText(lines).join('\n');
    // The first setting in display is 'display.stream' with description containing 'Stream'
    expect(texts).toMatch(/stream|Stream/);
  });

  test('footer shows [Enter] Confirm/[Esc] Cancel in editing mode', () => {
    modal.editingMode = true;
    const lines = renderSettingsModal(modal, W);
    const footer = lineToString(lines[lines.length - 1]);
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
    const activeCat = SETTINGS_CATEGORIES[1].toUpperCase();
    expect(texts).toContain(`[${activeCat}]`);
  });

  test('works with narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderSettingsModal(modal, narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });
});
