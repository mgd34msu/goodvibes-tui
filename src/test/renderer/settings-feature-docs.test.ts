/**
 * In-product feature documentation — render tests.
 *
 * The settings workspace must answer "what does this feature do" at every
 * feature row without leaving the product: under the cursor, the FULL
 * behavior description and the feature's real option shape render from the
 * SDK's FEATURE_SETTINGS schema. Long documentation SCROLLS (PgUp/PgDn) with
 * honest more-above/below markers — it is never clipped.
 *
 * These tests render real frames at 80×24 and at 60 columns, reconstruct the
 * documentation pane's complete text by scrolling through it, and assert the
 * COMPLETE description string for every one of the features — full-string
 * assertions, never prefixes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager, ServiceRegistry, SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_SETTINGS, bindFeatureSettingsBridge, deriveFeatureStates } from '@pellux/goodvibes-sdk/platform/runtime/state';
import type { FeatureSetting } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { SettingsModal, SETTINGS_CATEGORIES } from '../../input/settings-modal.ts';
import type { SettingsCategory } from '../../input/settings-modal.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { getFullscreenWorkspaceMetrics } from '../../renderer/fullscreen-workspace.ts';
import { getConfigSchemaSetting } from '../../runtime/feature-settings.ts';
import type { Line } from '../../types/grid.ts';

const HEIGHT = 24;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Whitespace-free comparison space: the pane wraps long atomic tokens
 * (settings keys at 60 columns) mid-token, so full-string containment is
 * asserted with all whitespace removed — the complete text must be present,
 * wrap positions are presentation.
 */
function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

