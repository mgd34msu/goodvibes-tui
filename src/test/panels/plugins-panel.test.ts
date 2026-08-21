import { describe, expect, test } from 'bun:test';
import { PluginsPanel, type PluginManagerControls } from '../../panels/plugins-panel.ts';
import type { PluginStatus } from '@pellux/goodvibes-sdk/platform/plugins';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { PanelIntegrationContext } from '../../panels/types.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeManager(statuses: PluginStatus[], overrides: Partial<PluginManagerControls> = {}): PluginManagerControls {
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
    enable: async (_name: string) => ({ ok: false, error: 'not wired in this fixture' }),
    disable: async (_name: string) => ({ ok: false, error: 'not wired in this fixture' }),
    verify: (_name: string) => ({ ok: false, valid: false, reason: 'not wired in this fixture' }),
    liftQuarantine: (_name: string) => ({ ok: false, error: 'not wired in this fixture' }),
    ...overrides,
  };
}

function makeExecuteCommandCtx(): { ctx: PanelIntegrationContext; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  const ctx = {
    panelManager: {},
    executeCommand: async (name: string, args: string[]) => {
      calls.push([name, args]);
      return undefined;
    },
  } as unknown as PanelIntegrationContext;
  return { ctx, calls };
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

  // e=enable, d=disable (confirm), v=verify, q=lift quarantine (confirm),
  // m=capture quarantined plugin to memory, and selection preserved across onActivate.
  describe('control-room actions', () => {
    const alpha: PluginStatus = {
      name: 'alpha-plugin',
      version: '1.0.0',
      description: 'Alpha plugin',
      enabled: false,
      active: false,
      trustTier: 'limited',
      quarantined: false,
    };
    const beta: PluginStatus = {
      name: 'beta-plugin',
      version: '2.0.0',
      description: 'Beta plugin',
      enabled: true,
      active: false,
      trustTier: 'untrusted',
      quarantined: true,
    };

    test('e enables the selected plugin via manager.enable', async () => {
      const calls: string[] = [];
      const panel = new PluginsPanel(makeManager([alpha, beta], {
        enable: async (name: string) => { calls.push(name); return { ok: true }; },
      }));
      panel.render(120, 16);
      panel.handleInput('e');
      await Promise.resolve();
      expect(calls).toEqual(['alpha-plugin']);
    });

    test('e surfaces an error when enable fails', async () => {
      const panel = new PluginsPanel(makeManager([alpha], {
        enable: async (_name: string) => ({ ok: false, error: 'already enabled' }),
      }));
      panel.render(120, 16);
      panel.handleInput('e');
      await Promise.resolve();
      const text = linesText(panel.render(120, 16));
      expect(text).toContain('already enabled');
    });

    test('d requests confirmation, then disables on y', async () => {
      const calls: string[] = [];
      const panel = new PluginsPanel(makeManager([alpha], {
        disable: async (name: string) => { calls.push(name); return { ok: true }; },
      }));
      panel.render(120, 16);
      panel.handleInput('d');
      const confirmText = linesText(panel.render(120, 16));
      expect(confirmText).toContain('Disable');
      expect(confirmText).toContain('alpha-plugin');
      expect(calls).toEqual([]);

      panel.handleInput('y');
      await Promise.resolve();
      expect(calls).toEqual(['alpha-plugin']);
    });

    test('d confirmation cancels on n without disabling', () => {
      const calls: string[] = [];
      const panel = new PluginsPanel(makeManager([alpha], {
        disable: async (name: string) => { calls.push(name); return { ok: true }; },
      }));
      panel.render(120, 16);
      panel.handleInput('d');
      panel.handleInput('n');
      expect(calls).toEqual([]);
    });

    test('v verifies the selected plugin and renders the result', () => {
      const panel = new PluginsPanel(makeManager([alpha], {
        verify: (_name: string) => ({ ok: true, valid: true, fingerprint: 'abc123' }),
      }));
      panel.render(120, 16);
      panel.handleInput('v');
      const text = linesText(panel.render(120, 16));
      expect(text).toContain('Verify:');
      expect(text).toContain('VALID');
      expect(text).toContain('abc123');
    });

    test('q requests confirmation, then lifts quarantine on y', () => {
      const calls: string[] = [];
      const panel = new PluginsPanel(makeManager([beta], {
        liftQuarantine: (name: string) => { calls.push(name); return { ok: true }; },
      }));
      panel.render(120, 16);
      panel.handleInput('q');
      const confirmText = linesText(panel.render(120, 16));
      expect(confirmText).toContain('quarantine');
      expect(calls).toEqual([]);

      panel.handleInput('y');
      expect(calls).toEqual(['beta-plugin']);
    });

    test('q is a no-op on a non-quarantined plugin', () => {
      const calls: string[] = [];
      const panel = new PluginsPanel(makeManager([alpha], {
        liftQuarantine: (name: string) => { calls.push(name); return { ok: true }; },
      }));
      panel.render(120, 16);
      const consumed = panel.handleInput('q');
      expect(consumed).toBe(false);
      expect(calls).toEqual([]);
    });

    test('m dispatches /recall capture plugin for a quarantined selection via handlePanelIntegrationAction', async () => {
      const panel = new PluginsPanel(makeManager([beta]));
      panel.render(120, 16);
      const consumed = panel.handleInput('m');
      expect(consumed).toBe(true);

      const { ctx, calls } = makeExecuteCommandCtx();
      const integrationConsumed = panel.handlePanelIntegrationAction!('m', ctx);
      expect(integrationConsumed).toBe(true);
      await Promise.resolve();
      expect(calls).toEqual([['recall', ['capture', 'plugin', 'beta-plugin']]]);
    });

    test('m is a no-op on a non-quarantined selection', () => {
      const panel = new PluginsPanel(makeManager([alpha]));
      panel.render(120, 16);
      expect(panel.handleInput('m')).toBe(false);

      const { ctx, calls } = makeExecuteCommandCtx();
      expect(panel.handlePanelIntegrationAction!('m', ctx)).toBe(false);
      expect(calls).toEqual([]);
    });

    test('selection is preserved across onActivate', () => {
      const panel = new PluginsPanel(makeManager([alpha, beta]));
      panel.render(120, 16);
      panel.handleInput('down');
      const beforeText = linesText(panel.render(120, 16));
      expect(beforeText).toContain('beta-plugin');

      panel.onActivate();
      const afterText = linesText(panel.render(120, 16));
      expect(afterText).toContain('beta-plugin');
    });

    test('zero signposts: no /plugin act hint in the footer', () => {
      const panel = new PluginsPanel(makeManager([alpha]));
      const text = linesText(panel.render(120, 16));
      expect(text).not.toContain('/plugin');
    });
  });
});
