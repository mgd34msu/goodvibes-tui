import { describe, test, expect } from 'bun:test';
import { bindPluginsModal, pluginsModalGoldenSurface, type PluginsModalManager } from '../../../panels/modals/plugins-modal.ts';
import { EMPTY_VIEW } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';
import type { PluginStatus } from '@pellux/goodvibes-sdk/platform/plugins';

/** Flatten a ModalConfig's text/list/title content into one searchable string. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

function makePlugin(overrides: Partial<PluginStatus> & { name: string }): PluginStatus {
  return {
    version: '1.0.0',
    description: `${overrides.name} description`,
    enabled: true,
    active: true,
    trustTier: 'trusted',
    quarantined: false,
    ...overrides,
  };
}

function fixedManager(plugins: PluginStatus[], overrides: Partial<PluginsModalManager> = {}): PluginsModalManager {
  return {
    list: () => plugins,
    capabilities: () => null,
    getTrustRecord: () => undefined,
    getQuarantineRecord: () => undefined,
    verify: () => ({ ok: true, valid: true, fingerprint: 'fp-test' }),
    ...overrides,
  };
}

describe('plugins modal builder', () => {
  test('empty roster renders next-step guidance and no rows', () => {
    const surface = bindPluginsModal({ pluginManager: fixedManager([]) });
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('No plugins discovered.');
    expect(text).toContain('/plugin list');
    expect(text).toContain('/marketplace');
    expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(0);
  });

  test('populated roster lists plugins with posture summary and selected detail', () => {
    const plugins = [
      makePlugin({ name: 'formatter', trustTier: 'trusted', active: true }),
      makePlugin({ name: 'risky-tool', trustTier: 'untrusted', active: false, enabled: false, quarantined: true }),
    ];
    const surface = bindPluginsModal({ pluginManager: fixedManager(plugins) });
    surface.refresh();
    const config = surface.buildConfig(EMPTY_VIEW);
    const text = configText(config);
    expect(text).toContain('formatter');
    expect(text).toContain('risky-tool');
    expect(text).toContain('plugins 2');
    expect(text).toContain('quarantined 1');
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['formatter', 'risky-tool']);
  });

  test('quarantine-only hints (lift quarantine, capture to memory) appear only when selection is quarantined', () => {
    const plugins = [makePlugin({ name: 'risky-tool', quarantined: true, active: false, enabled: false })];
    const surface = bindPluginsModal({ pluginManager: fixedManager(plugins) });
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('q lift quarantine');
    expect(text).toContain('m capture to memory');
  });

  test('enable/disable/lift-quarantine route to the /plugin command path (no modal-ized confirm)', () => {
    const plugins = [
      makePlugin({ name: 'formatter', active: false, enabled: false }),
      makePlugin({ name: 'risky-tool', quarantined: true, active: false, enabled: false }),
    ];
    const surface = bindPluginsModal({ pluginManager: fixedManager(plugins) });
    surface.refresh();

    // formatter is selectedIndex 0 by default.
    expect(surface.actions.enable!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/plugin enable formatter' });
    // disable is a no-op on an already-disabled plugin.
    expect(surface.actions.disable!(EMPTY_VIEW)).toEqual({ kind: 'none' });

    const secondRow = { ...EMPTY_VIEW, selectedIndex: 1 };
    expect(surface.actions.liftQuarantine!(secondRow)).toEqual({ kind: 'runCommand', command: '/plugin quarantine risky-tool lift' });
    expect(surface.actions.captureToMemory!(secondRow)).toEqual({ kind: 'runCommand', command: '/recall capture plugin risky-tool' });
    // Not quarantined: lift-quarantine/capture are no-ops on row 0.
    expect(surface.actions.liftQuarantine!(EMPTY_VIEW)).toEqual({ kind: 'none' });
    expect(surface.actions.captureToMemory!(EMPTY_VIEW)).toEqual({ kind: 'none' });
  });

  test('verify is a read-only in-modal action (never routes to a command)', () => {
    let verifyCalls = 0;
    const plugins = [makePlugin({ name: 'formatter' })];
    const surface = bindPluginsModal({
      pluginManager: fixedManager(plugins, {
        verify: (name) => {
          verifyCalls += 1;
          return { ok: true, valid: false, reason: `${name} signature mismatch` };
        },
      }),
    });
    surface.refresh();
    const outcome = surface.actions.verify!(EMPTY_VIEW);
    expect(outcome).toEqual({ kind: 'none' });
    expect(verifyCalls).toBe(1);
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('INVALID');
    expect(text).toContain('formatter signature mismatch');
  });

  test('refresh action requests a re-render (refresh() itself is a no-op over live reads)', () => {
    const surface = bindPluginsModal({ pluginManager: fixedManager([makePlugin({ name: 'formatter' })]) });
    surface.refresh();
    expect(surface.actions.refresh!(EMPTY_VIEW)).toEqual({ kind: 'refresh' });
  });

  test('golden surface renders deterministically with quarantine hints present', () => {
    const surface = pluginsModalGoldenSurface();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('formatter');
    expect(text).toContain('risky-tool');
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['formatter', 'risky-tool']);
  });
});