describe('settings workspace — in-product feature documentation', () => {
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-feature-docs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
    cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: tmpDir, homeDir: tmpDir, configDir: join(tmpDir, '.goodvibes', 'global-tui') });
    ffm = createFeatureFlagManager();
    ffm.loadFromConfig({ flags: deriveFeatureStates(cm) });
    bindFeatureSettingsBridge(cm, ffm);
    modal = new SettingsModal();
    const subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    const serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
      subscriptionManager,
    });
    modal.open(cm, ffm, subscriptionManager, serviceRegistry);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Put the cursor on the given feature's header row. */
  function selectFeatureHeader(feature: FeatureSetting): void {
    const categoryIndex = SETTINGS_CATEGORIES.indexOf(feature.domain as SettingsCategory);
    expect(categoryIndex).toBeGreaterThanOrEqual(0);
    modal.categoryIndex = categoryIndex;
    modal.focusSettings();
    const index = modal.currentItems.findIndex((entry) => entry.flag?.feature.id === feature.id);
    expect(index).toBeGreaterThanOrEqual(0);
    modal.selectedIndex = index;
    modal.contextScroll = 0;
  }

  /** Extract the documentation-pane rows (text only) from a rendered frame. */
  function paneRows(lines: Line[], width: number): string[] {
    const metrics = getFullscreenWorkspaceMetrics({ width, height: HEIGHT });
    const centerStart = metrics.leftWidth + 2;
    const rows: string[] = [];
    for (let y = 3; y < 3 + metrics.contextRows; y += 1) {
      const line = lines[y] ?? [];
      rows.push(line.slice(centerStart + 1, centerStart + 1 + metrics.contextWidth).map((c) => c.char).join('').trimEnd());
    }
    return rows;
  }

  /**
   * Reconstruct the COMPLETE documentation text for the selected row by
   * scrolling the pane until the more-below marker disappears, mapping each
   * window back to absolute line positions via the markers themselves.
   */
  function fullDocText(width: number): string {
    const metrics = getFullscreenWorkspaceMetrics({ width, height: HEIGHT });
    const visible = metrics.contextRows;
    const absolute: string[] = [];
    let requested = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      modal.contextScroll = requested;
      const rows = paneRows(renderSettingsModal(modal, width, HEIGHT), width);
      const aboveMatch = rows[0]?.match(/^\S+ (\d+) more line\(s\) above — PgUp$/);
      const offset = aboveMatch ? Number(aboveMatch[1]) : 0;
      const hasBelow = /more line\(s\) below — PgDn$/.test(rows[rows.length - 1] ?? '');
      rows.forEach((row, r) => {
        if (r === 0 && aboveMatch) return;
        if (r === rows.length - 1 && hasBelow) return;
        absolute[offset + r] = row;
      });
      if (!hasBelow) break;
      requested = offset + visible - 2;
    }
    modal.contextScroll = 0;
    return normalize(absolute.filter((row) => row !== undefined).join(' '));
  }

  for (const width of [80, 60]) {
    test(`every feature's COMPLETE description and option shape render under the cursor at ${width} columns`, () => {
      for (const feature of FEATURE_SETTINGS) {
        selectFeatureHeader(feature);
        const text = fullDocText(width);

        // Full-string assertions: the whole name and the whole description.
        expect(squash(text)).toContain(squash(feature.name));
        expect(squash(text)).toContain(squash(feature.description));

        // The real option shape renders from the same schema the writes use.
        const schema = getConfigSchemaSetting(feature.enablement.key);
        if (schema?.type === 'enum') {
          expect(squash(text)).toContain(squash(`Mode choices for ${feature.enablement.key}:`));
          for (const value of schema.enumValues ?? []) {
            expect(squash(text)).toContain(squash(value));
          }
        }
        if (schema?.type === 'boolean') {
          expect(squash(text)).toContain(squash('true: the feature is enabled.'));
          expect(squash(text)).toContain(squash('false: the feature is disabled.'));
        }

        // Every settings key that configures the feature is named.
        if (feature.settings.length > 1) {
          expect(squash(text)).toContain(squash('Settings in this feature:'));
          for (const key of feature.settings) {
            expect(squash(text)).toContain(key);
          }
        }

        // Honest lifecycle line.
        expect(squash(text)).toContain(
          feature.restartRequired
            ? squash('Applies: on next launch (startup-gated)')
            : squash('Applies: immediately'),
        );
      }
    });
  }

  test('a startup-gated change shows the complete pending-restart sentence at the point of change (80×24)', () => {
    const feature = FEATURE_SETTINGS.find((candidate) => candidate.id === 'unified-runtime-task')!;
    selectFeatureHeader(feature);
    modal.toggleSelectedFlag();

    const text = fullDocText(80);
    expect(squash(text)).toContain(squash(
      'Pending restart: saved as enabled; effective state stays disabled until the next launch.',
    ));
    // The row itself carries the honest compact marker too.
    const frame = renderSettingsModal(modal, 80, HEIGHT).map((line) => line.map((c) => c.char).join('')).join('\n');
    expect(frame).toContain('true ⟳');
  });

  test('a capability declared not operable states that, in full, where the user meets it (80×24)', () => {
    // A capability whose platform half ships but whose surface half does not reads
    // as disabled even with its settings key set to true, and the written reason
    // for that MUST render, or the user sees a switch that flipped and a state
    // that did not, with no explanation. The set is empty today — wake-word
    // detection was the last such capability and lost the marker when this
    // terminal started capturing audio — and the loop is what keeps the rule in
    // force for the next one.
    const inoperable = FEATURE_SETTINGS.filter((candidate) => candidate.operable === false);
    for (const feature of inoperable) {
      selectFeatureHeader(feature);
      const text = fullDocText(80);
      expect(squash(text)).toContain(squash('Not available in this build:'));
      expect(squash(text)).toContain(squash(feature.inoperableDetail!));
      expect(squash(text)).toContain(squash('State: disabled'));
    }
  });

  test('a settings sub-row names its owning feature in full (80×24)', () => {
    // sandbox.judgment is owned by sandbox-model-judgment... pick a plain
    // owned sub-row: the first non-header row owned by exec-sandbox.
    const categoryIndex = SETTINGS_CATEGORIES.indexOf('sandbox' as SettingsCategory);
    modal.categoryIndex = categoryIndex;
    modal.focusSettings();
    const index = modal.currentItems.findIndex((entry) => entry.ownerFlagId === 'exec-sandbox' && !entry.flag);
    expect(index).toBeGreaterThanOrEqual(0);
    modal.selectedIndex = index;
    modal.contextScroll = 0;

    const text = fullDocText(80);
    const owner = FEATURE_SETTINGS.find((candidate) => candidate.id === 'exec-sandbox')!;
    expect(squash(text)).toContain(squash(`Part of feature: ${owner.name} (the header row above).`));
    // And the sub-row's own schema description renders in full.
    const selected = modal.getSelected()!;
    expect(squash(text)).toContain(squash(selected.setting.description));
  });
});
