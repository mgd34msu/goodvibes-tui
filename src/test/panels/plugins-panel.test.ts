import { describe, expect, test } from 'bun:test';
import { PluginsPanel } from '../../panels/plugins-panel.ts';
import type { PluginManagerObserver, PluginStatus } from '@pellux/goodvibes-sdk/platform/plugins';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeManager(statuses: PluginStatus[]): PluginManagerObserver {
  return {
    subscribe: () => () => {},
    list: () => statuses,
    capabilities: (name: string) => {
      if (name !== 'alpha-plugin') return null;
      return {
        ok: true,
        requested: ['register.tool', 'shell.exec'],
        highRisk: ['shell.exec'],
        safe: ['register.tool'],
        tier: 'limited',
        blocked: ['shell.exec'],
      };
    },
    getTrustRecord: (name: string) => (
      name === 'alpha-plugin'
        ? {
            pluginName: 'alpha-plugin',
            tier: 'limited',
            updatedAt: Date.now(),
            grantedBy: 'operator',
            note: 'reviewed',
          }
        : undefined
    ),
    getQuarantineRecord: (name: string) => (
      name === 'beta-plugin'
        ? {
            pluginName: 'beta-plugin',
            revokedCapabilities: ['shell.exec'],
            reason: 'blocked after suspicious behavior',
            quarantinedAt: Date.now(),
            lifted: false,
          }
        : undefined
    ),
  };
}

describe('PluginsPanel', () => {
  test('renders empty guidance when no plugins are discovered', () => {
    const panel = new PluginsPanel(makeManager([]));
    const text = linesText(panel.render(100, 12));
    expect(text).toContain('No plugins discovered');
  });

  test('renders plugin trust, capability, and quarantine details', () => {
    const panel = new PluginsPanel(makeManager([
      {
        name: 'alpha-plugin',
        version: '1.0.0',
        description: 'Alpha plugin',
        enabled: true,
        active: true,
        trustTier: 'limited',
        quarantined: false,
      },
      {
        name: 'beta-plugin',
        version: '2.0.0',
        description: 'Beta plugin',
        enabled: true,
        active: false,
        trustTier: 'untrusted',
        quarantined: true,
      },
    ]));

    const text = linesText(panel.render(120, 16));
    expect(text).toContain('Plugin Control Room');
    expect(text).toContain('alpha-plugin');
    expect(text).toContain('Capabilities:');
    expect(text).toContain('High-risk:');
    // Provenance/error posture header surfaces trust + quarantine pressure first.
    expect(text).toContain('quarantined');
    expect(text).toContain('untrusted');

    panel.handleInput('down');
    const secondText = linesText(panel.render(120, 16));
    expect(secondText).toContain('beta-plugin');
    expect(secondText).toContain('Quarantine:');
    expect(secondText).toContain('blocked after suspicious behavior');
    // No signature fingerprint on record -> unsigned provenance is surfaced.
    expect(secondText).toContain('unsigned');
  });
});
